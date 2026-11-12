// Whole-program analysis: names every procedure from the VB metadata,
// discovers remaining functions, resolves import/API thunks, finds string
// literals and builds cross references.

import { Image, hex } from '../pe/pe';
import type { VBProject, VBObject, VBDeclare } from '../vb/structures';
import { decode, Insn, branchTarget, isCall, isCondJmp, isRet, isUncondJmp } from '../x86/decoder';
import { runtimeOrdinalName } from './runtime';

export type FuncKind = 'event' | 'method' | 'proc' | 'main' | 'unknown';

export interface Func {
  va: number;
  end: number;
  name: string; // short name (e.g. Command1_Click)
  fullName: string; // Object.Name
  kind: FuncKind;
  obj: number; // object index or -1
  ctl?: string;
  event?: string;
  eventParams?: string[];
  methodIndex?: number;
  vtableOffset?: number;
  argBytes: number; // from "ret n"
  attributionGuess?: boolean; // module attribution is heuristic
  aliases: string[];
}

export type XrefKind = 'call' | 'jmp' | 'data' | 'str';
export interface Xref { from: number; kind: XrefKind; func: number }

export interface StringLit { va: number; text: string; kind: 'unicode' | 'ansi'; refs: number }

export interface Analysis {
  img: Image;
  project: VBProject;
  funcs: Func[];
  funcByVA: Map<number, Func>;
  iatNames: Map<number, string>; // IAT slot -> runtime/API name
  thunks: Map<number, string>; // jmp [IAT] thunk address -> name
  declareStubs: Map<number, VBDeclare>;
  strings: Map<number, StringLit>;
  xrefs: Map<number, Xref[]>;
  labels: Map<number, string>; // user/global labels
  globals: Map<number, string>; // data symbol names
  globalTypes: Map<number, number>; // global variable -> project object index (predeclared instances, New)
  globalIfaces: Map<number, string>; // global variable -> interface IID (external classes created with New)
  objectRanges: { obj: number; start: number; end: number }[];
  stats: { instructions: number; ms: number };
}

const isPrologue = (b: Uint8Array, o: number) => b[o] === 0x55 && b[o + 1] === 0x8b && b[o + 2] === 0xec;

export function analyze(img: Image, project: VBProject, progress?: (msg: string, pct: number) => void): Analysis {
  const t0 = Date.now();
  const an: Analysis = {
    img, project, funcs: [], funcByVA: new Map(), iatNames: new Map(), thunks: new Map(), declareStubs: new Map(),
    strings: new Map(), xrefs: new Map(), labels: new Map(), globals: new Map(), globalTypes: new Map(), globalIfaces: new Map(), objectRanges: [],
    stats: { instructions: 0, ms: 0 },
  };
  progress?.('Resolving imports', 0.05);
  for (const imp of img.imports) {
    let name = imp.name ?? (imp.ordinal !== null ? runtimeOrdinalName(imp.dll, imp.ordinal) : undefined) ?? `${imp.dll}#${imp.ordinal}`;
    if (!/msvbvm/i.test(imp.dll)) name = `${imp.dll.replace(/\.dll$/i, '')}.${name}`;
    an.iatNames.set(imp.iatVA, name);
  }
  // Import thunks (jmp dword ptr [IAT]) and Declare stubs anywhere in executable sections
  const text = img.sections.filter(s => s.executable);
  for (const s of text) {
    const b = img.bytes;
    const start = s.rawOffset, end = s.rawOffset + Math.min(s.rawSize, s.vsize || s.rawSize);
    for (let o = start; o + 6 <= end; o++) {
      if (b[o] === 0xff && b[o + 1] === 0x25) {
        const iat = (b[o + 2] | b[o + 3] << 8 | b[o + 4] << 16 | b[o + 5] << 24) >>> 0;
        const n = an.iatNames.get(iat);
        if (n) an.thunks.set(s.va + (o - s.rawOffset), n);
      }
    }
  }
  // Declare stubs:  A1 xx xx xx xx 0B C0 74 02 FF E0 68 <info> B8 <DllFunctionCall> FF D0 FF E0
  const declByEntry = new Map<number, VBDeclare>();
  for (const d of project.declares) declByEntry.set(d.entryVA, d);
  for (const s of text) {
    const b = img.bytes;
    const start = s.rawOffset, end = s.rawOffset + s.rawSize;
    for (let o = start; o + 25 <= end; o++) {
      if (b[o] === 0xa1 && b[o + 5] === 0x0b && b[o + 6] === 0xc0 && b[o + 7] === 0x74 && b[o + 9] === 0xff && b[o + 10] === 0xe0 && b[o + 11] === 0x68) {
        const info = (b[o + 12] | b[o + 13] << 8 | b[o + 14] << 16 | b[o + 15] << 24) >>> 0;
        const d = declByEntry.get(info);
        if (d) an.declareStubs.set(s.va + (o - s.rawOffset), d);
      }
    }
  }

  progress?.('Naming procedures', 0.15);
  // --- VB metadata derived procedures -----------------------------------------
  const named = new Map<number, Func>();
  const add = (f: Omit<Func, 'end' | 'argBytes' | 'aliases'>) => {
    const ex = named.get(f.va);
    if (ex) {
      // prefer event names over anonymous methods
      if (ex.kind === 'method' && f.kind === 'event') { const al = ex.aliases; Object.assign(ex, f); ex.aliases = al; }
      else if (ex.fullName !== f.fullName) ex.aliases.push(f.fullName);
      return;
    }
    named.set(f.va, { ...f, end: 0, argBytes: 0, aliases: [] });
  };
  const objs = project.objects;
  for (const o of objs) {
    for (const c of o.controls) {
      for (const e of c.events) {
        if (!e.targetVA || !img.isMapped(e.targetVA)) continue;
        const isSelf = ['Form', 'MDIForm', 'UserControl', 'PropertyPage', 'UserDocument', 'Class'].includes(c.className);
        const ctlName = isSelf ? (c.className === 'Class' ? 'Class' : c.className === 'MDIForm' ? 'MDIForm' : c.className) : c.name;
        const name = `${ctlName}_${e.name}`;
        add({ va: e.targetVA, name, fullName: `${o.name}.${name}`, kind: 'event', obj: o.index, ctl: c.name, event: e.name });
      }
    }
    for (const m of o.methods) {
      if (!img.isMapped(m.targetVA)) continue;
      const name = m.name ?? `Proc_${o.index}_${m.index}_${hex(m.targetVA)}`;
      add({ va: m.targetVA, name, fullName: `${o.name}.${name}`, kind: 'method', obj: o.index, methodIndex: m.index, vtableOffset: m.vtableOffset });
    }
  }
  if (project.subMainVA && img.isMapped(project.subMainVA)) {
    add({ va: project.subMainVA, name: 'Main', fullName: 'Main', kind: 'main', obj: -1 });
  }

  // --- Function discovery ---------------------------------------------------------
  progress?.('Discovering functions', 0.25);
  const starts = new Set<number>(named.keys());
  const cs = project.codeStart, ce = project.codeEnd;
  const codeOk = (va: number) => va >= cs && va < ce;
  {
    const o0 = img.offsetOf(cs);
    if (o0 >= 0) {
      const b = img.bytes;
      for (let va = cs; va < ce; va++) {
        const o = o0 + (va - cs);
        if (o + 3 > b.length) break;
        if ((va & 0xf) === 0 && isPrologue(b, o)) starts.add(va);
      }
    }
  }
  // follow direct calls to grow the set (handles unaligned / non-standard prologues)
  const sweep = (from: number, to: number, cb: (i: Insn) => void) => {
    const off = img.offsetOf(from);
    if (off < 0) return 0;
    const b = img.bytes;
    let va = from, n = 0;
    while (va < to) {
      const o = off + (va - from);
      if (o >= b.length) break;
      const i = decode(b, o, va);
      cb(i);
      va += i.len;
      n++;
    }
    return n;
  };
  let sorted = [...starts].filter(codeOk).sort((a, b) => a - b);
  const extraCalls = new Set<number>();
  for (let k = 0; k < sorted.length; k++) {
    const s = sorted[k], e = k + 1 < sorted.length ? sorted[k + 1] : ce;
    sweep(s, e, i => {
      if (i.mn === 'call' && i.ops[0]?.t === 'j') {
        const t = i.ops[0].v!;
        if (codeOk(t) && !starts.has(t)) extraCalls.add(t);
      }
    });
  }
  for (const t of extraCalls) starts.add(t);
  sorted = [...starts].filter(codeOk).sort((a, b) => a - b);

  // --- Object code ranges (for module attribution) ----------------------------------
  const objRange = new Map<number, { min: number; max: number }>();
  for (const f of named.values()) {
    if (f.obj < 0 || f.kind === 'main') continue;
    const r = objRange.get(f.obj);
    if (!r) objRange.set(f.obj, { min: f.va, max: f.va });
    else { r.min = Math.min(r.min, f.va); r.max = Math.max(r.max, f.va); }
  }

  progress?.('Building function list', 0.35);
  for (let k = 0; k < sorted.length; k++) {
    const va = sorted[k];
    const end = k + 1 < sorted.length ? sorted[k + 1] : ce;
    let f = named.get(va);
    if (!f) f = { va, end, name: `sub_${hex(va)}`, fullName: `sub_${hex(va)}`, kind: 'unknown', obj: -1, argBytes: 0, aliases: [] };
    f.end = end;
    an.funcs.push(f);
    an.funcByVA.set(va, f);
  }
  attributeModules(an, objRange);

  // --- Global sweep: xrefs, strings, ret sizes ----------------------------------------
  progress?.('Cross-referencing', 0.45);
  let nIns = 0;
  const addX = (to: number, x: Xref) => { const l = an.xrefs.get(to); if (l) l.push(x); else an.xrefs.set(to, [x]); };
  const total = an.funcs.length;
  an.funcs.forEach((f, idx) => {
    if (idx % 500 === 0) progress?.('Cross-referencing', 0.45 + 0.45 * (idx / total));
    let lastRet = 0;
    let p1 = -1, p2 = -1;
    nIns += sweep(f.va, f.end, i => {
      if (i.mn === 'push' && i.ops[0].t === 'i') { p1 = p2; p2 = i.ops[0].v!; }
      else if (i.mn === 'call') {
        const o = i.ops[0];
        const nm = o.t === 'm' && !o.base && o.disp !== undefined ? an.iatNames.get(o.disp >>> 0) : o.t === 'j' ? an.thunks.get(o.v!) : undefined;
        if (nm === '__vbaNew2' && p1 > 0 && p2 > 0) {
          const obj = project.objects.find(x => x.infoVA === p2);
          if (obj && !an.globalTypes.has(p1)) { an.globalTypes.set(p1, obj.index); if (obj.kind !== 'Class') an.globals.set(p1, obj.name); }
          else if (!obj && img.u32(p2) >= 1 && img.u32(p2) <= 3 && img.isMapped(img.u32(p2 + 4))) {
            const clsid = img.guid(img.u32(p2 + 4));
            const iid = img.isMapped(img.u32(p2 + 8)) ? img.guid(img.u32(p2 + 8)) : '';
            if (iid && !an.globalIfaces.has(p1)) an.globalIfaces.set(p1, iid);
            if (clsid === '{FCFB3D23-A0FA-1068-A738-08002B3371B5}') an.globals.set(p1, 'Global');
          }
        }
        p1 = p2 = -1;
      } else if (i.mn !== 'mov' && i.mn !== 'lea') { p1 = p2 = -1; }
      if (i.mn === 'ret') lastRet = i.ops[0]?.v ?? 0;
      if (i.mn === 'ret' && !f.argBytes) f.argBytes = i.ops[0]?.v ?? 0;
      const tgt = branchTarget(i);
      if (tgt !== undefined) {
        addX(tgt, { from: i.va, kind: isCall(i) ? 'call' : 'jmp', func: f.va });
        return;
      }
      for (const op of i.ops) {
        let a: number | undefined;
        if (op.t === 'i' && op.sz === 4) a = op.v;
        else if (op.t === 'm' && !op.base && !op.idx && op.disp !== undefined) a = op.disp >>> 0;
        if (a === undefined || !img.inImage(a)) continue;
        const st = probeString(img, a);
        if (st) {
          const ex = an.strings.get(a);
          if (ex) ex.refs++; else an.strings.set(a, { ...st, va: a, refs: 1 });
          addX(a, { from: i.va, kind: 'str', func: f.va });
        } else addX(a, { from: i.va, kind: 'data', func: f.va });
      }
    });
    void lastRet;
  });
  an.stats.instructions = nIns;
  nameGlobals(an);
  an.stats.ms = Date.now() - t0;
  progress?.('Done', 1);
  return an;
}

/** Recognize VB string literals: UTF-16 text preceded by its byte length (BSTR layout). */
export function probeString(img: Image, va: number): { text: string; kind: 'unicode' | 'ansi' } | undefined {
  if (!img.isMapped(va - 4)) return undefined;
  const len = img.u32(va - 4);
  // literals live in read-only sections; .data is full of zeros that would look like ""
  const sec = img.sections.find(s => va >= s.va && va < s.va + s.vsize);
  const readOnly = !!sec && (sec.characteristics & 0x80000000) === 0;
  if (len === 0) {
    // empty BSTR literal: zero length prefix followed by a NUL terminator
    if (readOnly && img.u16(va) === 0) return { text: '', kind: 'unicode' };
    return undefined;
  }
  if (len > 0 && len < 0x20000 && (len & 1) === 0) {
    const n = len / 2;
    if (img.u16(va + len) !== 0) return undefined;
    let s = '';
    let ctl = 0;
    for (let i = 0; i < n; i++) {
      const c = img.u16(va + i * 2);
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) ctl++;
      s += String.fromCharCode(c);
    }
    // short literals made of control characters (vbNullChar, Chr(1)...) are common;
    // longer runs of binary data are not strings
    if (ctl && !(readOnly && n <= 4 && ctl === n)) return undefined;
    return { text: s, kind: 'unicode' };
  }
  return undefined;
}

function attributeModules(an: Analysis, objRange: Map<number, { min: number; max: number }>) {
  const objs = an.project.objects;
  // Ordered anchor list: designer/class objects with known code ranges, in object order
  const anchors = [...objRange.entries()].map(([obj, r]) => ({ obj, ...r })).sort((a, b) => a.obj - b.obj);
  // Fix up ranges: an object's code ends where the next anchor's begins
  an.objectRanges = anchors.map(a => ({ obj: a.obj, start: a.min, end: a.max }));
  const modules = objs.filter(o => o.kind === 'Module');
  if (!modules.length) return;
  // Module data regions (public + static variables) to score data references
  const regions = modules
    .flatMap(m => [m.modulePublicVA, m.moduleStaticVA].filter(v => v && an.img.isMapped(v)).map(v => ({ va: v, obj: m.index })))
    .sort((a, b) => a.va - b.va);
  const regionOf = (a: number) => {
    let lo = 0, hi = regions.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (regions[mid].va <= a) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 && a - regions[best].va < 0x10000 ? regions[best].obj : -1;
  };
  // Walk functions in address order; a run of functions between two anchored
  // objects belongs to the modules whose object index lies between them.
  const anchorByFunc = new Map<number, number>();
  for (const f of an.funcs) if (f.obj >= 0 && f.kind !== 'main') anchorByFunc.set(f.va, f.obj);
  const funcs = an.funcs;
  let i = 0;
  while (i < funcs.length) {
    if (anchorByFunc.has(funcs[i].va)) { i++; continue; }
    // collect a run of non-anchored functions
    let j = i;
    while (j < funcs.length && !anchorByFunc.has(funcs[j].va)) j++;
    const prevObj = i > 0 ? anchorByFunc.get(funcs[i - 1].va)! : -1;
    const nextObj = j < funcs.length ? anchorByFunc.get(funcs[j].va)! : objs.length;
    const cands = modules.filter(m => m.index > prevObj && m.index < nextObj);
    const run = funcs.slice(i, j);
    if (cands.length === 1) {
      for (const f of run) assign(f, cands[0], false);
    } else if (cands.length > 1) {
      // Dynamic programming over (module, procedures used so far): functions
      // keep their address order, modules keep their object order, a module
      // holds at most its declared member count (procedures + declares) and
      // references to a module's own variables pull functions towards it.
      const scores = run.map(f => {
        const hits = new Map<number, number>();
        sweepRefs(an, f, a => { const r = regionOf(a); if (r >= 0) hits.set(r, (hits.get(r) ?? 0) + 1); });
        return hits;
      });
      const n = run.length, k = cands.length;
      const cap = cands.map(m => Math.max(1, m.methodCount));
      const gain = (x: number, m: number) => {
        const h = scores[x];
        const own = h.get(cands[m].index) ?? 0;
        return Math.min(own, 8);
      };
      // state: dp[m][c] = best score with current function in module m as its c-th procedure
      type Cell = { v: number; pm: number; pc: number };
      const NEG: Cell = { v: -Infinity, pm: -1, pc: -1 };
      const hist: Cell[][][] = [];
      let prev: Cell[][] = cands.map((_, m) => {
        const row = new Array(cap[m] + 2).fill(NEG) as Cell[];
        row[1] = { v: gain(0, m) - m * 0.01, pm: -1, pc: -1 };
        return row;
      });
      hist.push(prev);
      for (let x = 1; x < n; x++) {
        const curr: Cell[][] = cands.map((_, m) => new Array(cap[m] + 2).fill(NEG) as Cell[]);
        // best over modules < m (any count) for "start new module"
        let bestBefore: Cell = NEG;
        for (let m = 0; m < k; m++) {
          const g = gain(x, m);
          // start new module m
          if (bestBefore.v > -Infinity) curr[m][1] = { v: bestBefore.v + g, pm: bestBefore.pm, pc: bestBefore.pc };
          // continue module m
          for (let c = 1; c <= cap[m]; c++) {
            const pv = prev[m][c];
            if (pv.v === -Infinity) continue;
            const over = c + 1 > cap[m];
            const nc = Math.min(c + 1, cap[m] + 1);
            const v = pv.v + g - (over ? 6 : 0);
            if (v > curr[m][nc].v) curr[m][nc] = { v, pm: m, pc: c };
          }
          const over2 = prev[m][cap[m] + 1];
          if (over2.v > -Infinity) {
            const v = over2.v + g - 6;
            if (v > curr[m][cap[m] + 1].v) curr[m][cap[m] + 1] = { v, pm: m, pc: cap[m] + 1 };
          }
          for (let c = 1; c <= cap[m] + 1; c++) if (prev[m][c].v > bestBefore.v) bestBefore = { v: prev[m][c].v, pm: m, pc: c };
        }
        hist.push(curr);
        prev = curr;
      }
      // backtrack
      let bm = 0, bc = 1, bv = -Infinity;
      for (let m = 0; m < k; m++) for (let c = 1; c <= cap[m] + 1; c++) if (prev[m][c].v > bv) { bv = prev[m][c].v; bm = m; bc = c; }
      for (let x = n - 1; x >= 0; x--) {
        assign(run[x], cands[bm], true);
        const cell = hist[x][bm][bc];
        bm = cell.pm; bc = cell.pc;
        if (bm < 0) { for (let y = x - 1; y >= 0; y--) assign(run[y], cands[0], true); break; }
      }
    }
    i = j;
  }
  function assign(f: Func, m: VBObject, guess: boolean) {
    f.obj = m.index;
    f.attributionGuess = guess;
    if (f.kind === 'unknown') {
      f.kind = 'proc';
      f.name = `Proc_${m.index}_${hex(f.va)}`;
    }
    f.fullName = `${m.name}.${f.name}`;
  }
}

function sweepRefs(an: Analysis, f: Func, cb: (a: number) => void) {
  const img = an.img;
  const off = img.offsetOf(f.va);
  if (off < 0) return;
  let va = f.va;
  while (va < f.end) {
    const i = decode(img.bytes, off + (va - f.va), va);
    for (const op of i.ops) if (op.t === 'm' && !op.base && !op.idx && op.disp !== undefined) cb(op.disp >>> 0);
    va += i.len;
  }
}

function nameGlobals(an: Analysis) {
  // Name module-level variables by owning module and offset
  const mods = an.project.objects
    .flatMap(o => [{ va: o.modulePublicVA, o, kind: 'pub' }, { va: o.moduleStaticVA, o, kind: 'st' }])
    .filter(x => x.va && an.img.isMapped(x.va))
    .sort((a, b) => a.va - b.va);
  for (const [a, xs] of an.xrefs) {
    if (!xs.some(x => x.kind === 'data')) continue;
    if (an.funcByVA.has(a) || an.thunks.has(a) || an.iatNames.has(a) || an.globals.has(a)) continue;
    let best: (typeof mods)[number] | undefined;
    for (const m of mods) { if (m.va <= a) best = m; else break; }
    if (best && a - best.va < 0x4000) {
      const prefix = best.o.kind === 'Module' ? '' : 'm_';
      an.globals.set(a, `${prefix}${best.o.name}_var_${hex(a - best.va)}`.replace(/^m_/, ''));
    }
  }
}

// --- Per function disassembly & CFG ---------------------------------------------------

export interface Block { start: number; end: number; insns: Insn[]; succ: number[]; kind: 'normal' | 'cleanup' | 'handler' }
export interface FuncCode { func: Func; insns: Insn[]; blocks: Block[]; byVA: Map<number, Insn>; unreached: { start: number; end: number }[] }

export function disassembleFunction(an: Analysis, f: Func): FuncCode {
  const img = an.img;
  const off0 = img.offsetOf(f.va);
  const byVA = new Map<number, Insn>();
  const inF = (a: number) => a >= f.va && a < f.end;
  const seeds: number[] = [f.va];
  const leaders = new Set<number>([f.va]);
  const extraSucc = new Map<number, number[]>(); // jmp va -> extra successors (funclet return)
  const seen = new Set<number>();
  // SEH descriptor addresses (error handler / resume labels) from "mov [ebp-0x14|0x10], imm"
  const visit = (start: number) => {
    let va = start;
    while (inF(va) && !seen.has(va)) {
      seen.add(va);
      const i = decode(img.bytes, off0 + (va - f.va), va);
      byVA.set(va, i);
      if (i.bad) break;
      // VB SEH descriptor: mov dword ptr [ebp - 0x14 / -0x10], imm32
      if (i.mn === 'mov' && i.ops[0]?.t === 'm' && i.ops[0].base === 'ebp' && (i.ops[0].disp === -0x14 || i.ops[0].disp === -0x10) && i.ops[1]?.t === 'i') {
        const d = i.ops[1].v!;
        if (img.isMapped(d) && !inF(d)) {
          for (let k = 0; k < 16; k++) {
            const p = img.u32(d + k * 4);
            if (inF(p) && !leaders.has(p)) { leaders.add(p); seeds.push(p); }
          }
        }
      }
      if (i.mn === 'push' && i.ops[0]?.t === 'i' && inF(i.ops[0].v!)) {
        const t = i.ops[0].v!;
        if (!leaders.has(t)) { leaders.add(t); seeds.push(t); }
        // "push L; jmp cleanup" => L is the continuation after the funclet returns
        const nx = decode(img.bytes, off0 + (va + i.len - f.va), va + i.len);
        if (nx.mn === 'jmp') extraSucc.set(va + i.len, [t]);
      }
      const tgt = branchTarget(i);
      if (isCondJmp(i)) {
        if (tgt !== undefined && inF(tgt)) { leaders.add(tgt); seeds.push(tgt); }
        leaders.add(va + i.len);
      } else if (isUncondJmp(i)) {
        if (tgt !== undefined && inF(tgt)) { leaders.add(tgt); seeds.push(tgt); }
        // jump tables: jmp dword ptr [reg*4 + table]
        const m = i.ops[0];
        if (m?.t === 'm' && m.idx && m.sc === 4 && m.disp !== undefined && !m.base) {
          for (let k = 0; k < 1024; k++) {
            const e = img.u32((m.disp >>> 0) + k * 4);
            if (!inF(e)) break;
            if (!leaders.has(e)) { leaders.add(e); seeds.push(e); }
          }
        }
        break;
      } else if (isRet(i)) break;
      if (isCall(i) && tgt !== undefined && an.thunks.get(tgt) && /__vbaErrorOverflow|__vbaGenerateBoundsError|__vbaFailedFriend|__vbaEnd$/.test(an.thunks.get(tgt)!)) {
        // no-return runtime helpers
        leaders.add(va + i.len);
      }
      va += i.len;
    }
  };
  for (let k = 0; k < seeds.length; k++) visit(seeds[k]);
  const insns = [...byVA.values()].sort((a, b) => a.va - b.va);
  // Blocks
  const blocks: Block[] = [];
  let cur: Block | undefined;
  for (let k = 0; k < insns.length; k++) {
    const i = insns[k];
    if (!cur || leaders.has(i.va) || (k > 0 && insns[k - 1].va + insns[k - 1].len !== i.va)) {
      if (cur) {
        const last = cur.insns[cur.insns.length - 1];
        if (!isUncondJmp(last) && !isRet(last) && last.va + last.len === i.va) cur.succ.push(i.va);
      }
      cur = { start: i.va, end: i.va + i.len, insns: [], succ: [], kind: 'normal' };
      blocks.push(cur);
    }
    cur.insns.push(i);
    cur.end = i.va + i.len;
    const t = branchTarget(i);
    if (isCondJmp(i)) { if (t !== undefined && inF(t)) cur.succ.push(t); }
    else if (isUncondJmp(i)) {
      if (t !== undefined && inF(t)) cur.succ.push(t);
      const ex = extraSucc.get(i.va);
      if (ex) cur.succ.push(...ex);
    }
  }
  for (const b of blocks) b.succ = [...new Set(b.succ)];
  // classify cleanup funclets (end in plain ret, reached via push/jmp)
  const retTargets = new Set<number>();
  for (const ex of extraSucc.values()) ex.forEach(v => retTargets.add(v));
  const unreached: { start: number; end: number }[] = [];
  let p = f.va;
  for (const i of insns) { if (i.va > p) unreached.push({ start: p, end: i.va }); p = Math.max(p, i.va + i.len); }
  if (p < f.end) unreached.push({ start: p, end: f.end });
  return { func: f, insns, blocks, byVA, unreached };
}

/** Name for an address (used by the formatter and decompiler). */
export function symbolName(an: Analysis, va: number): string | undefined {
  const l = an.labels.get(va);
  if (l) return l;
  const f = an.funcByVA.get(va);
  if (f) return f.fullName;
  const t = an.thunks.get(va);
  if (t) return t;
  const iat = an.iatNames.get(va);
  if (iat) return iat;
  const d = an.declareStubs.get(va);
  if (d) return `${d.func}`;
  return an.globals.get(va);
}

export function funcContaining(an: Analysis, va: number): Func | undefined {
  const fs = an.funcs;
  let lo = 0, hi = fs.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fs[m].va <= va) { best = m; lo = m + 1; } else hi = m - 1; }
  if (best < 0) return undefined;
  const f = fs[best];
  return va < f.end ? f : undefined;
}
