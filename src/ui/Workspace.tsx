import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Loaded } from './App';
import type { CodeDoc, DisasmRow, FormControlView, FormView, FuncInfo, GraphData, SearchResult, Tab, TreeNode } from './types';
import { rpc, useRpc, invalidateCache } from './rpc';
import { saveTypeLib, clearTypeLibs } from './tlbstore';
import { I, Logo, iconFor } from './icons';
import { Explorer } from './Explorer';
import { CodeView } from './views/CodeView';
import { DisasmView } from './views/DisasmView';
import { GraphView } from './views/GraphView';
import { HexView, Section } from './views/HexView';
import { OverviewView } from './views/Overview';
import { DataTable, GrepView, GrepHit, hex8 } from './views/Tables';
import { FormDesigner, findControl } from './views/FormDesigner';
import { ProcInspector, ControlInspector, FileInspector } from './Inspector';
import { copyText, store, vbIdentifierError } from './util';
import { Palette, Prompt, XrefsDialog, XrefItem, ContextMenu, MenuItem, Peek, PeekData, Toast, Command } from './Overlays';
import { getLiveState, isDesktop, isLive, onLive, openSettings, reportView, setFollow, useLiveState, userBusy, type LiveActivity, type LiveChange, type LiveTarget } from './live';

const hx = (v: number) => v.toString(16).toUpperCase().padStart(8, '0');
type Dialog =
  | { kind: 'palette'; initial?: string }
  | { kind: 'prompt'; title: string; initial?: string; placeholder?: string; hint?: string; submit: (v: string) => void; validate?: (v: string) => string | undefined }
  | { kind: 'xrefs'; title: string; items?: XrefItem[] };

const MAX_TABS = 14;
const SINGLE: Record<string, { title: string; kind: Tab['kind'] }> = {
  overview: { title: 'Overview', kind: 'overview' }, strings: { title: 'Strings', kind: 'strings' }, imports: { title: 'Imports', kind: 'imports' },
  declares: { title: 'API Declares', kind: 'declares' }, components: { title: 'References', kind: 'components' }, hex: { title: 'Hex view', kind: 'hex' },
};

export function Workspace({ data, onOpen, onClose, onSwitch, initialShow, onShown }: {
  data: Loaded; onOpen: (f: File) => void; onClose: () => void;
  /** live mode: show another file open on the MCP server */
  onSwitch?: (file: string) => void;
  /** live mode: where to go once loaded (the agent's activity or a "show" request) */
  initialShow?: LiveTarget | LiveActivity; onShown?: () => void;
}) {
  const ov = data.overview;
  const fileId = data.fileId;
  const [tree, setTree] = useState<TreeNode[]>(data.tree);
  const [gen, setGen] = useState(0);
  const [tabs, setTabs] = useState<Tab[]>([{ id: 'overview', kind: 'overview', title: 'Overview' }]);
  const [activeId, setActiveId] = useState('overview');
  const [dialog, setDialog] = useState<Dialog | undefined>();
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | undefined>();
  const [peek, setPeek] = useState<{ x: number; y: number; data: PeekData } | undefined>();
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | undefined>();
  const [showRight, setShowRight] = useState(() => store.get('vblens.ui.inspector', true) && window.innerWidth >= 1150);
  const [widths, setWidths] = useState(() => store.get('vblens.ui.widths', { left: 300, right: 330 }));
  const [vw, setVw] = useState(window.innerWidth);
  useEffect(() => { store.set('vblens.ui.widths', widths); }, [widths]);
  useEffect(() => {
    // narrow windows: drop the inspector first, then shrink the explorer
    let wasWide = window.innerWidth >= 1150;
    const onResize = () => {
      setVw(window.innerWidth);
      const wide = window.innerWidth >= 1150;
      if (wide !== wasWide) { setShowRight(wide && store.get('vblens.ui.inspector', true)); wasWide = wide; }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const toggleRight = () => setShowRight(s => { store.set('vblens.ui.inspector', !s); return !s; });
  const leftW = Math.min(widths.left, Math.max(180, Math.floor(vw * 0.32)));
  const rightW = Math.min(widths.right, Math.max(220, Math.floor(vw * 0.3)));
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const tlbInput = useRef<HTMLInputElement>(null);
  const hist = useRef<{ stack: { id: string; va?: number }[]; pos: number }>({ stack: [{ id: 'overview' }], pos: 0 });
  const [, setHistVer] = useState(0);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const active = tabs.find(t => t.id === activeId) ?? tabs[0];

  // ---------- symbols for code navigation -----------------------------------
  const syms = useRpc<[string, number, number][]>('symbols', [], gen);
  const symIndex = useMemo(() => {
    const full = new Map<string, number>(), short = new Map<string, number[]>(), byObj = new Map<string, number>(), byVA = new Map<number, string>();
    for (const [n, va, obj] of syms.data ?? []) {
      if (n.includes('.')) { full.set(n.toLowerCase(), va); byVA.set(va, n); } else {
        const l = short.get(n.toLowerCase()) ?? []; l.push(va); short.set(n.toLowerCase(), l);
        byObj.set(obj + ':' + n.toLowerCase(), va);
        if (!byVA.has(va)) byVA.set(va, n);
      }
    }
    return { full, short, byObj, byVA };
  }, [syms.data]);
  const makeResolver = useCallback((obj?: number) => (name: string) => {
    const m = /^(?:sub|loc|Label|proc|fn|Proc)_([0-9A-Fa-f]{6,8})$/.exec(name);
    if (m) return parseInt(m[1], 16);
    const l = name.replace(/^Me\./, '').toLowerCase();
    if (obj !== undefined) { const v = symIndex.byObj.get(obj + ':' + l); if (v !== undefined) return v; }
    const f = symIndex.full.get(l);
    if (f !== undefined) return f;
    const s = symIndex.short.get(l);
    if (s && s.length === 1 && !/^(Form_|Class_|UserControl_)/i.test(name)) return s[0];
    return undefined;
  }, [symIndex]);
  const nameOf = (va: number) => symIndex.byVA.get(va) ?? `sub_${va.toString(16).toUpperCase()}`;

  // ---------- tabs ----------------------------------------------------------------
  const updTab = useCallback((id: string, patch: Partial<Tab>) => setTabs(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t))), []);
  const pushHist = (id: string, va?: number) => {
    const h = hist.current;
    const cur = h.stack[h.pos];
    if (cur && cur.id === id && cur.va === va) return;
    h.stack = h.stack.slice(0, h.pos + 1);
    h.stack.push({ id, va });
    if (h.stack.length > 200) h.stack.shift();
    h.pos = h.stack.length - 1;
    setHistVer(v => v + 1);
  };
  const openTab = useCallback((t: Tab, opts: { pin?: boolean; hist?: boolean } = {}) => {
    setTabs(ts => {
      const ex = ts.find(x => x.id === t.id);
      if (ex) return ts.map(x => (x.id === t.id ? { ...x, ...t, title: x.title, preview: opts.pin ? false : x.preview, seq: (x.seq ?? 0) + 1 } : x));
      const nt = { ...t, preview: !opts.pin && (t.kind === 'proc' || t.kind === 'object'), seq: 1 };
      const pv = ts.findIndex(x => x.preview && x.id !== activeRef.current);
      const pvActive = ts.findIndex(x => x.preview && x.id === activeRef.current);
      let out = [...ts];
      const at = Math.max(0, out.findIndex(x => x.id === activeRef.current));
      if (nt.preview && pvActive >= 0) out[pvActive] = nt;
      else if (nt.preview && pv >= 0) out[pv] = nt;
      else out.splice(at + 1, 0, nt);
      while (out.length > MAX_TABS) {
        const k = out.findIndex(x => x.id !== nt.id && x.id !== activeRef.current && x.id !== 'overview');
        if (k < 0) break;
        out.splice(k, 1);
      }
      return out;
    });
    setActiveId(t.id);
    if (opts.hist !== false) pushHist(t.id, t.focus ?? t.va);
  }, []);
  const closeTab = useCallback((id: string) => {
    setTabs(ts => {
      const i = ts.findIndex(t => t.id === id);
      const out = ts.filter(t => t.id !== id);
      if (!out.length) out.push({ id: 'overview', kind: 'overview', title: 'Overview' });
      if (activeRef.current === id) setActiveId(out[Math.min(i, out.length - 1)].id);
      return out;
    });
  }, []);

  const openProc = useCallback((fva: number, focus?: number, opts: { pin?: boolean; view?: string } = {}) => {
    const id = 'proc:' + fva;
    const ex = tabsRef.current.find(t => t.id === id);
    openTab({ id, kind: 'proc', title: nameOf(fva), va: fva, focus, cursor: focus ?? ex?.cursor ?? fva, view: opts.view ?? ex?.view ?? 'code' }, opts);
  }, [openTab, symIndex]); // eslint-disable-line
  const openObject = useCallback((obj: number, opts: { view?: string; sel?: string; pin?: boolean; focus?: number } = {}) => {
    const id = 'obj:' + obj;
    const node = tree.flatMap(g => g.children ?? []).find(n => n.id === 'obj:' + obj);
    const isForm = node?.kind === 'form' || node?.kind === 'mdiform' || node?.kind === 'usercontrol' || node?.children?.some(c => c.kind === 'controls');
    const ex = tabsRef.current.find(t => t.id === id);
    openTab({ id, kind: 'object', title: node?.label ?? `Object ${obj}`, obj, view: opts.view ?? ex?.view ?? (isForm ? 'designer' : 'code'), sel: opts.sel ?? ex?.sel, focus: opts.focus }, opts);
  }, [openTab, tree]);
  const openSingle = useCallback((key: string, focus?: number) => {
    const s = SINGLE[key];
    if (s) openTab({ id: key, kind: s.kind, title: s.title, focus }, { pin: true });
  }, [openTab]);
  const openGrep = useCallback((q: string) => openTab({ id: 'grep:' + q, kind: 'grep', title: `“${q}”`, query: q }, { pin: true }), [openTab]);

  const say = useCallback((msg: string, err?: boolean) => setToast({ msg, err }), []);

  const navigate = useCallback(async (va: number, newTab?: boolean) => {
    // within the current procedure: just move the cursor
    const cur = tabsRef.current.find(t => t.id === activeRef.current);
    const r = await rpc.call<{ kind: string; va: number; func?: number; name?: string }>('resolve', [va]);
    if (r.kind === 'func' || r.kind === 'code') {
      if (cur?.kind === 'proc' && cur.va === r.func && r.kind === 'code') { updTab(cur.id, { cursor: va, focus: va, seq: (cur.seq ?? 0) + 1 }); pushHist(cur.id, va); return; }
      openProc(r.func!, r.kind === 'code' ? va : undefined, { pin: newTab });
    } else if (r.kind === 'string') openSingle('strings', va);
    else if (r.kind === 'import') { say(`Import: ${r.name}`); showXrefs(va, r.name ?? hx(va)); }
    else if (r.kind === 'data' && va === ov.entryPoint) {
      // code outside any recognised procedure (entry stub, thunks): raw disassembly
      openTab({ id: 'proc:' + va, kind: 'proc', title: `loc_${va.toString(16).toUpperCase()}`, va, view: 'asm', cursor: va }, { pin: newTab });
    }
    else if (r.kind === 'global' || r.kind === 'data') openSingle('hex', va);
    else say(`Address ${hx(va)} is not mapped in this image`, true);
  }, [openProc, openSingle, updTab, say]); // eslint-disable-line

  const showXrefs = useCallback((va: number | number[], title: string) => {
    setDialog({ kind: 'xrefs', title });
    const vas = Array.isArray(va) ? va : [va];
    rpc.call<XrefItem[]>('xrefsToMany', [vas]).then(items => setDialog(d => (d?.kind === 'xrefs' && d.title === title ? { ...d, items } : d)));
  }, []);

  const goHist = (d: number) => {
    const h = hist.current;
    const n = h.pos + d;
    if (n < 0 || n >= h.stack.length) return;
    h.pos = n;
    setHistVer(v => v + 1);
    const e = h.stack[n];
    const ex = tabsRef.current.find(t => t.id === e.id);
    if (ex) { setActiveId(e.id); if (e.va !== undefined) updTab(e.id, { focus: e.va, cursor: ex.kind === 'proc' ? e.va : ex.cursor, seq: (ex.seq ?? 0) + 1 }); }
    else if (e.id.startsWith('proc:')) openTab({ id: e.id, kind: 'proc', title: nameOf(+e.id.slice(5)), va: +e.id.slice(5), focus: e.va, cursor: e.va, view: 'code' }, { hist: false });
    else if (e.id.startsWith('obj:')) openObject(+e.id.slice(4));
    else if (SINGLE[e.id]) openTab({ id: e.id, kind: SINGLE[e.id].kind, title: SINGLE[e.id].title, focus: e.va }, { hist: false, pin: true });
  };

  const tabStrip = useRef<HTMLDivElement>(null);
  const openTlb = useCallback(() => tlbInput.current?.click(), []);
  const openMenu = useCallback((e: React.MouseEvent, items: MenuItem[]) => setCtx({ x: e.clientX, y: e.clientY, items }), []);
  useEffect(() => {
    setPeek(undefined); setCtx(undefined);
    tabStrip.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  const tabMenu = (t: Tab, e: React.MouseEvent) => {
    const idx = tabsRef.current.findIndex(x => x.id === t.id);
    const keep = (f: (x: Tab, i: number) => boolean) => {
      setTabs(ts => {
        const out = ts.filter(f);
        if (!out.length) out.push({ id: 'overview', kind: 'overview', title: 'Overview' });
        if (!out.some(x => x.id === activeRef.current)) setActiveId(out.find(x => x.id === t.id)?.id ?? out[out.length - 1].id);
        return out;
      });
    };
    setCtx({
      x: e.clientX, y: e.clientY, items: [
        { label: 'Close', icon: <I.x size={14} />, key: 'Alt+W', run: () => closeTab(t.id) },
        { label: 'Close others', run: () => keep(x => x.id === t.id) },
        { label: 'Close tabs to the right', run: () => keep((_, i) => i <= idx) },
        { label: 'Close all', run: () => keep(() => false) },
        { sep: true, label: '', run: () => undefined },
        { label: t.preview ? 'Keep open (pin)' : 'Pinned', run: () => updTab(t.id, { preview: false }) },
      ],
    });
  };

  // ---------- browser navigation guards ---------------------------------------------------
  // The browser's Back (button, Alt+←, mouse back button) would leave the page and drop the
  // whole analysis: map it onto the workspace history instead, and confirm before unloading.
  const goHistRef = useRef(goHist); goHistRef.current = goHist;
  useEffect(() => {
    try { history.pushState({ vblens: 1 }, ''); } catch { /* sandboxed */ }
    const onPop = (e: PopStateEvent) => {
      if (e.state && e.state.vblens) return;
      try { history.pushState({ vblens: 1 }, ''); } catch { /* ignore */ }
      goHistRef.current(-1);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) { e.preventDefault(); if (e.type === 'mouseup') goHistRef.current(e.button === 3 ? -1 : 1); }
    };
    // standalone: leaving the page loses the analysis. Live: the server keeps it.
    const onUnload = (e: BeforeUnloadEvent) => { if (isLive) return; e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('popstate', onPop);
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('beforeunload', onUnload);
    document.body.dataset.guard = '1';
    return () => {
      window.removeEventListener('popstate', onPop); window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('mousedown', onMouse); window.removeEventListener('beforeunload', onUnload);
      delete document.body.dataset.guard;
    };
  }, []);

  // ---------- edits -------------------------------------------------------------------
  const persist = (kind: 'renames' | 'comments', va: number, v: string) => {
    try {
      const key = 'vblens:' + ov.hash;
      const s = JSON.parse(localStorage.getItem(key) ?? '{}');
      const arr: [number, string][] = (s[kind] ?? []).filter((x: [number, string]) => x[0] !== va);
      if (v) arr.push([va, v]);
      s[kind] = arr;
      localStorage.setItem(key, JSON.stringify(s));
    } catch { /* storage unavailable */ }
  };
  const refresh = async () => {
    invalidateCache();
    setGen(g => g + 1);
    setTree(await rpc.call<TreeNode[]>('tree'));
  };
  const rename = useCallback((va: number) => {
    const cur = nameOf(va).split('.').pop()!;
    setDialog({
      kind: 'prompt', title: `Rename ${hx(va)}`, initial: cur, placeholder: 'New name', hint: isLive ? 'Shared with your AI agent and saved by the MCP server.' : 'Renames are saved in this browser for this file.',
      validate: v => {
        const e = vbIdentifierError(v.trim());
        if (e) return e;
        // another procedure of the same object already uses this name?
        const obj = (syms.data ?? []).find(x => x[1] === va)?.[2];
        const clash = (syms.data ?? []).find(x => x[2] === obj && x[1] !== va && !x[0].includes('.') && x[0].toLowerCase() === v.trim().toLowerCase());
        return clash ? `${v.trim()} is already used by another procedure here` : undefined;
      },
      submit: async v => {
        v = v.trim();
        if (!v || v === cur || vbIdentifierError(v)) return;
        try { await rpc.call('rename', [va, v]); } catch (e) { say('Rename failed: ' + (e as Error).message, true); return; }
        persist('renames', va, v);
        await refresh();
        setTabs(ts => ts.map(t => (t.va === va && t.kind === 'proc' ? { ...t, title: t.title.includes('.') ? t.title.replace(/[^.]+$/, v) : v } : t)));
        say(`Renamed to ${v}`);
      },
    });
  }, [symIndex]); // eslint-disable-line
  const comment = useCallback((va: number) => {
    setDialog({
      kind: 'prompt', title: `Comment at ${hx(va)}`, placeholder: 'Comment (empty to remove)',
      submit: async v => { await rpc.call('setComment', [va, v.trim()]); persist('comments', va, v.trim()); invalidateCache(); setGen(g => g + 1); },
    });
  }, []); // eslint-disable-line
  const gotoPrompt = useCallback(() => setDialog({
    kind: 'prompt', title: 'Go to address or name', placeholder: '401A2C or Form1.Command1_Click',
    submit: async v => {
      v = v.trim();
      if (!v) return;
      if (/^(0x)?[0-9a-f]{1,8}h?$/i.test(v)) { navigate(parseInt(v.replace(/^0x|h$/gi, ''), 16)); return; }
      const va = makeResolver()(v);
      if (va !== undefined) { navigate(va); return; }
      const r = await rpc.call<SearchResult[]>('search', [v, 5]);
      if (r[0]) pick(r[0]); else say(`Nothing named “${v}”`, true);
    },
  }), [navigate, makeResolver]); // eslint-disable-line

  const exporting = useRef(false);
  const [exportBusy, setExportBusy] = useState(false);
  const exportZip = useCallback(async () => {
    if (exporting.current) { say('Export already in progress'); return; }
    exporting.current = true; setExportBusy(true);
    say('Exporting project…');
    try {
      const z = await rpc.call<Uint8Array>('exportZip', [], (m, p) => setToast({ msg: `Exporting · ${m} (${Math.round(p * 100)}%)` }));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([z as BlobPart], { type: 'application/zip' }));
      a.download = (ov.projectName || ov.fileName.replace(/\.\w+$/, '')) + '_decompiled.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      say(`Saved ${a.download} (${(z.length / 1024).toFixed(0)} KB)`);
    } catch (e) { say('Export failed: ' + (e as Error).message, true); }
    finally { exporting.current = false; setExportBusy(false); }
  }, [ov]); // eslint-disable-line

  const loadTlb = async (f: File) => {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await rpc.call<{ name: string; classes: number; types: number }>('loadTypeLib', [bytes.slice()]);
      await saveTypeLib(f.name, bytes);
      await refresh();
      say(`Loaded type library ${r.name}: ${r.classes} control classes (remembered for next time)`);
    } catch (e) { say(`${f.name}: ${(e as Error).message}`, true); }
  };

  const pick = useCallback((r: SearchResult) => {
    if (r.kind === 'control' && r.obj !== undefined) openObject(r.obj, { view: 'designer', sel: r.label, pin: true });
    else if (r.obj !== undefined && r.va === undefined) openObject(r.obj, { pin: true });
    else if (r.kind === 'string' && r.va !== undefined) openSingle('strings', r.va);
    else if (r.kind === 'declare') openSingle('declares');
    else if (r.va !== undefined) navigate(r.va, true);
  }, [openObject, openSingle, navigate]);

  // ---------- peek ------------------------------------------------------------------------
  const peekTimer = useRef<number>();
  const peekCache = useRef(new Map<number, PeekData | null>());
  const onPeek = useCallback((va: number | undefined, x: number, y: number) => {
    clearTimeout(peekTimer.current);
    if (va === undefined) { setPeek(undefined); return; }
    peekTimer.current = window.setTimeout(async () => {
      let d = peekCache.current.get(va);
      if (d === undefined) {
        const r = await rpc.call<{ kind: string; name?: string; func?: number }>('resolve', [va]);
        if (r.kind === 'func') {
          const doc = await rpc.call<CodeDoc>('decompile', [va]);
          d = { title: doc.title, kind: 'proc', lines: [doc.header, ...doc.lines.slice(0, 14).map(l => '    '.repeat(Math.max(0, l.indent)) + l.text), doc.lines.length > 14 ? '    …' : doc.footer ?? ''] };
        } else if (r.kind === 'string') d = { title: hx(va), kind: 'string', lines: [JSON.stringify(r.name)] };
        else if (r.kind === 'import') d = { title: r.name ?? '', kind: 'imports', lines: ['Imported function'] };
        else if (r.kind === 'code') d = { title: r.name ?? '', kind: 'proc', lines: [`${hx(va)} inside ${r.name}`] };
        else d = null;
        peekCache.current.set(va, d);
      }
      if (d) setPeek({ x, y, data: d });
    }, 380);
  }, []);
  useEffect(() => { peekCache.current.clear(); }, [gen]);

  // ---------- context menus ----------------------------------------------------------------
  const codeContext = (e: React.MouseEvent, va: number | undefined, target: number | undefined, proc?: number) => {
    const items: MenuItem[] = [];
    if (target !== undefined) {
      items.push({ label: `Go to ${nameOf(target)}`, icon: <I.fwd size={14} />, key: 'Enter', run: () => navigate(target) });
      items.push({ label: 'Open in new tab', icon: <I.split size={14} />, key: 'Ctrl+Click', run: () => navigate(target, true) });
      items.push({ label: 'Cross references to target', icon: <I.ref size={14} />, run: () => showXrefs(target, nameOf(target)) });
      items.push({ sep: true, label: '', run: () => undefined });
    }
    if (va !== undefined) {
      items.push({ label: 'Add comment', icon: <I.text size={14} />, key: ';', run: () => comment(va) });
      items.push({ label: 'Show in hex', icon: <I.hex size={14} />, run: () => openSingle('hex', va) });
      items.push({ label: `Copy address ${hx(va)}`, icon: <I.copy size={14} />, run: () => { copyText(hx(va)).then(ok => say(ok ? 'Address copied' : 'Could not access the clipboard', !ok)); } });
    }
    if (proc !== undefined) {
      items.push({ sep: true, label: '', run: () => undefined });
      items.push({ label: 'Rename procedure', icon: <I.tag size={14} />, key: 'N', run: () => rename(proc) });
      items.push({ label: 'Cross references to procedure', icon: <I.ref size={14} />, key: 'X', run: () => showXrefs(proc, nameOf(proc)) });
    }
    setCtx({ x: e.clientX, y: e.clientY, items });
  };

  // ---------- keyboard -------------------------------------------------------------------------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if (e.key === ' ' && (t.tagName === 'BUTTON' || t.tagName === 'A')) return; // let Space press the focused button
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 'k' || k === 'p') && !e.shiftKey) { e.preventDefault(); setDialog({ kind: 'palette' }); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'f') { e.preventDefault(); setDialog({ kind: 'prompt', title: 'Search all decompiled code', placeholder: 'Text to find, e.g. MsgBox or a string', submit: v => v.trim() && openGrep(v.trim()) }); return; }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); goHist(e.key === 'ArrowLeft' ? -1 : 1); return; }
      if (e.altKey && k === 'w') { e.preventDefault(); closeTab(activeRef.current); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'f' && !e.shiftKey && !typing && !dialog) {
        // find in the active code/disassembly view even when it doesn't have focus
        const pane = document.querySelector('.tabpane:not(.hidden)');
        const target = (pane?.querySelector('[data-testid=code]:focus, [data-testid=disasm]:focus') ?? pane?.querySelector('[data-testid=code], [data-testid=disasm], [data-testid=frm]')) as HTMLElement | null;
        if (target && !target.contains(t)) {
          e.preventDefault();
          target.focus({ preventScroll: true });
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true }));
          return;
        }
      }
      if (e.key === 'Escape') { setCtx(undefined); setPeek(undefined); }
      if (typing || dialog || e.ctrlKey || e.metaKey || e.altKey) return;
      const cur = tabsRef.current.find(x => x.id === activeRef.current);
      const target = cur?.kind === 'proc' ? cur.cursor ?? cur.va : undefined;
      if (k === 'g') { e.preventDefault(); gotoPrompt(); }
      else if (k === 'n' && cur?.kind === 'proc') { e.preventDefault(); rename(cur.va!); }
      else if (e.key === ';' && target !== undefined) { e.preventDefault(); comment(target); }
      else if (k === 'x' && cur?.kind === 'proc') { e.preventDefault(); showXrefs(cur.va!, cur.title); }
      else if (e.key === 'Tab' && cur?.kind === 'proc') { e.preventDefault(); updTab(cur.id, { view: cur.view === 'code' || !cur.view ? 'asm' : 'code', preview: false }); }
      else if (e.key === ' ' && cur?.kind === 'proc') { e.preventDefault(); updTab(cur.id, { view: cur.view === 'graph' ? 'asm' : 'graph', preview: false }); }
      else if (k === 'i') toggleRight();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }); // re-bind each render: handlers close over fresh state

  // ---------- tree ------------------------------------------------------------------------
  const onTree = (n: TreeNode, e: React.MouseEvent | React.KeyboardEvent) => {
    const pin = e.type === 'dblclick' || (e as React.MouseEvent).detail === 2;
    if (n.kind === 'overview') openSingle('overview');
    else if (SINGLE[n.kind]) openSingle(n.kind);
    else if (n.id.startsWith('fn:')) openProc(n.va!, undefined, { pin });
    else if (n.id.startsWith('obj:')) openObject(n.obj!, { pin });
    else if (n.id.startsWith('ctls:')) openObject(n.obj!, { view: 'designer', pin });
    else if (n.id.startsWith('ctl:')) openObject(n.obj!, { view: 'designer', sel: n.label, pin });
  };
  const treeActive = active?.kind === 'proc' ? 'fn:' + active.va : active?.kind === 'object' ? (active.sel && active.view === 'designer' ? undefined : 'obj:' + active.obj) : active?.id;

  // ---------- splitters ---------------------------------------------------------------------
  const drag = (side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    if (e.detail === 2) { setWidths(w => ({ ...w, [side]: side === 'left' ? 300 : 330 })); return; } // double-click resets
    const x0 = e.clientX, w0 = side === 'left' ? leftW : rightW;
    const mv = (ev: MouseEvent) => { ev.preventDefault(); setWidths(w => ({ ...w, [side]: Math.max(180, Math.min(700, w0 + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX))) })); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); document.body.classList.remove('resizing'); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    document.body.classList.add('resizing');
  };

  const commands: Command[] = [
    { id: 'goto', label: 'Go to address or name…', hint: 'G', run: gotoPrompt },
    { id: 'grep', label: 'Search all decompiled code…', hint: 'Ctrl+Shift+F', run: () => setDialog({ kind: 'prompt', title: 'Search all decompiled code', submit: v => v.trim() && openGrep(v.trim()) }) },
    { id: 'export', label: 'Export project as .zip (.vbp, .frm, .bas, .cls)', run: exportZip },
    { id: 'ov', label: 'Show overview', run: () => openSingle('overview') },
    { id: 'str', label: 'Show strings', run: () => openSingle('strings') },
    { id: 'imp', label: 'Show imports', run: () => openSingle('imports') },
    { id: 'dec', label: 'Show API declares', run: () => openSingle('declares') },
    { id: 'ref', label: 'Show references (components)', run: () => openSingle('components') },
    { id: 'hex', label: 'Show hex view', run: () => openSingle('hex') },
    { id: 'tlb', label: 'Load type library (.ocx / .tlb / .dll) to name ActiveX members…', run: () => tlbInput.current?.click() },
    { id: 'insp', label: 'Toggle inspector panel', hint: 'I', run: () => toggleRight() },
    { id: 'open', label: 'Open another executable…', run: () => fileInput.current?.click() },
    { id: 'close', label: 'Close file', run: onClose },
    { id: 'tlbclear', label: 'Forget remembered type libraries', run: () => { clearTypeLibs(); say('Remembered type libraries cleared'); } },
    isLive
      ? { id: 'reset', label: 'Forget all renames and comments for this file (also the agent\'s)', run: async () => {
        try { await rpc.call('resetAnnotations'); } catch (e) { say('Reset failed: ' + (e as Error).message, true); return; }
        try { localStorage.removeItem('vblens:' + ov.hash); } catch { /* ignore */ }
        await refresh(); await retitle(); say('Renames and comments cleared');
      } }
      : { id: 'reset', label: 'Forget renames and comments for this file', run: () => { localStorage.removeItem('vblens:' + ov.hash); say('Saved edits cleared — reopen the file to reset names'); } },
    ...(isLive ? [
      ...(isDesktop ? [{ id: 'agent', label: 'AI agent (MCP) settings…', run: () => openSettings('agent') }] : []),
      { id: 'follow', label: (getLiveState().follow ? 'Stop following' : 'Follow') + ' the agent (move to what it reads)', run: () => setFollow(!getLiveState().follow) },
      ...getLiveState().files.filter(f => f.file !== fileId).map(f => ({ id: 'sw:' + f.file, label: `Switch to ${f.name} (open on the MCP server)`, run: () => onSwitch?.(f.file) })),
    ] : []),
  ];

  // ---------- live mode: shared with the agent through the MCP server ----------------------
  const liveSt = useLiveState();
  const [agentNote, setAgentNote] = useState<string | undefined>();
  const [showAct, setShowAct] = useState(false);
  useEffect(() => {
    if (!liveSt.activity) return;
    setShowAct(true);
    const t = setTimeout(() => setShowAct(false), 10_000);
    return () => clearTimeout(t);
  }, [liveSt.activity]);
  useEffect(() => { if (!agentNote) return; const t = setTimeout(() => setAgentNote(undefined), 45_000); return () => clearTimeout(t); }, [agentNote]);
  /** Proc tab titles after names changed elsewhere. */
  const retitle = async () => {
    const all = await rpc.call<[string, number, number][]>('symbols').catch(() => undefined);
    if (!all) return;
    const full = new Map<number, string>();
    for (const [n, va] of all) if (n.includes('.') || !full.has(va)) full.set(va, n);
    setTabs(ts => ts.map(t => (t.kind === 'proc' && t.va !== undefined && full.has(t.va) ? { ...t, title: full.get(t.va)! } : t)));
  };
  /** Move the view to something the agent read or wants to show. */
  const applyTarget = async (t: LiveTarget, pin: boolean) => {
    if (t.kind === 'object' || (t.obj !== undefined && t.va === undefined)) {
      const view = t.view === 'designer' || t.view === 'frm' || t.view === 'code' ? t.view : undefined;
      openObject(t.obj!, { view, sel: t.control, pin });
      return;
    }
    if (t.va === undefined) return;
    if (t.kind === 'string') { openSingle('strings', t.va); return; }
    if (t.kind === 'hex') { openSingle('hex', t.va); return; }
    const r = await rpc.call<{ kind: string; func?: number }>('resolve', [t.va]).catch(() => undefined);
    if (!r) return;
    if (r.func === undefined) { if (r.kind === 'string') openSingle('strings', t.va); else if (r.kind === 'data' || r.kind === 'global') openSingle('hex', t.va); return; }
    const focus = t.focus ?? (r.kind === 'code' ? t.va : undefined);
    const view = t.view === 'asm' || t.view === 'graph' ? t.view : 'code';
    const cur = tabsRef.current.find(x => x.id === activeRef.current);
    // already there: don't remount the view (it would lose the scroll position)
    if (!pin && focus === undefined && cur?.kind === 'proc' && cur.va === r.func && (cur.view ?? 'code') === view) return;
    openProc(r.func, focus, { pin, view });
  };
  const onRemoteChange = async (d: LiveChange) => {
    await refresh();
    if (d.what === 'rename' || d.what === 'reset') await retitle();
    const who = d.by === 'agent' ? 'Agent' : 'Another window';
    const where = d.va !== undefined ? hx(d.va) : '';
    say(d.what === 'rename' ? `${who} renamed ${where} to ${d.name}` : d.what === 'comment' ? `${who} ${d.name ? 'commented' : 'removed a comment'} at ${where}`
      : d.what === 'typelib' ? `${who} loaded a type library — names updated` : `${who} reset renames and comments`);
  };
  const liveRef = useRef({ applyTarget, onRemoteChange, dialog });
  liveRef.current = { applyTarget, onRemoteChange, dialog };
  useEffect(() => {
    if (!isLive || !fileId) return;
    return onLive(ev => {
      const L = liveRef.current;
      if (ev.type === 'show' && ev.data.file === fileId) { setDialog(undefined); void L.applyTarget(ev.data, true); setAgentNote(ev.data.note); }
      else if (ev.type === 'activity' && ev.data.file === fileId && ev.data.by === 'agent' && !/open$/.test(ev.data.tool)) {
        // follow the agent, but never pull the view away while the user is working
        if (getLiveState().follow && !userBusy() && !L.dialog) void L.applyTarget(ev.data, false);
      } else if (ev.type === 'changed' && ev.data.file === fileId) void L.onRemoteChange(ev.data);
    });
  }, [fileId]);
  // where the agent was when this file was switched to
  useEffect(() => {
    if (!initialShow || !syms.data) return;
    const isShow = !('tool' in initialShow);
    void applyTarget(initialShow, isShow);
    if (isShow) setAgentNote(initialShow.note);
    onShown?.();
  }, [initialShow, syms.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // tell the server what the user is looking at (for the agent's vb_get_user_view)
  useEffect(() => {
    if (!isLive || !fileId || !active) return;
    reportView({
      file: fileId, tab: active.id, kind: active.kind, title: active.title, view: active.view, va: active.va,
      cursor: active.kind === 'proc' ? active.cursor ?? active.va : active.cursor ?? active.focus, obj: active.obj,
      control: active.kind === 'object' && active.view === 'designer' ? active.sel : undefined,
    });
  }, [fileId, active?.id, active?.cursor, active?.view, active?.sel, active?.title, active?.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isLive || !fileId) return;
    let t: number | undefined;
    const onSel = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const sel = document.getSelection();
        const inApp = sel && sel.rangeCount && (sel.anchorNode as Element | null)?.parentElement?.closest?.('.tabpane');
        reportView({ file: fileId, selection: inApp ? sel!.toString().slice(0, 4000) || undefined : undefined }, false);
      }, 300);
    };
    document.addEventListener('selectionchange', onSel);
    return () => { document.removeEventListener('selectionchange', onSel); clearTimeout(t); };
  }, [fileId]);
  const [, tickAgent] = useState(0);
  useEffect(() => { if (!isDesktop) return; const t = setInterval(() => tickAgent(n => n + 1), 10_000); return () => clearInterval(t); }, []);
  const mcp = liveSt.app?.mcp;
  const agentState: 'off' | 'ready' | 'active' = !mcp?.active ? 'off' : (mcp.lastAgentAt && Date.now() - mcp.lastAgentAt < 60_000) || (liveSt.activity && Date.now() - liveSt.activity.at < 60_000) ? 'active' : 'ready';
  const liveMenu = (e: React.MouseEvent) => openMenu(e, [
    ...(isDesktop ? [{ label: 'AI agent settings…', icon: <I.robot size={14} />, run: () => openSettings('agent') }] : []),
    { label: liveSt.follow ? 'Following the agent — click to stop' : 'Follow the agent', icon: liveSt.follow ? <I.check size={14} /> : <I.fwd size={14} />, run: () => setFollow(!liveSt.follow) },
    { sep: true, label: '', run: () => undefined },
    ...liveSt.files.map(f => ({ label: `${f.name}${f.file === fileId ? '  (showing)' : ''}`, icon: <I.file size={14} />, run: () => { if (f.file !== fileId) onSwitch?.(f.file); } })),
  ]);

  // ---------- render ------------------------------------------------------------------------
  return (
    <div className="ws" data-testid="workspace"
      onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragOver(true); }} onDragLeave={e => { if (!e.relatedTarget || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) { if (/\.(ocx|tlb|olb)$/i.test(f.name)) loadTlb(f); else onOpen(f); } }}>
      <div className="topbar">
        <div className="brand" style={{ cursor: 'pointer' }} onClick={onClose} title="Close file"><Logo size={24} /><span className="lbl">VB<span className="grad-text">Lens</span></span></div>
        <div className="file-chip" title={ov.fileName}><I.file size={14} /><span className="mono" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ov.fileName}</span></div>
        <span className={'chip compile ' + (ov.compile === 'P-Code' ? 'amber' : 'green')}>{ov.compile}</span>
        {ov.projectName && <span className="chip proj">{ov.projectName}</span>}
        {isDesktop ? (
          <button className={'chip live' + (agentState === 'active' ? ' on' : agentState === 'ready' ? ' ready' : '')} data-testid="live-chip" onClick={liveMenu}
            title={agentState === 'off' ? 'AI agent access is off. Click for options.' : agentState === 'active' ? 'An AI agent is working with VBLens. Click for options.' : 'AI agents can connect. Click for options.'}>
            {agentState === 'active' ? <span className="live-dot on" /> : <I.robot size={13} />}
            <span className="lbl">{agentState === 'off' ? 'AI agent off' : agentState === 'active' ? `Agent active${liveSt.follow ? ' · following' : ''}` : 'AI agent on'}</span>
          </button>
        ) : isLive && (
          <button className={'chip live' + (liveSt.connected ? ' on' : '')} data-testid="live-chip" onClick={liveMenu}
            title={liveSt.connected ? 'Connected to the VBLens MCP server: shared with your AI agent. Click for options.' : 'Reconnecting to the VBLens MCP server…'}>
            <span className={'live-dot' + (liveSt.connected ? ' on' : '')} /><span className="lbl">Live{liveSt.follow ? ' · following' : ''}</span>
          </button>
        )}
        <div className="navbtns">
          <button className="btn sm icon ghost" title="Back (Alt+←, mouse back button)" disabled={hist.current.pos <= 0} onClick={() => goHist(-1)}><I.back size={16} /></button>
          <button className="btn sm icon ghost" title="Forward (Alt+→)" disabled={hist.current.pos >= hist.current.stack.length - 1} onClick={() => goHist(1)}><I.fwd size={16} /></button>
        </div>
        <div className="spacer" />
        <div className="search-trigger" onClick={() => setDialog({ kind: 'palette' })} data-testid="search-trigger"><I.search size={14} /><span className="lbl">Search or jump to…</span><kbd>Ctrl K</kbd></div>
        <div className="spacer" />
        <button className="btn sm" onClick={() => fileInput.current?.click()} title="Open another file"><I.upload size={14} /><span className="lbl">Open</span></button>
        <button className="btn sm primary" onClick={exportZip} data-testid="export" disabled={exportBusy}><I.download size={14} /><span className="lbl">Export project</span></button>
        <button className={'btn sm icon ' + (showRight ? '' : 'ghost')} onClick={() => toggleRight()} title="Toggle inspector (I)"><I.panel size={15} /></button>
        <input ref={fileInput} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onOpen(f); e.target.value = ''; }} />
        <input ref={tlbInput} type="file" hidden multiple accept=".ocx,.tlb,.olb,.dll" onChange={async e => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; for (const f of fs) await loadTlb(f); }} />
      </div>

      <div className={'main' + (showRight ? '' : ' no-right')} style={{ ['--left' as string]: leftW + 'px', ['--right' as string]: rightW + 'px' }}>
        <div className="panel">
          <div className="panel-head"><I.layers size={13} /> Project <span className="spacer" /><span className="faint" style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>{ov.functions} procs</span></div>
          <Explorer tree={tree} activeId={treeActive} onOpen={onTree}
            onContext={(n, e) => {
              const items: MenuItem[] = [];
              if (n.va !== undefined) {
                items.push({ label: 'Open', icon: <I.code size={14} />, run: () => openProc(n.va!, undefined, { pin: true }) });
                items.push({ label: 'Open disassembly', icon: <I.asm size={14} />, run: () => openProc(n.va!, undefined, { pin: true, view: 'asm' }) });
                items.push({ label: 'Open graph', icon: <I.graph size={14} />, run: () => openProc(n.va!, undefined, { pin: true, view: 'graph' }) });
                items.push({ label: 'Rename', icon: <I.tag size={14} />, key: 'N', run: () => rename(n.va!) });
                items.push({ label: 'Cross references', icon: <I.ref size={14} />, key: 'X', run: () => showXrefs(n.va!, n.label) });
              } else if (n.obj !== undefined) {
                items.push({ label: 'View code', icon: <I.code size={14} />, run: () => openObject(n.obj!, { view: 'code', pin: true }) });
                if (n.kind !== 'module' && n.kind !== 'class') items.push({ label: 'View designer', icon: <I.designer size={14} />, run: () => openObject(n.obj!, { view: 'designer', pin: true }) });
              } else return;
              setCtx({ x: e.clientX, y: e.clientY, items });
            }} />
        </div>
        <div className="splitter" onMouseDown={drag('left')} />
        <div className="center">
          <div className="tabs" data-testid="tabs" ref={tabStrip}
            onWheel={e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
            {tabs.map(t => (
              <div key={t.id} data-tab={t.id} className={'tab' + (t.id === activeId ? ' active' : '') + (t.preview ? ' preview' : '')} onClick={() => { setActiveId(t.id); pushHist(t.id, t.cursor); }}
                onDoubleClick={() => updTab(t.id, { preview: false })}
                onContextMenu={e => { e.preventDefault(); tabMenu(t, e); }}
                onMouseDown={e => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }} title={t.title}>
                {iconFor(t.kind === 'proc' ? 'proc' : t.kind === 'object' ? (tree.flatMap(g => g.children ?? []).find(n => n.obj === t.obj && n.id.startsWith('obj:'))?.kind ?? 'form') : t.kind === 'grep' ? 'address' : t.kind, 14)}
                <span className="t">{t.title}</span>
                <span className="x" onClick={e => { e.stopPropagation(); closeTab(t.id); }}><I.x size={12} /></span>
              </div>
            ))}
          </div>
          {tabs.map(t => (
            // every open tab stays mounted (hidden when inactive) so scroll position, view and
            // selection survive switching tabs
            <div key={t.id} className={'tabpane' + (t.id === activeId ? '' : ' hidden')}>
              <TabPane tab={t} hidden={t.id !== activeId} ov={ov} gen={gen} updTab={updTab} navigate={navigate} openProc={openProc} openSingle={openSingle}
                makeResolver={makeResolver} onPeek={onPeek} codeContext={codeContext} showXrefs={showXrefs} rename={rename} say={say} tlb={openTlb} nameOf={nameOf} menu={openMenu} />
            </div>
          ))}
        </div>
        <div className="splitter" onMouseDown={drag('right')} style={showRight ? undefined : { display: 'none' }} />
        {showRight && (
          <div className="panel">
            <div className="panel-head"><I.panel size={13} /> Inspector <span className="spacer" /><button className="btn sm icon ghost" onClick={toggleRight} title="Hide (I)"><I.x size={13} /></button></div>
            <InspectorFor tab={active} ov={ov} gen={gen} navigate={navigate} rename={rename} />
          </div>
        )}
      </div>

      <div className="status">
        {isLive
          ? <span data-testid="live-status"><span className={liveSt.connected ? 'dotok' : 'dotwarn'} />{liveSt.connected ? (isDesktop ? 'Ready' : 'Live') : (isDesktop ? 'Engine not responding…' : 'Reconnecting…')}{showAct && liveSt.activity ? <span className="agent-act"> · Agent: {liveSt.activity.label}</span> : null}</span>
          : <span><span className="dotok" />Ready</span>}
        <span>{ov.compile} · VB{ov.vbVersion ?? 6}</span>
        {active.kind === 'proc' && <span className="mono">{active.title} · {active.cursor !== undefined ? hx(active.cursor) : ''}</span>}
        <span className="r">
          <span>{ov.functions} procedures</span>
          <span>{ov.controls} controls</span>
          <span>{ov.strings} strings</span>
          <span><kbd>Ctrl K</kbd> search · <kbd>G</kbd> go to · <kbd>Tab</kbd> code/asm</span>
        </span>
      </div>

      {dialog?.kind === 'palette' && <Palette initial={dialog.initial} onClose={() => setDialog(undefined)} onPick={pick} commands={commands} onGrep={openGrep} />}
      {dialog?.kind === 'prompt' && <Prompt {...dialog} onSubmit={dialog.submit} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'xrefs' && <XrefsDialog title={dialog.title} items={dialog.items} onNavigate={va => navigate(va)} onClose={() => setDialog(undefined)} />}
      {ctx && <ContextMenu {...ctx} onClose={() => setCtx(undefined)} />}
      {peek && <Peek {...peek} />}
      {toast && <Toast msg={toast.msg} err={toast.err} onDone={() => setToast(undefined)} />}
      {agentNote && (
        <div className="agentnote" data-testid="agent-note" role="status">
          <I.bolt size={16} color="#b7a5ff" />
          <div><b>Agent</b><span>{agentNote}</span></div>
          <button className="btn sm icon ghost" onClick={() => setAgentNote(undefined)} title="Dismiss"><I.x size={13} /></button>
        </div>
      )}
      {dragOver && <div className="dropveil"><div><I.upload size={34} /><div style={{ marginTop: 10 }}>Drop an executable to open it — or an .ocx/.tlb to load its type library</div></div></div>}
    </div>
  );
}

// ======================================================================================
interface BodyProps {
  tab: Tab; ov: Loaded['overview']; gen: number;
  updTab: (id: string, p: Partial<Tab>) => void;
  navigate: (va: number, newTab?: boolean) => void;
  openProc: (fva: number, focus?: number, o?: { pin?: boolean; view?: string }) => void;
  openSingle: (k: string, focus?: number) => void;
  makeResolver: (obj?: number) => (n: string) => number | undefined;
  onPeek: (va: number | undefined, x: number, y: number) => void;
  codeContext: (e: React.MouseEvent, va: number | undefined, target: number | undefined, proc?: number) => void;
  showXrefs: (va: number | number[], title: string) => void;
  rename: (va: number) => void;
  say: (m: string, err?: boolean) => void;
  tlb: () => void;
  nameOf: (va: number) => string;
  menu: (e: React.MouseEvent, items: MenuItem[]) => void;
}

const TabPane = memo(function TabPane(p: BodyProps & { hidden: boolean }) {
  return <TabBody {...p} />;
}, (a, b) => a.tab === b.tab && a.hidden === b.hidden && a.gen === b.gen && a.makeResolver === b.makeResolver && (a.hidden || (a.navigate === b.navigate && a.nameOf === b.nameOf)));

function TabBody(p: BodyProps) {
  const { tab } = p;
  switch (tab.kind) {
    case 'proc': return <ProcBody {...p} />;
    case 'object': return <ObjectBody {...p} />;
    case 'overview': return <div className="view"><OverviewView ov={p.ov} onNavigate={p.navigate} onOpen={k => (k.startsWith('hex:') ? p.openSingle('hex', +k.slice(4)) : p.openSingle(k))} /></div>;
    case 'strings': return <StringsBody {...p} />;
    case 'imports': return <ImportsBody {...p} />;
    case 'declares': return <DeclaresBody {...p} />;
    case 'components': return <ComponentsBody {...p} />;
    case 'hex': return <HexBody {...p} />;
    case 'grep': return <GrepBody {...p} />;
    default: return <div className="view" />;
  }
}

function ProcBody({ tab, gen, updTab, navigate, makeResolver, onPeek, codeContext, showXrefs, rename, say, tlb }: BodyProps) {
  const view = tab.view ?? 'code';
  const code = useRpc<CodeDoc>(view === 'code' || view === 'split' ? 'decompile' : undefined, [tab.va], gen);
  const dis = useRpc<{ rows: DisasmRow[]; title: string }>(view === 'asm' || view === 'split' ? 'disasm' : undefined, [tab.va], gen);
  const graph = useRpc<GraphData>(view === 'graph' ? 'graph' : undefined, [tab.va], gen);
  const resolve = useMemo(() => makeResolver(code.data?.obj), [makeResolver, code.data?.obj]);
  const setCursor = (va: number) => updTab(tab.id, { cursor: va });
  const focus = tab.focus !== undefined ? tab.focus : undefined;
  const nav = (va: number, nt?: boolean) => navigate(va, nt);
  const copy = async () => {
    const d = code.data ?? await rpc.call<CodeDoc>('decompile', [tab.va]).catch(() => undefined);
    if (!d) return;
    const ok = await copyText([d.header, ...d.lines.map(l => '    '.repeat(Math.max(0, l.indent)) + l.text), d.footer].join('\r\n'));
    say(ok ? 'Procedure source copied' : 'Could not access the clipboard', !ok);
  };
  const codeEl = code.data ? (
    <CodeView key={'c' + (tab.seq ?? 0)} doc={code.data} resolve={resolve} onNavigate={nav} cursorVA={tab.cursor} onCursor={setCursor} focusVA={focus} onPeek={onPeek} testId="code"
      onContext={(e, info) => codeContext(e, info.va, info.word ? resolve(info.word) : undefined, tab.va)} />
  ) : <Loading err={code.error} />;
  const disEl = dis.data ? (
    <DisasmView key={"d" + (tab.seq ?? 0)} rows={dis.data.rows} showBytes={view !== "split"} cursorVA={tab.cursor} onCursor={setCursor} onNavigate={nav} focusVA={focus ?? (view === 'split' ? undefined : tab.cursor)} onPeek={onPeek}
      onContext={(e, info) => codeContext(e, info.va, info.target, tab.va)} />
  ) : <Loading err={dis.error} />;
  return (
    <>
      <div className="toolbar">
        <div className="seg" data-testid="viewseg">
          {([['code', 'Code', <I.code size={14} key="c" />], ['asm', 'Disassembly', <I.asm size={14} key="a" />], ['graph', 'Graph', <I.graph size={14} key="g" />], ['split', 'Split', <I.split size={14} key="s" />]] as const).map(([k, l, ic]) => (
            <button key={k} className={view === k ? 'on' : ''} title={l} onClick={() => updTab(tab.id, { view: k, preview: false })}>{ic}<span className="lbl">{l}</span></button>
          ))}
        </div>
        <div className="crumbs"><span>{tab.title.includes('.') ? tab.title.split('.')[0] : ''}</span>{tab.title.includes('.') && <I.chevron size={12} />}<b>{tab.title.split('.').pop()}</b><span className="mono faint">{hx(tab.va!)}</span></div>
        <div className="spacer" />
        {code.data?.errors?.length ? <span className="chip amber" title={code.data.errors.join('\n')}>{code.data.errors.length} note{code.data.errors.length > 1 ? 's' : ''}</span> : null}
        {code.data && code.data.lines.some(l => /\b(DispID|Method)_[0-9A-F]+/.test(l.text)) && (
          <button className="btn sm ghost" onClick={tlb} title="Some ActiveX members are unnamed. Load the control's .ocx/.tlb (e.g. C:\Windows\SysWOW64\MSCOMCTL.OCX) to name them." style={{ color: 'var(--warn)' }}><I.lib size={14} /><span className="lbl">Name ActiveX members…</span></button>
        )}
        <button className="btn sm ghost" onClick={() => showXrefs(tab.va!, tab.title)} title="Cross references (X)"><I.ref size={14} /><span className="lbl">Xrefs</span></button>
        <button className="btn sm ghost" onClick={() => rename(tab.va!)} title="Rename (N)"><I.tag size={14} /><span className="lbl">Rename</span></button>
        <button className="btn sm ghost" onClick={copy} title="Copy source"><I.copy size={14} /></button>
      </div>
      <div className="view">
        {view === 'code' && codeEl}
        {view === 'asm' && disEl}
        {view === 'graph' && (graph.data ? <GraphView graph={graph.data} onNavigate={va => nav(va)} onCursor={setCursor} cursorVA={tab.cursor} /> : <Loading err={graph.error} />)}
        {view === 'split' && <SplitPanes a={codeEl} b={disEl} />}
      </div>
    </>
  );
}

function SplitPanes({ a, b }: { a: React.ReactNode; b: React.ReactNode }) {
  const [r, setR] = useState(0.55);
  const host = useRef<HTMLDivElement>(null);
  return (
    <div className="split" ref={host} style={{ gridTemplateColumns: `${r}fr 4px ${1 - r}fr` }}>
      <div className="pane">{a}</div>
      <div className="sp" onMouseDown={e => {
        e.preventDefault();
        const rect = host.current!.getBoundingClientRect();
        const mv = (ev: MouseEvent) => setR(Math.max(0.2, Math.min(0.8, (ev.clientX - rect.left) / rect.width)));
        const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      }} />
      <div className="pane">{b}</div>
    </div>
  );
}

function Loading({ err }: { err?: string }) {
  return <div className="empty">{err ? <div className="err-banner">{err}</div> : <div className="spinner" />}</div>;
}

function ObjectBody({ tab, gen, updTab, navigate, makeResolver, onPeek, codeContext, openProc }: BodyProps) {
  const form = useRpc<FormView | undefined>('form', [tab.obj], gen);
  const hasForm = !!form.data?.root;
  const view = tab.view === 'designer' && form.data !== undefined && !hasForm && !form.loading ? 'code' : tab.view ?? 'code';
  const src = useRpc<CodeDoc>(view === 'code' ? 'objectSource' : undefined, [tab.obj], gen);
  const resolve = useMemo(() => makeResolver(tab.obj), [makeResolver, tab.obj]);
  const frmDoc = useMemo<CodeDoc | undefined>(() => form.data ? { title: form.data.name, header: '', lines: form.data.frm.split(/\r?\n/).map(t => ({ text: t.replace(/^\s+/, m => m), indent: 0 })), errors: [] } : undefined, [form.data]);
  return (
    <>
      <div className="toolbar">
        <div className="seg" data-testid="viewseg">
          {hasForm && <button className={view === 'designer' ? 'on' : ''} onClick={() => updTab(tab.id, { view: 'designer', preview: false })}><I.designer size={14} /><span className="lbl">Designer</span></button>}
          <button className={view === 'code' ? 'on' : ''} title="Code" onClick={() => updTab(tab.id, { view: 'code', preview: false })}><I.code size={14} /><span className="lbl">Code</span></button>
          {hasForm && <button className={view === 'frm' ? 'on' : ''} onClick={() => updTab(tab.id, { view: 'frm', preview: false })}><I.text size={14} /><span className="lbl">.frm source</span></button>}
        </div>
        <div className="crumbs"><b>{tab.title}</b>{form.data?.errors.length ? <span className="chip amber" title={form.data.errors.join('\n')}>{form.data.errors.length} parse notes</span> : null}</div>
      </div>
      <div className="view">
        {view === 'designer' && (form.data ? <FormDesigner form={form.data} selected={tab.sel} onSelect={c => updTab(tab.id, { sel: c ? (c.index !== undefined ? `${c.name}(${c.index})` : c.name) : undefined })} onOpenHandler={va => openProc(va, undefined, { pin: true })} /> : <Loading err={form.error} />)}
        {view === 'code' && (src.data ? <CodeView key={'o' + (tab.seq ?? 0)} doc={src.data} resolve={resolve} onNavigate={navigate} cursorVA={tab.cursor} onCursor={va => updTab(tab.id, { cursor: va })} onPeek={onPeek} focusVA={tab.focus} testId="code"
          onContext={(e, info) => codeContext(e, info.va, info.word ? resolve(info.word) : undefined)} /> : <Loading err={src.error} />)}
        {view === 'frm' && frmDoc && <CodeView doc={frmDoc} resolve={() => undefined} onNavigate={() => undefined} testId="frm" />}
      </div>
    </>
  );
}

/** Open the only reference directly; otherwise list them. */
async function openRefs(vas: number[], title: string, showXrefs: BodyProps['showXrefs'], navigate: BodyProps['navigate']) {
  const xs = await rpc.call<XrefItem[]>('xrefsToMany', [vas]).catch(() => []);
  if (xs.length === 1) navigate(xs[0].from); else showXrefs(vas, title);
}

function StringsBody({ tab, showXrefs, navigate, menu, openSingle, say }: BodyProps) {
  const r = useRpc<{ va: number; text: string; refs: number }[]>('strings', []);
  if (!r.data) return <Loading err={r.error} />;
  return (
    <div className="view">
      <DataTable rows={r.data} rowKey={x => x.va} focusKey={tab.focus} testId="strings" placeholder="Filter strings"
        cols={[
          { key: 'va', title: 'Address', width: 96, get: x => x.va, render: x => <span className="faint">{hex8(x.va)}</span>, mono: true },
          { key: 'text', title: 'String', get: x => x.text, render: x => <span className="t-str mono" dir="auto">{JSON.stringify(x.text)}</span> },
          { key: 'refs', title: 'Refs', width: 60, get: x => x.refs, align: 'right', mono: true },
        ]}
        openHint="Double-click or Enter: go to reference"
        onRow={x => openRefs([x.va], JSON.stringify(x.text.length > 40 ? x.text.slice(0, 40) + '…' : x.text), showXrefs, navigate)}
        onContext={(x, e) => menu(e, [
          { label: 'Go to reference', icon: <I.fwd size={14} />, key: 'Enter', run: () => openRefs([x.va], JSON.stringify(x.text.slice(0, 40)), showXrefs, navigate) },
          { label: 'All references', icon: <I.ref size={14} />, run: () => showXrefs(x.va, JSON.stringify(x.text.slice(0, 40))) },
          { label: 'Copy string', icon: <I.copy size={14} />, key: 'Ctrl+C', run: () => copyText(x.text).then(ok => say(ok ? 'String copied' : 'Could not access the clipboard', !ok)) },
          { label: 'Show in hex', icon: <I.hex size={14} />, run: () => openSingle('hex', x.va) },
        ])} />
    </div>
  );
}

function ImportsBody({ showXrefs, navigate, menu, say }: BodyProps) {
  const r = useRpc<{ dll: string; name: string; ordinal?: number; iat: number; uses: number; refs: number[] }[]>('imports', []);
  if (!r.data) return <Loading err={r.error} />;
  return (
    <div className="view">
      <DataTable rows={r.data} rowKey={x => x.iat} testId="imports" placeholder="Filter imports"
        cols={[
          { key: 'iat', title: 'IAT', width: 96, get: x => x.iat, render: x => <span className="faint">{hex8(x.iat)}</span>, mono: true },
          { key: 'dll', title: 'Library', width: 150, get: x => x.dll },
          { key: 'name', title: 'Function', get: x => x.name, render: x => <span className="t-fn mono">{x.name}</span> },
          { key: 'ord', title: 'Ordinal', width: 70, get: x => x.ordinal ?? '', align: 'right', mono: true },
          { key: 'uses', title: 'Uses', width: 60, get: x => x.uses, align: 'right', mono: true },
        ]}
        openHint="Double-click or Enter: references"
        onRow={x => openRefs([...x.refs, x.iat], x.name, showXrefs, navigate)}
        onContext={(x, e) => menu(e, [
          { label: 'References', icon: <I.ref size={14} />, key: 'Enter', run: () => showXrefs([...x.refs, x.iat], x.name) },
          { label: 'Copy name', icon: <I.copy size={14} />, run: () => copyText(x.name).then(ok => say(ok ? 'Copied' : 'Could not access the clipboard', !ok)) },
        ])} />
    </div>
  );
}

function DeclaresBody({ showXrefs, navigate, menu, say }: BodyProps) {
  const r = useRpc<{ index: number; lib: string; func: string; stub: number; uses: number }[]>('declares', []);
  if (!r.data) return <Loading err={r.error} />;
  return (
    <div className="view">
      <DataTable rows={r.data} rowKey={x => x.index} testId="declares" placeholder="Filter declares"
        cols={[
          { key: 'func', title: 'Declare Function', get: x => x.func, render: x => <span className="t-fn mono">{x.func}</span> },
          { key: 'lib', title: 'Lib', width: 200, get: x => x.lib, render: x => <span className="t-str mono">"{x.lib}"</span> },
          { key: 'stub', title: 'Stub', width: 96, get: x => x.stub, render: x => <span className="faint">{x.stub ? hex8(x.stub) : '—'}</span>, mono: true },
          { key: 'uses', title: 'Calls', width: 60, get: x => x.uses, align: 'right', mono: true },
        ]}
        openHint="Double-click or Enter: calls"
        onRow={x => { if (x.stub) openRefs([x.stub], x.func, showXrefs, navigate); else say(`${x.func} is never called`); }}
        onContext={(x, e) => menu(e, [
          { label: 'Calls', icon: <I.ref size={14} />, key: 'Enter', run: () => x.stub ? showXrefs(x.stub, x.func) : say(`${x.func} is never called`) },
          { label: 'Copy Declare statement', icon: <I.copy size={14} />, run: () => copyText(`Declare Function ${x.func} Lib "${x.lib}" ()`).then(ok => say(ok ? 'Copied' : 'Could not access the clipboard', !ok)) },
        ])} />
    </div>
  );
}

function ComponentsBody({ tlb }: BodyProps) {
  const r = useRpc<{ name: string; file: string; progId: string; guid: string }[]>('components', []);
  if (!r.data) return <Loading err={r.error} />;
  return (
    <div className="view">
      <DataTable rows={r.data} rowKey={x => x.guid + x.progId} testId="components" placeholder="Filter references"
        extra={<button className="btn sm" onClick={tlb}><I.lib size={14} />Load type library…</button>}
        cols={[
          { key: 'name', title: 'Component', width: 180, get: x => x.name },
          { key: 'progId', title: 'ProgID', width: 220, get: x => x.progId, mono: true },
          { key: 'file', title: 'File', width: 160, get: x => x.file, mono: true },
          { key: 'guid', title: 'GUID', get: x => x.guid, mono: true, render: x => <span className="faint">{x.guid}</span> },
        ]} />
    </div>
  );
}

function HexBody({ tab, navigate }: BodyProps) {
  const r = useRpc<Section[]>('hexRange', []);
  if (!r.data) return <Loading err={r.error} />;
  return <div className="view"><HexView sections={r.data} focusVA={tab.focus} onNavigate={navigate} /></div>;
}

function GrepBody({ tab, openProc }: BodyProps) {
  const r = useRpc<GrepHit[]>('grepCode', [tab.query, 500]);
  return <div className="view"><GrepView query={tab.query ?? ''} hits={r.data} loading={!r.data && !r.error} onOpen={(fva, va) => openProc(fva, va, { pin: true })} /></div>;
}

// ======================================================================================
function InspectorFor({ tab, ov, gen, navigate, rename }: { tab: Tab; ov: Loaded['overview']; gen: number; navigate: (va: number, n?: boolean) => void; rename: (va: number) => void }) {
  const info = useRpc<FuncInfo | undefined>(tab.kind === 'proc' ? 'funcInfo' : undefined, [tab.va], gen);
  const form = useRpc<FormView | undefined>(tab.kind === 'object' ? 'form' : undefined, [tab.obj], gen);
  if (tab.kind === 'proc') {
    if (!info.data && !info.loading) return <div className="insp"><div className="card"><h4>Raw code</h4><div className="muted" style={{ fontSize: 12.5 }}>{hx(tab.va!)} is not inside a recognised procedure (entry stub or runtime thunk).</div></div></div>;
    return <ProcInspector info={info.data} onNavigate={navigate} onRename={() => rename(tab.va!)} cursor={tab.cursor} />;
  }
  if (tab.kind === 'object' && form.data?.root) {
    const c: FormControlView | undefined = (tab.sel && findControl(form.data.root, tab.sel)) || form.data.root;
    return <ControlInspector key={c.name + c.index} c={c} formName={form.data.name} onNavigate={va => navigate(va, true)} />;
  }
  return <FileInspector ov={ov} />;
}
