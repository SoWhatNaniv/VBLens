import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SearchResult } from './types';
import { rpc } from './rpc';
import { I, iconFor } from './icons';

/** Remember what had focus when an overlay opened and give it back when it closes. */
export function useRestoreFocus() {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { if (prev && document.contains(prev)) setTimeout(() => prev.focus({ preventScroll: true }), 0); };
  }, []);
}

export interface Command { id: string; label: string; hint?: string; run: () => void }

export function Palette({ onClose, onPick, commands, onGrep, initial = '' }: { onClose: () => void; onPick: (r: SearchResult) => void; commands: Command[]; onGrep: (q: string) => void; initial?: string }) {
  useRestoreFocus();
  const [q, setQ] = useState(initial);
  const [res, setRes] = useState<SearchResult[]>([]);
  const [resQ, setResQ] = useState('');
  const [sel, setSel] = useState(0);
  const pendingEnter = useRef(false);
  const inp = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { inp.current?.focus(); }, []);
  const isCmd = q.startsWith('>');
  useEffect(() => {
    if (isCmd || !q.trim()) { setRes([]); return; }
    let live = true;
    const t = setTimeout(() => rpc.call<SearchResult[]>('search', [q.trim(), 80]).then(r => { if (live) { setRes(r); setResQ(q); setSel(0); } }), 90);
    return () => { live = false; clearTimeout(t); };
  }, [q, isCmd]);
  const cq = q.slice(1).trim().toLowerCase();
  const cmds = isCmd || !q ? commands.filter(c => c.label.toLowerCase().includes(cq)) : [];
  type Item = { kind: 'cmd'; c: Command } | { kind: 'res'; r: SearchResult } | { kind: 'grep' };
  const items: Item[] = [...cmds.map(c => ({ kind: 'cmd' as const, c })), ...res.map(r => ({ kind: 'res' as const, r })), ...(!isCmd && q.trim().length >= 2 ? [{ kind: 'grep' as const }] : [])];
  const run = (it: Item) => {
    onClose();
    if (it.kind === 'cmd') it.c.run();
    else if (it.kind === 'res') onPick(it.r);
    else onGrep(q.trim());
  };
  useLayoutEffect(() => { box.current?.querySelector('.pitem.on')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  // Enter pressed before the results for the typed text arrived: open the best match when they do
  useEffect(() => { if (pendingEnter.current && resQ === q && items[0]) { pendingEnter.current = false; run(items[0]); } }); // eslint-disable-line
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()} data-testid="palette">
        <input ref={inp} value={q} placeholder="Search procedures, forms, controls, strings, addresses…   (type > for commands)" onChange={e => { setQ(e.target.value); setSel(0); }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') { if (!isCmd && q.trim() && resQ !== q) pendingEnter.current = true; else if (items[sel]) run(items[sel]); }
          }} />
        <div className="res" ref={box}>
          {items.map((it, i) => (
            <div key={i} className={'pitem' + (i === sel ? ' on' : '')} onMouseMove={() => { if (sel !== i) setSel(i); }} onClick={() => run(it)}>
              {it.kind === 'cmd' ? <><I.bolt size={15} color="#b7a5ff" /><span className="pk">command</span><span className="pl">{it.c.label}</span>{it.c.hint && <kbd>{it.c.hint}</kbd>}</>
                : it.kind === 'grep' ? <><I.search size={15} color="#22d3ee" /><span className="pk">code</span><span className="pl">Search decompiled code for “{q.trim()}”</span><kbd>Ctrl+Shift+F</kbd></>
                  : <>{iconFor(it.r.kind)}<span className="pk">{it.r.kind}</span><span className="pl">{it.r.label}</span><span className="pd">{it.r.detail}</span></>}
            </div>
          ))}
          {!items.length && q && <div className="muted" style={{ padding: 14 }}>No matches</div>}
        </div>
        <div className="hint"><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span><span style={{ marginLeft: 'auto' }}>Tip: paste an address like 401A2C</span></div>
      </div>
    </div>
  );
}

export function Prompt({ title, initial, placeholder, onSubmit, onClose, hint, validate }: { title: string; initial?: string; placeholder?: string; onSubmit: (v: string) => void; onClose: () => void; hint?: string; validate?: (v: string) => string | undefined }) {
  useRestoreFocus();
  const [v, setV] = useState(initial ?? '');
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const err = touched && validate ? validate(v) : undefined;
  const submit = () => {
    const e = validate?.(v);
    if (e) { setTouched(true); ref.current?.focus(); return; }
    onSubmit(v); onClose();
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={e => e.stopPropagation()} data-testid="prompt">
        <h3>{title}</h3>
        <input ref={ref} value={v} placeholder={placeholder} className={err ? 'invalid' : undefined} spellCheck={false}
          onChange={e => { setV(e.target.value); setTouched(true); }}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }} />
        {err ? <div className="field-err" data-testid="prompt-error">{err}</div> : hint && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{hint}</div>}
        <div className="row">
          <button className="btn sm ghost" onClick={onClose}>Cancel</button>
          <button className="btn sm primary" disabled={!!err} onClick={submit}>OK</button>
        </div>
      </div>
    </div>
  );
}

export interface XrefItem { from: number; kind: string; name: string }
export function XrefsDialog({ title, items, onNavigate, onClose }: { title: string; items?: XrefItem[]; onNavigate: (va: number) => void; onClose: () => void }) {
  useRestoreFocus();
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { listRef.current?.querySelector('.pitem.on')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()} tabIndex={-1} data-testid="xrefs" ref={el => el?.focus()}
        onKeyDown={e => {
          if (e.key === 'Escape') onClose();
          if (!items) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
          if (e.key === 'Enter' && items[sel]) { onClose(); onNavigate(items[sel].from); }
        }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>Cross references to {title} <span className="muted" style={{ fontWeight: 400 }}>· {items?.length ?? '…'}</span></div>
        <div className="res" ref={listRef}>
          {!items && <div className="muted" style={{ padding: 14 }}>Loading…</div>}
          {items?.length === 0 && <div className="muted" style={{ padding: 14 }}>No references found.</div>}
          {items?.map((x, i) => (
            <div key={i} className={'pitem' + (i === sel ? ' on' : '')} onMouseMove={() => { if (sel !== i) setSel(i); }} onClick={() => { onClose(); onNavigate(x.from); }}>
              <span className="pd" style={{ width: 70 }}>{x.from.toString(16).toUpperCase()}</span>
              <span className="pk" style={{ width: 40 }}>{x.kind}</span>
              <span className="pl">{x.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface MenuItem { label: string; icon?: React.ReactNode; key?: string; run: () => void; sep?: boolean }
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [hi, setHi] = useState(-1);
  const hiRef = useRef(hi); hiRef.current = hi;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({ x: Math.min(x, window.innerWidth - el.offsetWidth - 8), y: Math.min(y, window.innerHeight - el.offsetHeight - 8) });
  }, [x, y]);
  useEffect(() => {
    const h = () => onClose();
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      // keyboard navigation inside the menu
      const real = items.map((it, i) => (it.sep ? -1 : i)).filter(i => i >= 0);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setHi(h => { const p = real.indexOf(h); const n = e.key === 'ArrowDown' ? (p + 1) % real.length : (p - 1 + real.length) % real.length; return real[n < 0 ? 0 : n]; });
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const it = items[hiRef.current];
        if (it && !it.sep) { onClose(); it.run(); }
      }
    };
    window.addEventListener('mousedown', h);
    window.addEventListener('blur', h);
    window.addEventListener('resize', h);
    window.addEventListener('wheel', h, { capture: true, passive: true });
    window.addEventListener('keydown', k, true);
    return () => {
      window.removeEventListener('mousedown', h); window.removeEventListener('blur', h); window.removeEventListener('resize', h);
      window.removeEventListener('wheel', h, { capture: true } as EventListenerOptions); window.removeEventListener('keydown', k, true);
    };
  }, [onClose, items]);
  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} onMouseDown={e => e.stopPropagation()} data-testid="ctxmenu">
      {items.map((it, i) => it.sep ? <hr key={i} /> : (
        <div key={i} className={i === hi ? 'on' : undefined} onMouseMove={() => hi !== i && setHi(i)} onClick={() => { onClose(); it.run(); }}>{it.icon}{it.label}{it.key && <kbd>{it.key}</kbd>}</div>
      ))}
    </div>
  );
}

export interface PeekData { title: string; kind: string; lines: string[] }
/** Wrap string literals so right-to-left text inside them cannot reorder the code around it. */
export function bidiSafe(line: string): React.ReactNode {
  if (!/[\u0590-\u08ff]/.test(line)) return line;
  const parts = line.split(/("(?:[^"]|"")*")/);
  return parts.map((p, i) => (i % 2 ? <bdi key={i}>{p}</bdi> : p));
}

export function Peek({ x, y, data }: { x: number; y: number; data: PeekData }) {
  const left = Math.max(8, Math.min(x + 14, window.innerWidth - 540));
  const top = Math.max(8, y + 18 + 300 > window.innerHeight ? y - 310 : y + 18);
  return (
    <div className="peek" style={{ left, top }}>
      <div className="ph">{iconFor(data.kind, 13)}<b>{data.title}</b><span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>{data.kind}</span></div>
      <pre>{data.lines.map((l, i) => <div key={i}>{bidiSafe(l) || ' '}</div>)}</pre>
    </div>
  );
}

export function Toast({ msg, err, onDone }: { msg: string; err?: boolean; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, err ? 5000 : 2600); return () => clearTimeout(t); }, [msg, err, onDone]);
  return <div className={'toast' + (err ? ' err' : '')} data-testid="toast">{err ? <I.shield size={15} color="#ff6b7a" /> : <I.bolt size={15} color="#3ddc97" />}{msg}</div>;
}
