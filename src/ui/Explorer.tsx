import { useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from './types';
import { I, iconFor } from './icons';
import { VirtualList, VirtualListHandle } from './views/VirtualList';

interface Row { n: TreeNode; depth: number; open: boolean; hasKids: boolean }

function hl(label: string, q: string) {
  if (!q) return label;
  const i = label.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return label;
  return <>{label.slice(0, i)}<mark>{label.slice(i, i + q.length)}</mark>{label.slice(i + q.length)}</>;
}

export function Explorer({ tree, activeId, onOpen, onContext }: { tree: TreeNode[]; activeId?: string; onOpen: (n: TreeNode, e: React.MouseEvent | React.KeyboardEvent) => void; onContext?: (n: TreeNode, e: React.MouseEvent) => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(['grp:Forms', 'grp:Modules', 'grp:Classes', 'grp:User Controls']));
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | undefined>();
  const list = useRef<VirtualListHandle>(null);
  const parents = useMemo(() => {
    const m = new Map<string, string>();
    const walk = (ns: TreeNode[], p?: string) => ns.forEach(n => { if (p) m.set(n.id, p); if (n.children) walk(n.children, n.id); });
    walk(tree);
    return m;
  }, [tree]);
  // reveal the active node
  useEffect(() => {
    if (!activeId || q) return;
    const add: string[] = [];
    let p = parents.get(activeId);
    while (p) { add.push(p); p = parents.get(p); }
    if (add.some(a => !open.has(a))) setOpen(o => new Set([...o, ...add]));
    setSel(activeId);
  }, [activeId]); // eslint-disable-line
  const rows = useMemo(() => {
    const out: Row[] = [];
    const ql = q.trim().toLowerCase();
    const matches = (n: TreeNode): boolean => n.label.toLowerCase().includes(ql) || (n.detail ?? '').toLowerCase().includes(ql) || !!n.children?.some(matches);
    const walk = (ns: TreeNode[], depth: number) => {
      for (const n of ns) {
        if (ql && !matches(n)) continue;
        const hasKids = !!n.children?.length;
        const isOpen = ql ? hasKids && n.children!.some(matches) && depth < 6 : open.has(n.id);
        out.push({ n, depth, open: isOpen, hasKids });
        if (hasKids && isOpen) walk(n.children!, depth + 1);
        if (out.length > 20000) return;
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, open, q]);
  useEffect(() => {
    if (!sel) return;
    const i = rows.findIndex(r => r.n.id === sel);
    if (i >= 0) list.current?.scrollToIndex(i, false);
  }, [sel, rows]);
  const toggle = (id: string) => setOpen(o => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selIdx = rows.findIndex(r => r.n.id === sel);
  return (
    <>
      <div className="filter">
        <I.search size={14} color="#7f8aa0" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter project" data-testid="tree-filter"
          onKeyDown={e => { if (e.key === 'Escape') setQ(''); if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.closest('.panel')?.querySelector('.tree') as HTMLElement)?.focus(); if (rows[0]) setSel(rows[0].n.id); } }} />
        {q && <span style={{ cursor: 'pointer', color: 'var(--muted)' }} onClick={() => setQ('')}><I.x size={13} /></span>}
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {rows.length === 0 && <div className="tree-empty" data-testid="tree-empty">No matches for “{q.trim()}”<br /><span className="faint">Tip: Ctrl+K also searches strings, controls and addresses</span></div>}
        <VirtualList ref={list} className="tree" count={rows.length} rowHeight={24} testId="tree"
          onKeyDown={e => {
            if (selIdx < 0) return;
            const r = rows[selIdx];
            if (e.key === 'ArrowDown') { e.preventDefault(); if (rows[selIdx + 1]) setSel(rows[selIdx + 1].n.id); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows[selIdx - 1]) setSel(rows[selIdx - 1].n.id); }
            else if (e.key === 'ArrowRight' && r.hasKids && !r.open) toggle(r.n.id);
            else if (e.key === 'ArrowLeft') { if (r.hasKids && r.open) toggle(r.n.id); else { const p = parents.get(r.n.id); if (p) setSel(p); } }
            else if (e.key === 'Enter') { onOpen(r.n, e); if (r.hasKids && !r.n.obj && r.n.obj !== 0) toggle(r.n.id); }
          }}
          render={(i, top) => {
            const { n, depth, open: isOpen, hasKids } = rows[i];
            return (
              <div key={n.id} className={'tree-row' + (n.id === activeId ? ' active' : '') + (n.id === sel && n.id !== activeId ? ' sel' : '')} style={{ position: 'absolute', top, left: 0, right: 0, paddingLeft: 6 + depth * 14 }}
                data-id={n.id}
                onClick={e => { setSel(n.id); if (hasKids && (n.kind === 'folder' || n.kind === 'controls' || n.kind === 'control' || (e.target as HTMLElement).closest('.twisty'))) toggle(n.id); if (!(e.target as HTMLElement).closest('.twisty')) onOpen(n, e); }}
                onContextMenu={e => { e.preventDefault(); setSel(n.id); onContext?.(n, e); }}>
                <span className={'twisty' + (isOpen ? ' open' : '')}>{hasKids && <I.chevron size={12} />}</span>
                <span className="ico">{iconFor(n.kind, 15)}</span>
                <span className="lbl">{hl(n.label, q.trim())}</span>
                {n.detail && <span className="detail">{n.detail === '~' ? '' : n.detail}</span>}
                {n.badge && <span className="badge">{n.badge}</span>}
              </div>
            );
          }} />
      </div>
    </>
  );
}
