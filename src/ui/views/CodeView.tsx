import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeDoc } from '../types';
import { tokenizeVB } from './vbsyntax';
import { VirtualList, VirtualListHandle } from './VirtualList';
import { FindBar, useFind } from './FindBar';

const hx = (v: number) => v.toString(16).toUpperCase().padStart(6, '0');

export interface CodeViewProps {
  doc: CodeDoc;
  resolve: (name: string) => number | undefined;
  onNavigate: (va: number, newTab?: boolean) => void;
  cursorVA?: number;
  onCursor?: (va: number) => void;
  onContext?: (e: React.MouseEvent, info: { va?: number; word?: string; line: string }) => void;
  onPeek?: (va: number | undefined, x: number, y: number) => void;
  focusVA?: number;
  testId?: string;
}

interface RLine { text: string; va?: number; indent: number; kind?: string; no: number }

export function CodeView({ doc, resolve, onNavigate, cursorVA, onCursor, onContext, onPeek, focusVA, testId }: CodeViewProps) {
  const list = useRef<VirtualListHandle>(null);
  const [word, setWord] = useState<string | undefined>();
  const lines: RLine[] = useMemo(() => {
    const out: RLine[] = [];
    let no = 1;
    if (doc.header) out.push({ text: doc.header, indent: 0, va: doc.va, kind: 'header', no: no++ });
    for (const l of doc.lines) out.push({ ...l, indent: l.kind === 'label' ? 0 : l.indent, no: no++ });
    if (doc.footer) out.push({ text: doc.footer, indent: 0, kind: 'header', no: no++ });
    return out;
  }, [doc]);
  const texts = useMemo(() => lines.map(l => '    '.repeat(Math.max(0, l.indent)) + l.text), [lines]);
  const find = useFind(texts, i => list.current?.scrollToIndex(i), () => setTimeout(() => list.current?.el()?.focus({ preventScroll: true }), 0));
  // the line to highlight for the cursor address: last line whose va <= cursor
  const curIdx = useMemo(() => {
    if (cursorVA === undefined) return -1;
    let best = -1, bestVa = -1;
    lines.forEach((l, i) => { if (l.va !== undefined && l.va <= cursorVA && l.va > bestVa) { best = i; bestVa = l.va; } });
    return best;
  }, [lines, cursorVA]);
  const [flash, setFlash] = useState(-1);
  useEffect(() => {
    if (focusVA === undefined) return;
    let best = -1, bestVa = -1;
    lines.forEach((l, i) => { if (l.va !== undefined && l.va <= focusVA && l.va > bestVa) { best = i; bestVa = l.va; } });
    if (best >= 0) { list.current?.scrollToIndex(best); setFlash(best); const t = setTimeout(() => setFlash(-1), 1300); return () => clearTimeout(t); }
  }, [focusVA, lines]);
  const toks = useMemo(() => new Map<number, ReturnType<typeof tokenizeVB>>(), [lines, resolve]);
  const tokOf = (i: number) => { let t = toks.get(i); if (!t) { t = tokenizeVB(lines[i].text, resolve); toks.set(i, t); } return t; };

  return (
    <VirtualList ref={list} className="code" count={lines.length} rowHeight={20} testId={testId}
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); find.open(); }
        if (e.key === 'Escape') find.close();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const ix = Math.max(0, Math.min(lines.length - 1, (curIdx < 0 ? 0 : curIdx) + (e.key === 'ArrowDown' ? 1 : -1)));
          for (let k = ix; k >= 0 && k < lines.length; k += e.key === 'ArrowDown' ? 1 : -1) { const va = lines[k].va; if (va !== undefined && va !== cursorVA) { onCursor?.(va); list.current?.scrollToIndex(k, false); break; } }
        }
      }}
      render={(i, top) => {
        const l = lines[i];
        const tk = tokOf(i);
        const cls = 'cl' + (i === curIdx ? ' cur' : '') + (i === flash ? ' flash' : '') + (l.kind === 'label' ? ' lbl' : '') + (l.kind === 'header' ? ' hdr' : '');
        const hits = find.query ? find.matchSet.has(i) : false;
        return (
          <div key={i} className={cls} style={{ top }}
            onClick={() => { if (l.va !== undefined) onCursor?.(l.va); }}
            onContextMenu={e => { e.preventDefault(); onContext?.(e, { va: l.va, word, line: l.text }); }}>
            <span className="gut">{l.no}</span>
            <span className={'addr' + (l.va !== undefined ? ' click' : '')} title="Show in disassembly" onClick={e => { if (l.va !== undefined) { e.stopPropagation(); onCursor?.(l.va); } }}>{l.va !== undefined && (l.kind !== 'comment') ? hx(l.va) : ''}</span>
            <span className="src">
              {'    '.repeat(Math.max(0, l.indent))}
              {tk.map((t, k) => {
                const classes = [`t-${t.c === 'id' ? 'var' : t.c === 'ws' ? 'p' : t.c}`];
                if (t.nav !== undefined) classes.push('t-link');
                if (word && t.t === word && t.c !== 'ws') classes.push('t-word');
                if (hits && find.query && t.t.toLowerCase().includes(find.query.toLowerCase())) classes.push('t-hl');
                return (
                  <span key={k} className={classes.join(' ')}
                    onClick={e => {
                      if (t.nav !== undefined && (e.ctrlKey || e.metaKey || e.button === 0)) { e.stopPropagation(); onNavigate(t.nav, e.ctrlKey || e.metaKey); return; }
                      if (t.c === 'id' || t.c === 'fn') setWord(w => (w === t.t ? undefined : t.t));
                    }}
                    onMouseEnter={e => { if (t.nav !== undefined) onPeek?.(t.nav, e.clientX, e.clientY); }}
                    onMouseLeave={() => { if (t.nav !== undefined) onPeek?.(undefined, 0, 0); }}
                  >{t.t}</span>
                );
              })}
            </span>
          </div>
        );
      }}>
      {find.visible && <FindBar find={find} />}
    </VirtualList>
  );
}
