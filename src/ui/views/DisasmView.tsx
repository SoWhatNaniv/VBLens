import { useEffect, useMemo, useRef, useState } from 'react';
import type { DisasmRow } from '../types';
import { VirtualList, VirtualListHandle } from './VirtualList';
import { FindBar, useFind } from './FindBar';

const hx = (v: number) => v.toString(16).toUpperCase().padStart(8, '0');

export interface DisasmProps {
  rows: DisasmRow[];
  cursorVA?: number;
  onCursor?: (va: number) => void;
  onNavigate: (va: number, newTab?: boolean) => void;
  onContext?: (e: React.MouseEvent, info: { va: number; target?: number }) => void;
  onPeek?: (va: number | undefined, x: number, y: number) => void;
  focusVA?: number;
  comments?: Map<number, string>;
  showBytes?: boolean;
}

export function DisasmView({ rows, cursorVA, onCursor, onNavigate, onContext, onPeek, focusVA, showBytes = true }: DisasmProps) {
  const list = useRef<VirtualListHandle>(null);
  // flatten: label lines become extra rows
  const flat = useMemo(() => {
    const out: { kind: 'label' | 'insn' | 'gap'; row: DisasmRow; text?: string }[] = [];
    rows.forEach((r, i) => {
      if (r.blockStart && i > 0) out.push({ kind: 'gap', row: r });
      if (r.label) out.push({ kind: 'label', row: r, text: r.label });
      out.push({ kind: 'insn', row: r });
    });
    return out;
  }, [rows]);
  const texts = useMemo(() => flat.map(f => (f.kind === 'insn' ? f.row.toks.map(t => t.t).join('') + ' ' + (f.row.comment ?? '') : f.text ?? '')), [flat]);
  const find = useFind(texts, i => list.current?.scrollToIndex(i), () => setTimeout(() => list.current?.el()?.focus({ preventScroll: true }), 0));
  const idxOf = useMemo(() => { const m = new Map<number, number>(); flat.forEach((f, i) => { if (f.kind === 'insn') m.set(f.row.va, i); }); return m; }, [flat]);
  const [word, setWord] = useState<string | undefined>();
  const [flash, setFlash] = useState(-1);
  useEffect(() => {
    if (focusVA === undefined) return;
    let i = idxOf.get(focusVA);
    if (i === undefined) { // nearest preceding instruction
      let best = -1, bv = -1;
      for (const [va, ix] of idxOf) if (va <= focusVA && va > bv) { bv = va; best = ix; }
      i = best;
    }
    if (i !== undefined && i >= 0) { list.current?.scrollToIndex(i); setFlash(i); const t = setTimeout(() => setFlash(-1), 1300); return () => clearTimeout(t); }
  }, [focusVA, idxOf]);
  const cur = cursorVA !== undefined ? idxOf.get(cursorVA) ?? -1 : -1;
  useEffect(() => { if (cur >= 0) list.current?.scrollToIndex(cur, false); }, [cur]);

  return (
    <VirtualList ref={list} className="code" count={flat.length} rowHeight={20} testId="disasm"
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); find.open(); }
        if (e.key === 'Escape') find.close();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          let k = cur < 0 ? 0 : cur;
          const d = e.key === 'ArrowDown' ? 1 : -1;
          for (k += d; k >= 0 && k < flat.length; k += d) if (flat[k].kind === 'insn') { onCursor?.(flat[k].row.va); break; }
        }
        if (e.key === 'Enter' && cur >= 0) {
          const t = flat[cur].row.toks.find(t => t.a !== undefined);
          if (t?.a !== undefined) onNavigate(t.a);
        }
      }}
      render={(i, top) => {
        const f = flat[i];
        if (f.kind === 'gap') return <div key={i} className="cl" style={{ top }} />;
        if (f.kind === 'label') return (
          <div key={i} className="cl lbl" style={{ top }}>
            <span className="addr">{hx(f.row.va)}</span>
            <span className="src"><span className="lblname">{f.text}:</span></span>
          </div>
        );
        const r = f.row;
        const hit = find.query && find.matchSet.has(i);
        return (
          <div key={i} className={'cl' + (i === cur ? ' cur' : '') + (i === flash ? ' flash' : '')} style={{ top }}
            onClick={() => onCursor?.(r.va)}
            onContextMenu={e => { e.preventDefault(); onContext?.(e, { va: r.va, target: r.toks.find(t => t.a !== undefined)?.a }); }}>
            <span className="addr">{hx(r.va)}</span>
            {showBytes && <span className="bytes">{r.bytes}</span>}
            <span className="src">
              {r.toks.map((t, k) => {
                const cls = ['t-' + (t.k === 'kw' ? 'ty' : t.k)];
                if (t.a !== undefined) cls.push('t-link');
                if (t.k === 'mn') cls.push('t-mn');
                if (word && t.t === word) cls.push('t-word');
                if (hit && t.t.toLowerCase().includes(find.query.toLowerCase())) cls.push('t-hl');
                const style = t.k === 'mn' ? { display: 'inline-block', minWidth: k === 0 ? 70 : undefined } : undefined;
                return (
                  <span key={k} className={cls.join(' ')} style={style}
                    onClick={e => {
                      if (t.a !== undefined) { e.stopPropagation(); onNavigate(t.a, e.ctrlKey || e.metaKey); return; }
                      if (t.k === 'reg' || t.k === 'num') setWord(w => (w === t.t ? undefined : t.t));
                    }}
                    onMouseEnter={e => { if (t.a !== undefined) onPeek?.(t.a, e.clientX, e.clientY); }}
                    onMouseLeave={() => { if (t.a !== undefined) onPeek?.(undefined, 0, 0); }}
                  >{t.t}</span>
                );
              })}
              {r.comment && <span className="cmt">; {r.comment}</span>}
            </span>
          </div>
        );
      }}>
      {find.visible && <FindBar find={find} />}
    </VirtualList>
  );
}
