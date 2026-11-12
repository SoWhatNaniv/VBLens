import { useEffect, useMemo, useRef, useState } from 'react';
import { VirtualList, VirtualListHandle } from './VirtualList';
import { I } from '../icons';
import { copyText } from '../util';

export interface Col<T> { key: string; title: string; width?: number | string; get: (r: T) => string | number; render?: (r: T) => React.ReactNode; mono?: boolean; align?: 'right' }

const hx = (v: number) => v.toString(16).toUpperCase().padStart(8, '0');
export { hx as hex8 };

export function DataTable<T>({ rows, cols, onRow, onContext, placeholder, focusKey, rowKey, testId, extra, openHint }: {
  rows: T[]; cols: Col<T>[]; onRow?: (r: T, e?: React.MouseEvent | React.KeyboardEvent) => void; onContext?: (r: T, e: React.MouseEvent) => void; openHint?: string;
  placeholder?: string; focusKey?: string | number; rowKey: (r: T) => string | number; testId?: string; extra?: React.ReactNode;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ k: string; d: 1 | -1 } | undefined>();
  const list = useRef<VirtualListHandle>(null);
  const filtered = useMemo(() => {
    let r = rows;
    if (q) {
      const ql = q.toLowerCase();
      r = r.filter(x => cols.some(c => String(c.get(x)).toLowerCase().includes(ql)));
    }
    if (sort) {
      const c = cols.find(c => c.key === sort.k)!;
      r = [...r].sort((a, b) => { const x = c.get(a), y = c.get(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.d; });
    }
    return r;
  }, [rows, q, sort, cols]);
  const [sel, setSel] = useState<string | number | undefined>(focusKey);
  const selIdx = filtered.findIndex(r => rowKey(r) === sel);
  const move = (i: number) => {
    if (!filtered.length) return;
    const n = Math.max(0, Math.min(filtered.length - 1, i));
    setSel(rowKey(filtered[n]));
    list.current?.scrollToIndex(n, false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const page = Math.max(1, Math.floor((list.current?.el()?.clientHeight ?? 260) / 26) - 1);
    const k = e.key;
    if (k === 'ArrowDown') move(selIdx + 1);
    else if (k === 'ArrowUp') move(selIdx - 1);
    else if (k === 'PageDown') move(selIdx + page);
    else if (k === 'PageUp') move(selIdx - page);
    else if (k === 'Home') move(0);
    else if (k === 'End') move(filtered.length - 1);
    else if (k === 'Enter' && selIdx >= 0) onRow?.(filtered[selIdx], e);
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'c' && selIdx >= 0) {
      const r = filtered[selIdx];
      copyText(cols.map(c => String(c.get(r))).join('\t'));
    } else return;
    e.preventDefault(); e.stopPropagation();
  };
  useEffect(() => {
    if (focusKey === undefined) return;
    const i = filtered.findIndex(r => rowKey(r) === focusKey);
    if (i >= 0) { setSel(focusKey); setTimeout(() => list.current?.scrollToIndex(i), 30); }
  }, [focusKey]); // eslint-disable-line
  const grid = cols.map(c => (typeof c.width === 'number' ? c.width + 'px' : c.width ?? '1fr')).join(' ');
  return (
    <div className="tbl-wrap" data-testid={testId}>
      <div className="tbl-tools">
        <div className="filter" style={{ margin: 0, flex: 1, maxWidth: 420 }}>
          <I.search size={14} color="#7f8aa0" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder ?? 'Filter'} data-testid="table-filter"
            onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); list.current?.el()?.focus(); if (selIdx < 0) move(0); } if (e.key === 'Escape') setQ(''); }} />
          {q && <span className="muted" style={{ cursor: 'pointer' }} onClick={() => setQ('')}><I.x size={13} /></span>}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{filtered.length.toLocaleString()} of {rows.length.toLocaleString()}</span>
        {openHint && <span className="faint" style={{ fontSize: 11.5 }}>{openHint}</span>}
        <div className="spacer" />
        {extra}
      </div>
      <div className="tbl-head" style={{ display: 'grid', gridTemplateColumns: grid }}>
        {cols.map(c => (
          <span key={c.key} style={{ cursor: 'pointer', textAlign: c.align }} onClick={() => setSort(s => (s?.k === c.key ? (s.d === 1 ? { k: c.key, d: -1 } : undefined) : { k: c.key, d: 1 }))}>
            {c.title}{sort?.k === c.key ? (sort.d === 1 ? ' ▲' : ' ▼') : ''}
          </span>
        ))}
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {filtered.length === 0 && <div className="tree-empty">{rows.length ? 'No rows match the filter' : 'Nothing here'}</div>}
        <VirtualList ref={list} className="tbl-body" count={filtered.length} rowHeight={26} onKeyDown={onKey}
          render={(i, top) => {
            const r = filtered[i];
            const k = rowKey(r);
            return (
              <div key={k} className={'tbl-row' + (k === sel ? ' on' : '')} style={{ top, display: 'grid', gridTemplateColumns: grid }}
                onClick={() => setSel(k)}
                onDoubleClick={e => { setSel(k); onRow?.(r, e); }}
                onContextMenu={e => { e.preventDefault(); setSel(k); onContext?.(r, e); }}>
                {cols.map(c => <span key={c.key} className={c.mono ? 'mono' : undefined} style={{ textAlign: c.align, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.render ? c.render(r) : c.get(r)}</span>)}
              </div>
            );
          }} />
      </div>
    </div>
  );
}

export interface GrepHit { va: number; func: string; text: string; fva: number }
export function GrepView({ query, hits, onOpen, loading }: { query: string; hits?: GrepHit[]; onOpen: (fva: number, va: number) => void; loading: boolean }) {
  return (
    <div className="grep-res" data-testid="grep">
      <div style={{ padding: '6px 14px 10px', fontFamily: 'var(--sans)', color: 'var(--muted)' }}>
        {loading ? <span><span className="spinner sm" /> Decompiling every procedure and searching for “{query}”…</span>
          : <span><b style={{ color: 'var(--text)' }}>{hits?.length ?? 0}</b> matches for “{query}” in decompiled code{hits && hits.length >= 500 ? ' (first 500)' : ''}</span>}
      </div>
      {hits?.map((h, i) => {
        const ix = h.text.toLowerCase().indexOf(query.toLowerCase());
        return (
          <div key={i} className="g" onClick={() => onOpen(h.fva, h.va)}>
            <span className="f">{h.func}</span>
            <span className="faint">{h.va.toString(16).toUpperCase()}</span>
            <span>{ix < 0 ? h.text : <>{h.text.slice(0, ix)}<mark>{h.text.slice(ix, ix + query.length)}</mark>{h.text.slice(ix + query.length)}</>}</span>
          </div>
        );
      })}
    </div>
  );
}
