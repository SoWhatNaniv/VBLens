import { useEffect, useMemo, useRef, useState } from 'react';
import { I } from '../icons';

export function useFind(texts: string[], reveal: (i: number) => void, onClosed?: () => void) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [cur, setCur] = useState(0);
  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const q = query.toLowerCase();
    const out: number[] = [];
    texts.forEach((t, i) => { if (t.toLowerCase().includes(q)) out.push(i); });
    return out;
  }, [texts, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  useEffect(() => { setCur(0); if (matches.length) reveal(matches[0]); }, [matches]); // eslint-disable-line
  return {
    visible, query: visible ? query : '', matches, matchSet, cur,
    open: () => setVisible(true),
    close: () => { setVisible(false); onClosed?.(); },
    setQuery,
    next: (d: number) => {
      if (!matches.length) return;
      const n = (cur + d + matches.length) % matches.length;
      setCur(n);
      reveal(matches[n]);
    },
  };
}

export function FindBar({ find }: { find: ReturnType<typeof useFind> }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div className="findbar" onClick={e => e.stopPropagation()}>
      <I.search size={14} />
      <input ref={ref} value={find.query} placeholder="Find in view" onChange={e => find.setQuery(e.target.value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') find.next(e.shiftKey ? -1 : 1); if (e.key === 'Escape') find.close(); }} />
      <span>{find.matches.length ? `${find.cur + 1} / ${find.matches.length}` : find.query ? 'no results' : ''}</span>
      <button className="btn sm icon ghost" onClick={() => find.next(-1)} title="Previous (Shift+Enter)"><I.back size={14} /></button>
      <button className="btn sm icon ghost" onClick={() => find.next(1)} title="Next (Enter)"><I.fwd size={14} /></button>
      <button className="btn sm icon ghost" onClick={() => find.close()} title="Close (Esc)"><I.x size={14} /></button>
    </div>
  );
}
