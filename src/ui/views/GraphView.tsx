import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphData } from '../types';
import { I } from '../icons';

const CH = 7.1; // monospace char width at 11.5px (JetBrains Mono)
const RH = 17;
const hx = (v: number) => v.toString(16).toUpperCase();

interface LNode { id: number; x: number; y: number; w: number; h: number; layer: number; order: number; lines: string[]; rowsVA: number[] }

function layout(g: GraphData) {
  const nodes = new Map<number, LNode>();
  for (const n of g.nodes) {
    const lines = n.rows.map(r => r.toks.map(t => t.t).join('') + (r.comment ? `  ; ${r.comment}` : ''));
    const px = (r: GraphData['nodes'][number]['rows'][number]) => {
      const [mn, ...rest] = r.toks;
      const restLen = rest.reduce((a, t) => a + t.t.length, 0);
      const cm = r.comment ? Math.min(40, r.comment.length) + 5 : 0;
      return Math.max(62, (mn?.t.length ?? 0) * CH) + (restLen + cm) * CH + 30;
    };
    const w = Math.min(640, Math.max(150, ...n.rows.map(px)));
    nodes.set(n.id, { id: n.id, x: 0, y: 0, w, h: 24 + lines.length * RH + 10, layer: 0, order: 0, lines, rowsVA: n.rows.map(r => r.va) });
  }
  const succ = new Map<number, number[]>(), pred = new Map<number, number[]>();
  for (const e of g.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    (succ.get(e.from) ?? succ.set(e.from, []).get(e.from)!).push(e.to);
    (pred.get(e.to) ?? pred.set(e.to, []).get(e.to)!).push(e.from);
  }
  // DFS for back edges
  const back = new Set<string>();
  const state = new Map<number, number>();
  const order: number[] = [];
  const roots = [g.entry, ...[...nodes.keys()].filter(k => !(pred.get(k)?.length))];
  for (const r of roots) {
    if (!nodes.has(r) || state.has(r)) continue;
    const stack: [number, number][] = [[r, 0]];
    state.set(r, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const ss = succ.get(top[0]) ?? [];
      if (top[1] < ss.length) {
        const s = ss[top[1]++];
        const st = state.get(s);
        if (st === 1) back.add(`${top[0]}>${s}`);
        else if (!st) { state.set(s, 1); stack.push([s, 0]); }
      } else { state.set(top[0], 2); order.push(top[0]); stack.pop(); }
    }
  }
  for (const k of nodes.keys()) if (!state.has(k)) order.push(k);
  order.reverse();
  // longest path layering on the DAG
  for (const id of order) {
    const n = nodes.get(id)!;
    for (const p of pred.get(id) ?? []) if (!back.has(`${p}>${id}`)) n.layer = Math.max(n.layer, nodes.get(p)!.layer + 1);
  }
  const layers: LNode[][] = [];
  for (const id of order) { const n = nodes.get(id)!; (layers[n.layer] ??= []).push(n); }
  layers.forEach(l => l.forEach((n, i) => (n.order = i)));
  // barycenter sweeps
  for (let it = 0; it < 6; it++) {
    for (let li = 1; li < layers.length; li++) {
      const L = layers[li];
      if (!L) continue;
      const bc = (n: LNode) => { const ps = (pred.get(n.id) ?? []).filter(p => !back.has(`${p}>${n.id}`)).map(p => nodes.get(p)!.order); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : n.order; };
      L.sort((a, b) => bc(a) - bc(b));
      L.forEach((n, i) => (n.order = i));
    }
  }
  // coordinates
  const GX = 46, GY = 64;
  let y = 0;
  for (const L of layers) {
    if (!L) continue;
    const total = L.reduce((a, n) => a + n.w, 0) + GX * (L.length - 1);
    let x = -total / 2;
    for (const n of L) { n.x = x; n.y = y; x += n.w + GX; }
    y += Math.max(...L.map(n => n.h)) + GY;
  }
  // relaxation: pull nodes toward the centre of their predecessors, keeping order
  for (let it = 0; it < 8; it++) {
    for (const L of layers) {
      if (!L) continue;
      for (const n of L) {
        const ps = (pred.get(n.id) ?? []).filter(p => !back.has(`${p}>${n.id}`)).map(p => nodes.get(p)!);
        if (!ps.length) continue;
        const target = ps.reduce((a, p) => a + p.x + p.w / 2, 0) / ps.length - n.w / 2;
        n.x += (target - n.x) * 0.5;
      }
      L.sort((a, b) => a.x - b.x);
      for (let i = 1; i < L.length; i++) { const p = L[i - 1]; if (L[i].x < p.x + p.w + GX) L[i].x = p.x + p.w + GX; }
    }
  }
  const minX = Math.min(...[...nodes.values()].map(n => n.x)) - 60;
  for (const n of nodes.values()) n.x -= minX;
  const W = Math.max(...[...nodes.values()].map(n => n.x + n.w)) + 120;
  const H = Math.max(...[...nodes.values()].map(n => n.y + n.h)) + 80;
  return { nodes, back, W, H };
}

export function GraphView({ graph, onNavigate, onCursor, cursorVA }: { graph: GraphData; onNavigate: (va: number) => void; onCursor?: (va: number) => void; cursorVA?: number }) {
  const L = useMemo(() => layout(graph), [graph]);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 40, y: 30, k: 1 });
  const [drag, setDrag] = useState<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const fit = () => {
    const el = host.current;
    if (!el) return;
    const k = Math.min(1, (el.clientWidth - 60) / L.W, (el.clientHeight - 60) / L.H);
    setView({ k: Math.max(0.15, k), x: (el.clientWidth - L.W * Math.max(0.15, k)) / 2, y: 24 });
  };
  const inited = useRef<typeof L | null>(null);
  useEffect(() => {
    // start at the entry block, readable zoom — once the view has a size (it may be
    // created inside a hidden tab)
    const el = host.current;
    if (!el) return;
    const init = () => {
      if (inited.current === L || !el.clientWidth || !el.clientHeight) return;
      inited.current = L;
      const entry = L.nodes.get(graph.entry);
      if (L.W < el.clientWidth && L.H < el.clientHeight) fit();
      else if (entry) setView({ k: 0.9, x: el.clientWidth / 2 - (entry.x + entry.w / 2) * 0.9, y: 30 });
    };
    init();
    const ro = new ResizeObserver(init);
    ro.observe(el);
    return () => ro.disconnect();
  }, [L]); // eslint-disable-line
  // wheel: scroll pans, Ctrl/⌘+wheel (and trackpad pinch) zooms around the pointer.
  // Registered natively because React's wheel listener is passive (can't stop page zoom).
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * scale * 0.0025);
        setView(v => { const k2 = Math.min(2.5, Math.max(0.08, v.k * f)); return { k: k2, x: mx - (mx - v.x) * (k2 / v.k), y: my - (my - v.y) * (k2 / v.k) }; });
      } else if (e.shiftKey && !e.deltaX) setView(v => ({ ...v, x: v.x - e.deltaY * scale }));
      else setView(v => ({ ...v, x: v.x - e.deltaX * scale, y: v.y - e.deltaY * scale }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const zoomBy = (f: number) => {
    const el = host.current;
    const cx = (el?.clientWidth ?? 0) / 2, cy = (el?.clientHeight ?? 0) / 2;
    setView(v => { const k2 = Math.min(2.5, Math.max(0.08, v.k * f)); return { k: k2, x: cx - (cx - v.x) * (k2 / v.k), y: cy - (cy - v.y) * (k2 / v.k) }; });
  };
  const selBlock = useMemo(() => {
    if (cursorVA === undefined) return -1;
    for (const n of L.nodes.values()) if (n.rowsVA.includes(cursorVA)) return n.id;
    return -1;
  }, [cursorVA, L]);
  useEffect(() => {
    // keep the selected block visible
    const el = host.current; const n = L.nodes.get(selBlock);
    if (!el || !n) return;
    const sx = n.x * view.k + view.x, sy = n.y * view.k + view.y;
    if (sx < 0 || sy < 0 || sx > el.clientWidth - 40 || sy > el.clientHeight - 40) setView(v => ({ ...v, x: el.clientWidth / 2 - (n.x + n.w / 2) * v.k, y: el.clientHeight / 3 - n.y * v.k }));
  }, [selBlock]); // eslint-disable-line

  const edges = useMemo(() => {
    const out: { d: string; color: string; key: string; dash?: boolean }[] = [];
    const outCount = new Map<number, number>();
    for (const e of graph.edges) {
      const a = L.nodes.get(e.from), b = L.nodes.get(e.to);
      if (!a || !b) continue;
      const idx = outCount.get(e.from) ?? 0;
      outCount.set(e.from, idx + 1);
      const color = e.kind === 'true' ? '#3ddc97' : e.kind === 'false' ? '#ff6b7a' : '#7cb5ff';
      const x1 = a.x + a.w / 2 + (idx ? 14 : -14) * (graph.edges.filter(x => x.from === e.from).length > 1 ? 1 : 0);
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2, y2 = b.y - 6;
      let d: string;
      if (L.back.has(`${e.from}>${e.to}`) || b.y <= a.y) {
        const rx = Math.max(a.x + a.w, b.x + b.w) + 30 + idx * 10;
        d = `M${x1},${y1} C${x1},${y1 + 40} ${rx},${y1 + 40} ${rx},${(y1 + y2) / 2} S${x2},${y2 - 50} ${x2},${y2}`;
      } else {
        const my = (y1 + y2) / 2;
        d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
      }
      out.push({ d, color, key: `${e.from}-${e.to}-${idx}`, dash: e.kind === 'fall' });
    }
    return out;
  }, [graph, L]);

  return (
    <div ref={host} className={'graph' + (drag ? ' drag' : '')} data-testid="graph" tabIndex={0}
      title="Drag or scroll to pan · Ctrl+wheel to zoom · double-click a block to open it"
      onKeyDown={e => {
        const step = e.shiftKey ? 240 : 60;
        const k = e.key;
        if (k === 'ArrowLeft') setView(v => ({ ...v, x: v.x + step }));
        else if (k === 'ArrowRight') setView(v => ({ ...v, x: v.x - step }));
        else if (k === 'ArrowUp') setView(v => ({ ...v, y: v.y + step }));
        else if (k === 'ArrowDown') setView(v => ({ ...v, y: v.y - step }));
        else if (k === '+' || k === '=') zoomBy(1.2);
        else if (k === '-' || k === '_') zoomBy(1 / 1.2);
        else if (k === '0') fit();
        else return;
        e.preventDefault(); e.stopPropagation();
      }}
      onPointerDown={e => {
        if (e.button !== 0 && e.button !== 1) return;
        if ((e.target as HTMLElement).closest('.gnode, .zoomctl, .minimap')) return;
        e.preventDefault();
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        (e.currentTarget as HTMLDivElement).focus({ preventScroll: true });
        setDrag({ x: e.clientX, y: e.clientY, vx: view.x, vy: view.y });
      }}
      onPointerMove={e => { if (drag) setView(v => ({ ...v, x: drag.vx + e.clientX - drag.x, y: drag.vy + e.clientY - drag.y })); }}
      onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}>
      <div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`, transformOrigin: '0 0', width: L.W, height: L.H }}>
        <svg className="edges" width={L.W} height={L.H}>
          <defs>
            {['#3ddc97', '#ff6b7a', '#7cb5ff'].map(c => (
              <marker key={c} id={'arr' + c.slice(1)} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={c} /></marker>
            ))}
          </defs>
          {edges.map(e => <path key={e.key} d={e.d} stroke={e.color} strokeWidth={1.6} fill="none" opacity={0.85} strokeDasharray={e.dash ? '5 4' : undefined} markerEnd={`url(#arr${e.color.slice(1)})`} />)}
        </svg>
        {[...L.nodes.values()].map(n => (
          <div key={n.id} className={'gnode' + (n.id === graph.entry ? ' entry' : '') + (n.id === selBlock ? ' sel' : '')} style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
            onMouseDown={e => e.stopPropagation()}
            onClick={() => onCursor?.(n.id)}
            onDoubleClick={() => onNavigate(n.id)}>
            <div className="ghead"><span>loc_{hx(n.id)}</span><span>{n.lines.length} insn</span></div>
            <div className="gbody">
              {graph.nodes.find(x => x.id === n.id)!.rows.map(r => (
                <div key={r.va} style={{ background: r.va === cursorVA ? 'rgba(139,108,255,.18)' : undefined }} onClick={e => { e.stopPropagation(); onCursor?.(r.va); }}>
                  {r.toks.map((t, k) => (
                    <span key={k} className={'t-' + (t.k === 'kw' ? 'ty' : t.k) + (t.a !== undefined ? ' t-link' : '')} style={t.k === 'mn' && k === 0 ? { display: 'inline-block', minWidth: 62 } : undefined}
                      onClick={e => { if (t.a !== undefined) { e.stopPropagation(); onNavigate(t.a); } }}>{t.t}</span>
                  ))}
                  {r.comment && <span className="t-cm">  ; {r.comment.length > 40 ? r.comment.slice(0, 40) + '…' : r.comment}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="zoomctl" onMouseDown={e => e.stopPropagation()}>
        <button className="btn sm icon" title="Zoom in (+ / Ctrl+wheel)" onClick={() => zoomBy(1.2)}><I.zoomIn size={15} /></button>
        <button className="btn sm icon" title="Zoom out (-)" onClick={() => zoomBy(1 / 1.2)}><I.zoomOut size={15} /></button>
        <button className="btn sm icon" title="Fit to view (0)" onClick={fit}><I.fit size={15} /></button>
      </div>
      <Minimap L={L} view={view} host={host.current} onJump={(x, y) => setView(v => ({ ...v, x, y }))} />
    </div>
  );
}

function Minimap({ L, view, host, onJump }: { L: ReturnType<typeof layout>; view: { x: number; y: number; k: number }; host: HTMLDivElement | null; onJump: (x: number, y: number) => void }) {
  const W = 180, H = 140;
  const s = Math.min(W / L.W, H / L.H);
  const vw = host ? host.clientWidth / view.k : 0, vh = host ? host.clientHeight / view.k : 0;
  const vx = -view.x / view.k, vy = -view.y / view.k;
  return (
    <div className="minimap" onMouseDown={e => {
      e.stopPropagation();
      const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const gx = (e.clientX - r.left) / s, gy = (e.clientY - r.top) / s;
      onJump(-(gx - vw / 2) * view.k, -(gy - vh / 2) * view.k);
    }}>
      <svg width={W} height={H}>
        {[...L.nodes.values()].map(n => <rect key={n.id} x={n.x * s} y={n.y * s} width={Math.max(2, n.w * s)} height={Math.max(2, n.h * s)} fill="#2a3550" rx={1} />)}
        <rect x={vx * s} y={vy * s} width={vw * s} height={vh * s} fill="rgba(139,108,255,.12)" stroke="#8b6cff" strokeWidth={1} />
      </svg>
    </div>
  );
}
