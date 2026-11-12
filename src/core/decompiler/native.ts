// Native-code (x86) to Visual Basic decompiler.
//
// Pipeline per procedure:
//   1. disassemble + CFG (analysis.disassembleFunction)
//   2. remove VB compiler noise edges (HRESULT checks, overflow and bounds traps,
//      cleanup funclets reached through "push ret; jmp cleanup")
//   3. symbolic execution of every block: registers, stack/frame slots and the
//      FPU stack are tracked as expressions; calls into MSVBVM60 are rewritten
//      into VB statements/expressions using the runtime knowledge in runtime.ts
//   4. structuring of the CFG into If/Else/Do-Loop blocks (fallback: GoTo)
//   5. temp inlining and pretty-printing.

import type { Analysis, Block, Func, FuncCode } from '../analysis/analysis';
import { disassembleFunction, symbolName } from '../analysis/analysis';
import type { Insn, Operand } from '../x86/decoder';
import { hex } from '../pe/pe';
import { C, CALL, E, RAW, S, Stmt, V, isPure, negate, printE, trimArgs, unref, walkE } from './ir';
import { runtimeCall, RtCtx } from './runtime';
import { arrayElement } from './linear';
import { INTERFACES_BY_GUID, lookupMember, IfaceInfo, VB_CLASSES_BY_NAME, KnownClass } from '../data/vbclasses';
import type { VBObject } from '../vb/structures';
import type { ParsedForm } from '../vb/forms';

export interface Line { text: string; va?: number; indent: number; kind?: 'code' | 'comment' | 'label' | 'decl' | 'header' }
export interface DecompileResult { lines: Line[]; header: string; errors: string[]; stats: { blocks: number; statements: number; gotos: number } }

export interface DecompileEnv {
  forms?: Map<number, ParsedForm>; // object index -> parsed form (control getter names)
}

type AssignStmt = Extract<Stmt, { k: 'assign' }>;

interface Flags {
  k: 'cmp' | 'test' | 'res' | 'fcmp' | 'none' | 'neg';
  a?: E;
  b?: E;
  sahf?: boolean;
  fmask?: number; // test ah, mask after fnstsw
  sz?: number;
}

interface State {
  regs: Record<string, E | undefined>;
  esp: number;
  slots: Map<number, E>;
  fpu: E[];
  flags: Flags;
  pushes: number[]; // offsets of pending pushes (for arity fallback)
}

const REG32: Record<string, string> = {
  eax: 'eax', ax: 'eax', al: 'eax', ah: 'eax', ecx: 'ecx', cx: 'ecx', cl: 'ecx', ch: 'ecx', edx: 'edx', dx: 'edx', dl: 'edx', dh: 'edx',
  ebx: 'ebx', bx: 'ebx', bl: 'ebx', bh: 'ebx', esi: 'esi', si: 'esi', edi: 'edi', di: 'edi', ebp: 'ebp', bp: 'ebp', esp: 'esp', sp: 'esp',
};

const NOISE_FUNCS = /^(__vbaHresultCheckObj|__vbaHresultCheck|__vbaErrorOverflow|__vbaGenerateBoundsError|__vbaFPException|__vbaFailedFriend)$/;

const hiddenRetCache = new WeakMap<Analysis, Map<number, boolean>>();
/** Cheap scan: does this object method write its result through the hidden last
 *  [out, retval] pointer? (every load of that argument is followed by a store through it) */
export function hasHiddenRet(an: Analysis, f: Func): boolean {
  let m = hiddenRetCache.get(an);
  if (!m) { m = new Map(); hiddenRetCache.set(an, m); }
  const c = m.get(f.va);
  if (c !== undefined) return c;
  let res = false;
  const nargs = f.argBytes / 4 - 1;
  const obj = f.obj >= 0 ? an.project.objects[f.obj] : undefined;
  if (nargs >= 1 && obj && obj.kind !== 'Module' && f.kind === 'method') {
    const off = 8 + nargs * 4; // [ebp + off] = last argument
    const fc = disassembleFunction(an, f);
    let writes = 0, other = false;
    for (let k = 0; k < fc.insns.length && !other; k++) {
      const i = fc.insns[k];
      const src = i.ops[1];
      const reads = i.ops.some((o, j) => o.t === 'm' && o.base === 'ebp' && !o.idx && o.disp === off && !(j === 0 && i.mn === 'mov'));
      if (!reads) continue;
      if (i.mn !== 'mov' || i.ops[0].t !== 'r' || !src || src.t !== 'm') { other = true; break; }
      const r = i.ops[0].r;
      let ok = false;
      for (let j = k + 1; j < Math.min(fc.insns.length, k + 6); j++) {
        const n = fc.insns[j];
        if (n.mn === 'mov' && n.ops[0].t === 'm' && n.ops[0].base === r && !n.ops[0].idx) { ok = true; writes++; }
        else if (n.ops.some(o => (o.t === 'r' && o.r === r) || (o.t === 'm' && (o.base === r || o.idx === r)))) { if (n.ops[0].t === 'r' && n.ops[0].r === r && n.mn === 'mov') break; other = true; break; }
      }
      if (!ok) other = true;
    }
    res = writes > 0 && !other;
  }
  m.set(f.va, res);
  return res;
}

/** Marker for frame slots cleared by the prologue (variables, not literal temps). */
const ZERO_INIT: E = C(0);

export class NativeDecompiler {
  an: Analysis;
  f: Func;
  fc: FuncCode;
  env: DecompileEnv;
  obj?: VBObject;
  isObjMethod: boolean;
  stmts: Stmt[] = [];
  blockStmts = new Map<number, Stmt[]>();
  blockCond = new Map<number, { cond: E; taken: number; fall: number } | undefined>();
  succ = new Map<number, number[]>();
  blocks = new Map<number, Block>();
  errors: string[] = [];
  iidAt = new Map<number, string>(); // call-site va -> IID
  localTypes = new Map<string, string>();
  localsBottom = 0;
  frameTop = -0x0c; // ebp-relative bookkeeping area (entry-relative offsets) [frameTop, 0)
  inPrologue = false;
  consumed = new Set<Stmt>();
  backTargets = new Set<number>();
  nextInsn?: Insn;
  labelNames = new Map<number, string>();
  tmpCounter = 0;
  usedLabels = new Set<number>();
  onErrorSeen = false;
  argNames = new Map<number, string>();
  retVals: { eax?: E; va: number; fpu?: E }[] = [];
  freedSlots = new Set<number>();

  constructor(an: Analysis, f: Func, env: DecompileEnv = {}) {
    this.an = an;
    this.f = f;
    this.env = env;
    this.fc = disassembleFunction(an, f);
    this.obj = f.obj >= 0 ? an.project.objects[f.obj] : undefined;
    this.isObjMethod = !!this.obj && this.obj.kind !== 'Module' && (f.kind === 'event' || f.kind === 'method');
    for (const b of this.fc.blocks) this.blocks.set(b.start, b);
    // parameter names (events have typed parameters)
    let argOff = this.isObjMethod ? 12 : 8;
    if (f.eventParams) for (const p of f.eventParams) { this.argNames.set(argOff - 4, p.split(' ')[0]); argOff += 4; }
    else if (f.event && this.obj) {
      const ctl = this.obj.controls.find(c => c.name === f.ctl);
      const cls = ctl && (VB_CLASSES_BY_NAME[ctl.className]);
      const slot = cls ? cls.events.indexOf(f.event) : -1;
      const params = cls && slot >= 0 ? cls.eventParams[slot] : undefined;
      if (ctl?.isArray) { this.argNames.set(argOff - 4, 'Index'); argOff += 4; }
      if (params) for (const p of params) { this.argNames.set(argOff - 4, p.split(' ')[0] || `arg_${hex(argOff)}`); argOff += 4; }
    }
  }

  // --- naming ------------------------------------------------------------------
  slotName(o: number): string {
    // o is relative to the entry stack pointer; ebp = entry - 4
    if (o === 4 && this.isObjMethod) return 'Me';
    if (o >= 4) return this.argNames.get(o) ?? `arg_${hex(o + 4)}`;
    return `var_${hex(-(o + 4))}`;
  }
  slotE(o: number): E { return V(this.slotName(o), 'slot:' + o); }

  globalName(a: number): string {
    return symbolName(this.an, a) ?? `global_${hex(a)}`;
  }

  // --- pre-analysis ----------------------------------------------------------------
  private scanIIDs() {
    const ins = this.fc.insns;
    const img = this.an.img;
    const byVA = this.fc.byVA;
    for (let k = 0; k < ins.length; k++) {
      const i = ins[k];
      if (i.mn !== 'call' || i.ops[0].t !== 'm' || !i.ops[0].base || i.ops[0].idx) continue;
      const off = i.ops[0].disp ?? 0;
      // follow up to 40 instructions (and one jmp) looking for: push off ... push iid ... HresultCheckObj
      let va = i.va + i.len, sawOff = false, jumps = 0;
      for (let n = 0; n < 40; n++) {
        const q = byVA.get(va);
        if (!q) break;
        if (q.mn === 'push' && q.ops[0].t === 'i') {
          const v = q.ops[0].v!;
          if (!sawOff && v === (off >>> 0)) sawOff = true;
          else if (sawOff && img.isMapped(v) && !this.an.funcByVA.has(v)) {
            const g = img.guid(v);
            if (g) this.iidAt.set(i.va, g);
            break;
          }
        }
        if (q.mn === 'jmp' && q.ops[0].t === 'j') { if (++jumps > 1) break; va = q.ops[0].v!; continue; }
        if (q.mn === 'ret') break;
        va = q.va + q.len;
      }
    }
  }

  /** Name of the runtime/import function called by an instruction, if any. */
  private callName(i: Insn, st: State): string | undefined {
    const o = i.ops[0];
    if (o.t === 'j') return this.an.thunks.get(o.v!);
    if (o.t === 'm' && !o.base && !o.idx && o.disp !== undefined) return this.an.iatNames.get(o.disp >>> 0);
    if (o.t === 'r') {
      const v = st.regs[REG32[o.r!]];
      if (v && v.k === 'raw' && v.t.startsWith('@import:')) return v.t.slice(8);
      // value lost at a join: if this register only ever caches one import here, it's that one
      if (!v || v.k === 'reg' || (v.k === 'v' && v.n === REG32[o.r!])) {
        const cand = this.regImports.get(REG32[o.r!]);
        if (cand && cand.size === 1) return [...cand][0];
      }
    }
    return undefined;
  }
  private _regImports?: Map<string, Set<string>>;
  /** Imports loaded into each register anywhere in the procedure (mov reg, [IAT]). */
  get regImports(): Map<string, Set<string>> {
    if (!this._regImports) {
      const m = new Map<string, Set<string>>();
      const other = new Set<string>();
      for (const i of this.fc.insns) {
        const d = i.ops[0];
        if (!d || d.t !== 'r' || !(i.mn === 'mov' || i.mn === 'lea' || i.mn === 'pop' || i.mn === 'xor')) continue;
        const r = REG32[d.r!];
        if (!r) continue;
        const sOp = i.ops[1];
        if (i.mn === 'mov' && sOp && sOp.t === 'm' && !sOp.base && !sOp.idx && sOp.disp !== undefined && this.an.iatNames.has(sOp.disp >>> 0)) {
          (m.get(r) ?? m.set(r, new Set()).get(r)!).add(this.an.iatNames.get(sOp.disp >>> 0)!);
        }
      }
      void other;
      this._regImports = m;
    }
    return this._regImports;
  }

  /** Remove error-check edges and cleanup funclets from the CFG. */
  private simplifyCFG() {
    const noiseBlock = new Set<number>();
    const img = this.an.img;
    const isHrCheckShape = (b: Block): boolean => {
      // push off ; push IID ; push obj ; push eax ; call <anything>  (__vbaHresultCheckObj through a register)
      const ins = b.insns.filter(i => i.mn !== 'mov' && i.mn !== 'nop');
      const ci = ins.findIndex(i => i.mn === 'call');
      if (ci < 0) return false;
      const pushes = ins.slice(0, ci).filter(i => i.mn === 'push');
      if (pushes.length < 3) return false;
      if (b.start === this.f.va) return false;
      const iidPush = pushes.find(p => p.ops[0].t === 'i' && img.isMapped(p.ops[0].v!) && /^\{[0-9A-F-]{36}\}$/.test(img.guid(p.ops[0].v!)) && !this.an.strings.has(p.ops[0].v!) && !this.an.thunks.has(p.ops[0].v!) && !this.an.funcByVA.has(p.ops[0].v!));
      if (!iidPush) return false;
      const all = b.insns, cAll = all.findIndex(i => i.mn === 'call');
      return all.slice(cAll + 1).every(i => i.mn === 'jmp' || i.mn === 'int3' || i.mn === 'nop');
    };
    const isNoise = (b: Block): boolean => {
      if (isHrCheckShape(b)) return true;
      // a block that only pushes constants/regs and calls a trap/check helper (maybe via jmp)
      let calls = 0;
      for (const i of b.insns) {
        if (i.mn === 'push' || i.mn === 'mov' || i.mn === 'lea' || i.mn === 'jmp' || i.mn === 'nop' || i.mn === 'int3') continue;
        if (i.mn === 'call') {
          const n = this.callName(i, { regs: {}, esp: 0, slots: new Map(), fpu: [], flags: { k: 'none' }, pushes: [] });
          if (n && NOISE_FUNCS.test(n)) { calls++; continue; }
        }
        return false;
      }
      if (calls) return true;
      // "push off; jmp check" blocks
      const last = b.insns[b.insns.length - 1];
      if (last.mn === 'jmp' && last.ops[0].t === 'j') { const t = this.blocks.get(last.ops[0].v!); return !!t && t !== b && isNoiseNoRec(t); }
      return false;
    };
    const isNoiseNoRec = (b: Block) => b.insns.some(i => i.mn === 'call' && NOISE_FUNCS.test(this.callName(i, { regs: {}, esp: 0, slots: new Map(), fpu: [], flags: { k: 'none' }, pushes: [] }) ?? '')) &&
      b.insns.every(i => ['push', 'mov', 'lea', 'call', 'jmp', 'nop', 'int3'].includes(i.mn));
    for (const b of this.fc.blocks) if (isNoise(b)) noiseBlock.add(b.start);
    for (let it = 0; it < 4; it++) {
      for (const b of this.fc.blocks) {
        if (noiseBlock.has(b.start)) continue;
        if (!b.insns.every(i => i.mn === 'push' || i.mn === 'mov' || i.mn === 'lea' || i.mn === 'jmp')) continue;
        if (b.succ.length === 1 && noiseBlock.has(b.succ[0])) noiseBlock.add(b.start);
      }
    }
    // cleanup funclet: block(s) reached by "push L; jmp X" ending in plain ret
    for (const b of this.fc.blocks) {
      let s = b.succ.filter(t => !noiseBlock.has(t));
      const last = b.insns[b.insns.length - 1];
      const prev = b.insns[b.insns.length - 2];
      if (last?.mn === 'jmp' && prev?.mn === 'push' && prev.ops[0].t === 'i' && b.succ.includes(prev.ops[0].v!)) {
        s = [prev.ops[0].v!]; // continue after the funclet returns
      }
      this.succ.set(b.start, s);
    }
    this.noise = noiseBlock;
  }
  noise = new Set<number>();

  // --- symbolic execution -------------------------------------------------------------
  private initialState(): State {
    return { regs: {}, esp: 0, slots: new Map(), fpu: [], flags: { k: 'none' }, pushes: [] };
  }

  private val(op: Operand, st: State, sz?: number): E {
    switch (op.t) {
      case 'i': {
        const v = op.v!;
        const s = this.an.strings.get(v);
        if (s) return S(s.text);
        if (op.sz === 4 && this.an.img.inImage(v) && this.an.img.isMapped(v) && v > this.an.img.imageBase + 0x1000) {
          const g = this.an.globals.get(v);
          if (g) return { k: 'a', e: V(g) };
          const n = symbolName(this.an, v);
          if (n) return { k: 'raw', t: n };
          return { k: 'c', v: v | 0, t: 'hex' };
        }
        const bits = (sz ?? op.sz) * 8;
        let x = v;
        if (bits < 32 && x >= 2 ** (bits - 1)) x -= 2 ** bits;
        if (bits === 32) x = x | 0;
        return C(x);
      }
      case 'r': {
        const r = op.r!;
        if (r.startsWith('st(')) return st.fpu[Number(r[3])] ?? RAW(r);
        const full = REG32[r];
        if (!full) return RAW(r);
        if (full === 'esp') return { k: 'sp', o: st.esp };
        if (full === 'ebp') return { k: 'sp', o: -4 };
        const v = st.regs[full];
        if (!v) return { k: 'reg', r: full };
        if (r === 'ah' || r === 'bh' || r === 'ch' || r === 'dh') return { k: 'b', op: '\\', l: v, r: C(256) };
        return v;
      }
      case 'm': return this.load(this.addrOf(op, st), op.sz || 4, st);
      case 'j': return C(op.v!);
      case 'f': return RAW('far');
    }
  }

  /** Address expression for a memory operand. */
  private addrOf(op: Operand, st: State): E {
    const disp = op.disp ?? 0;
    if (op.seg === 'fs') return RAW(`fs:[${disp}]`);
    if (!op.base && !op.idx) return C(disp >>> 0, 'hex');
    let base: E | undefined;
    if (op.base) {
      const full = REG32[op.base];
      if (full === 'ebp') base = { k: 'sp', o: -4 };
      else if (full === 'esp') base = { k: 'sp', o: st.esp };
      else base = st.regs[full] ?? { k: 'reg', r: full };
    }
    if (op.idx) {
      const ix = st.regs[REG32[op.idx]] ?? { k: 'reg', r: REG32[op.idx] };
      const scaled: E = op.sc && op.sc > 1 ? { k: 'b', op: '*', l: ix, r: C(op.sc) } : ix;
      const sum: E = base ? { k: 'b', op: '+', l: base, r: scaled } : scaled;
      return disp ? { k: 'b', op: '+', l: sum, r: C(disp) } : sum;
    }
    return this.offsetAddr(base!, disp);
  }

  private offsetAddr(base: E, off: number): E {
    if (!off) return base;
    const b = unref(base);
    if (b.k === 'sp') return { k: 'sp', o: b.o + off };
    if (b.k === 'c') return C((b.v + off) >>> 0, 'hex');
    return { k: 'b', op: '+', l: base, r: C(off) };
  }

  /** Read sz bytes at an address expression. */
  private load(addr: E, sz: number, st: State): E {
    const a = unref(addr);
    if (a.k === 'sp') {
      const v = st.slots.get(a.o);
      if (v) return v;
      return this.slotE(a.o);
    }
    if (a.k === 'a') return a.e;
    if (a.k === 'v' && a.slot && a.n !== 'Me' && Number(a.slot.slice(5)) >= 4) return a; // ByRef parameter
    if (a.k === 'c') {
      const va = a.v >>> 0;
      const s = this.an.strings.get(va);
      if (s) return S(s.text);
      const imp = this.an.iatNames.get(va);
      if (imp) return RAW('@import:' + imp);
      return V(this.globalName(va));
    }
    const el = this.element(addr);
    if (el) return el;
    if (a.k === 'b' && a.op === '+' && unref(a.r).k === 'c') {
      const base = a.l;
      const off = (unref(a.r) as { v: number }).v;
      return { k: 'm', base, off, sz };
    }
    return { k: 'm', base: addr, off: 0, sz };
  }

  /** SAFEARRAY element access -> arr(index)[.field_X] */
  element(addr: E): E | undefined {
    const u = unref(addr);
    if (u.k !== 'b') return undefined;
    const el = arrayElement(addr);
    if (!el) return undefined;
    // the descriptor is usually loaded from the array variable: m(var) / V(var)
    let arr = el.arr;
    const ua = unref(arr);
    if (ua.k === 'm' && ua.off === 0 && unref(ua.base).k !== 'b') arr = this.lvOfPointer(ua.base);
    const e: E = { k: 'call', f: printE(arr), args: [el.index] };
    if (el.field) return { k: 'v', n: `${printE(e)}.field_${hex(el.field)}` };
    return e;
  }

  lvOfPointer(p: E): E {
    const u = unref(p);
    if (u.k === 'sp') return this.slotE(u.o);
    if (u.k === 'a') return u.e;
    if (u.k === 'c') return V(this.globalName(u.v >>> 0));
    return { k: 'm', base: p, off: 0, sz: 4 };
  }

  /** Lvalue expression for an address (for printing assignments). */
  lv(addr: E, sz = 4): E {
    if (!addr) return RAW('?');
    const a = unref(addr);
    if (a.k === 'sp') return this.slotE(a.o);
    if (a.k === 'a') return a.e;
    if (a.k === 'v' && a.slot && a.n !== 'Me' && Number(a.slot.slice(5)) >= 4) return a;
    if (a.k === 'c') return V(this.globalName(a.v >>> 0));
    const el = this.element(addr);
    if (el) return el;
    if (a.k === 'b' && a.op === '+' && unref(a.r).k === 'c') return { k: 'm', base: a.l, off: (unref(a.r) as { v: number }).v, sz };
    return { k: 'm', base: addr, off: 0, sz };
  }

  private emit(st: Stmt) { st as AssignStmt; (st as { idx?: number }).idx = this.stmts.length; this.stmts.push(st); this.cur.push(st); }
  cur: Stmt[] = [];

  /** Store a value at an address; emits an assignment for variables. Returns the stored value reference. */
  store(addr: E, value: E, st: State, va: number, opts: { set?: boolean; sz?: number; silent?: boolean } = {}): E {
    const a = unref(addr);
    if (a.k === 'sp') {
      const o = a.o;
      // argument staging area below the locals: no statement
      if (o < this.localsBottom || opts.silent) { st.slots.set(o, value); return value; }
      if (o === 4 && this.isObjMethod) return value; // Me adjustments
      const uv = unref(value);
      if (o < 0 && o >= this.frameTop) { st.slots.set(o, value); return value; } // SEH frame / line counter
      if (uv.k === 'sp') { st.slots.set(o, value); return value; }
      if (this.inPrologue && uv.k === 'c' && uv.v === 0) { st.slots.set(o, ZERO_INIT); return value; } // zero-initialisation
      const dst = this.slotE(o);
      const s: AssignStmt = { k: 'assign', va, dst, src: value, set: opts.set };
      this.emit(s);
      const ref: E = { k: 'ref', def: s };
      st.slots.set(o, ref);
      // registers holding the very same value now alias the variable
      for (const r of Object.keys(st.regs)) if (st.regs[r] === value) st.regs[r] = ref;
      return ref;
    }
    if (a.k === 'raw' && a.t.startsWith('fs:')) return value; // SEH frame manipulation
    const dst = this.lv(addr, opts.sz ?? 4);
    const s: AssignStmt = { k: 'assign', va, dst, src: value, set: opts.set };
    this.emit(s);
    return { k: 'ref', def: s };
  }

  /** Interface (typelib) for an object expression, from the HRESULT check IID or context. */
  ifaceFor(callVA: number, objE: E): { iface?: IfaceInfo; projObj?: VBObject } {
    const iid = this.iidAt.get(callVA);
    if (iid) {
      const po = this.an.project.objects.find(o => this.objIface(o) === iid);
      if (po) return { projObj: po };
      const ifc = INTERFACES_BY_GUID[iid];
      if (ifc) return { iface: ifc };
    }
    const o = unref(objE);
    if (o.k === 'v' && o.n === 'Me' && this.obj) return { projObj: this.obj };
    if (o.k === 'v') {
      const g = this.globalByName.get(o.n);
      if (g !== undefined) return { projObj: this.an.project.objects[g] };
      const gi = this.globalIfaceByName.get(o.n);
      if (gi && INTERFACES_BY_GUID[gi]) return { iface: INTERFACES_BY_GUID[gi] };
    }
    return {};
  }
  private _gibn?: Map<string, string>;
  get globalIfaceByName(): Map<string, string> {
    if (!this._gibn) {
      this._gibn = new Map();
      for (const [va, iid] of this.an.globalIfaces) { const n = this.an.globals.get(va) ?? `global_${hex(va)}`; this._gibn.set(n, iid); }
    }
    return this._gibn;
  }
  private _gbn?: Map<string, number>;
  get globalByName(): Map<string, number> {
    if (!this._gbn) {
      this._gbn = new Map();
      for (const [va, oi] of this.an.globalTypes) { const n = this.an.globals.get(va); if (n) this._gbn.set(n, oi); }
    }
    return this._gbn;
  }

  private ifaceCache = new Map<number, string>();
  objIface(o: VBObject): string {
    let g = this.ifaceCache.get(o.index);
    if (g === undefined) {
      g = '';
      if (o.optInfoVA) {
        const img = this.an.img;
        const p = img.u32(o.optInfoVA + 0x1c);
        if (img.isMapped(p)) { const gp = img.u32(p); if (img.isMapped(gp)) g = img.guid(gp); }
      }
      this.ifaceCache.set(o.index, g);
    }
    return g;
  }

  /** Resolve a vtable call: returns member name/kind and argument shape. */
  resolveVCall(callVA: number, objE: E, off: number): { name: string; kind: 'get' | 'let' | 'set' | 'method'; params?: number; target?: number; ctl?: boolean; types?: string[] } {
    // control arrays: the collection object's Item(Index) getter
    {
      const u = unref(objE);
      if (u.k === 'mc' && u.kind === 'get' && !u.args.length && (off === 0x40 || off === 0x1c)) {
        const owner = this.ifaceFor(0, u.o).projObj;
        const pf = owner ? this.env.forms?.get(owner.index) : undefined;
        if (owner && (owner.controls.some(c => c.name === u.n && c.isArray) || pf?.controls.some(c => c.name === u.n && c.arrayIndex !== undefined))) {
          if (off === 0x40) return { name: '', kind: 'get', params: 2 };
          return { name: 'Count', kind: 'get', params: 1 };
        }
      }
    }
    const { iface, projObj } = this.ifaceFor(callVA, objE);
    if (projObj) {
      const base = projObj.vtableBase;
      const acc = projObj.accessors.find(a => a.vtableOffset === off);
      if (acc) return { name: `m_${hex(acc.field)}`, kind: acc.kind, params: 1 };
      if (off >= base) {
        const m = projObj.methods.find(m => m.vtableOffset === off);
        if (m) {
          const f = this.an.funcByVA.get(m.targetVA);
          const nm = f ? f.name : (m.name ?? `Method_${hex(off)}`);
          return { name: nm, kind: 'method', params: f ? Math.max(0, f.argBytes / 4 - 1) : undefined, target: m.targetVA };
        }
        // public variable accessors precede the methods
        return { name: `Method_${hex(off)}`, kind: 'method' };
      }
      if (projObj.kind === 'Form' || projObj.kind === 'MDIForm') {
        if (off >= 0x2f8) {
          const id = (off - 0x2f8) / 4;
          const pf = this.env.forms?.get(projObj.index);
          const c = pf?.byId.get(id) ?? undefined;
          const cl = projObj.controls.find(c => c.ctlIndex === id);
          const name = c?.name ?? cl?.name ?? `Control_${id}`;
          return { name, kind: 'get', params: 0, ctl: true };
        }
        const m = lookupMember(projObj.kind === 'MDIForm' ? '_MDIForm' : '_Form', off);
        if (m) return { name: m.name, kind: m.kind, params: m.params.length, types: m.params };
      }
      if (projObj.kind === 'UserControl') {
        const m = lookupMember('_UserControl', off);
        if (m) return { name: m.name, kind: m.kind, params: m.params.length };
      }
      if (off === 0x1c && projObj.kind === 'Class') return { name: 'Method_1C', kind: 'method' };
    }
    if (iface) {
      let m = lookupMember(iface.name, off);
      if (!m && iface.base) m = lookupMember(iface.base, off);
      if (m) return { name: m.name, kind: m.kind, params: m.params.length, types: m.params };
    }
    const vba = VBA_IFACES[this.iidAt.get(callVA) ?? ''];
    if (vba) {
      const m = vba[off];
      if (m) return { name: m[0], kind: m[1], params: m[2] };
    }
    if (off === 0) return { name: 'QueryInterface', kind: 'method', params: 2 };
    if (off === 4) return { name: 'AddRef', kind: 'method', params: 0 };
    if (off === 8) return { name: 'Release', kind: 'method', params: 0 };
    return { name: `Method_${hex(off)}`, kind: 'method' };
  }

  /** Pop n stack arguments (arg0 = top of stack). */
  popArgs(st: State, n: number, pop = true): E[] {
    const out: E[] = [];
    for (let k = 0; k < n; k++) out.push(st.slots.get(st.esp + k * 4) ?? RAW('?'));
    if (pop) {
      for (let k = 0; k < n; k++) st.slots.delete(st.esp + k * 4);
      st.esp += n * 4;
      st.pushes = st.pushes.filter(o => o >= st.esp);
    }
    return out;
  }

  pendingArgCount(st: State): number {
    // contiguous pushed slots from esp upward
    let n = 0;
    while (st.slots.has(st.esp + n * 4) && st.esp + n * 4 < this.localsBottom && n < 32) n++;
    return n;
  }

  /** Reconstruct a Variant argument passed by address (temp built in the frame). */
  variantAt(addr: E, st: State): E {
    if (!addr) return RAW('?');
    const a = unref(addr);
    if (a.k !== 'sp') {
      if (a.k === 'a') return a.e;
      if (a.k === 'c') return this.an.img.isMapped(a.v >>> 0) && (a.v >>> 0) > this.an.img.imageBase ? this.lv(addr) : a;
      if (a.k === 'm') return this.lv(addr);
      return addr;
    }
    const o = a.o;
    const vtE = st.slots.get(o);
    const vt = vtE ? unref(vtE) : undefined;
    const valE = st.slots.get(o + 8);
    if (vtE && vt && vt.k === 'c') {
      if (vtE.k === 'ref') this.consumed.add(vtE.def);
      const t = vt.v & 0xffff;
      if (t === 0x0a) return { k: 'missing' }; // VT_ERROR: missing optional argument
      if (t === 0) return RAW('Empty');
      if (t === 1) return RAW('Null');
      if (t & 0x4000) {
        // ByRef variant: value slot holds a pointer to the variable
        if (valE) return this.lv(valE);
      }
      if (t === 0x0b && valE) { const v = unref(valE); if (v.k === 'c') return C(v.v ? -1 : 0, 'bool'); }
      if (valE) {
        if (t === 5 || t === 7) {
          const hi = st.slots.get(o + 12);
          const lo = unref(valE), h = hi ? unref(hi) : undefined;
          if (lo.k === 'c' && h && h.k === 'c') {
            const dv = new DataView(new ArrayBuffer(8));
            dv.setInt32(0, lo.v, true); dv.setInt32(4, h.v, true);
            return { k: 'f', v: dv.getFloat64(0, true) };
          }
        }
        return valE;
      }
    }
    if (vtE && unref(vtE).k === 'ref') {
      // the whole variant was produced by a runtime call
      return vtE;
    }
    if (vtE && vt && vt.k === 'raw' && vt.t.startsWith('@variant:')) return vtE;
    return this.slotE(o);
  }

  private setFlagsRes(st: State, e: E) { st.flags = { k: 'res', a: e }; }

  private execBlock(b: Block, st: State) {
    const img = this.an.img;
    for (let k = 0; k < b.insns.length; k++) {
      const i = b.insns[k];
      this.nextInsn = b.insns[k + 1];
      try {
        this.execInsn(i, st, b);
      } catch (e) {
        this.errors.push(`${hex(i.va)}: ${(e as Error).message}`);
      }
    }
    void img;
  }

  private writeReg(st: State, r: string, v: E) {
    const full = REG32[r];
    if (!full) return;
    if (full === 'esp' || full === 'ebp') return;
    st.regs[full] = v;
  }

  private execInsn(i: Insn, st: State, b: Block) {
    const ops = i.ops;
    const mn = i.mn;
    switch (mn) {
      case 'push': {
        const v = this.val(ops[0], st, 4);
        st.esp -= 4;
        st.slots.set(st.esp, v);
        st.pushes.push(st.esp);
        return;
      }
      case 'pop': {
        const v = st.slots.get(st.esp);
        st.slots.delete(st.esp);
        st.esp += 4;
        if (ops[0].t === 'r') this.writeReg(st, ops[0].r!, v ?? { k: 'reg', r: REG32[ops[0].r!] ?? ops[0].r! });
        return;
      }
      case 'mov': case 'movzx': case 'movsx': {
        const v = this.val(ops[1], st);
        if (ops[0].t === 'r') {
          if (REG32[ops[0].r!] === 'esp') { const s = unref(v); if (s.k === 'sp') st.esp = s.o; return; }
          if (REG32[ops[0].r!] === 'ebp') return;
          this.writeReg(st, ops[0].r!, v);
        } else if (ops[0].t === 'm') {
          this.store(this.addrOf(ops[0], st), v, st, i.va, { sz: ops[0].sz });
        }
        return;
      }
      case 'lea': {
        const a = this.addrOf(ops[1], st);
        const u = unref(a);
        if (ops[0].t === 'r' && REG32[ops[0].r!] === 'esp') { if (u.k === 'sp') st.esp = u.o; return; }
        // address of a member/global: represent as address-of lvalue
        let v: E = a;
        if (u.k === 'b' && u.op === '+' && unref(u.r).k === 'c' && !(unref(u.l).k === 'sp')) v = { k: 'a', e: this.lv(a) };
        this.writeReg(st, ops[0].r!, v);
        return;
      }
      case 'xor': case 'sub': case 'sbb':
        if (mn === 'sbb' && ops[0].t === 'r' && ops[1]?.t === 'r' && ops[0].r === ops[1].r) {
          // borrow-materialisation idiom: value is -(carry)
          const f = st.flags;
          let cond: E = RAW('carry');
          if (f.k === 'neg' && f.a) cond = this.simplifyCmp('<>', f.a, C(0));
          else if (f.k === 'cmp' && f.a && f.b) cond = this.simplifyCmp('<', f.a, f.b);
          this.writeReg(st, ops[0].r!, cond);
          st.flags = { k: 'res', a: cond };
          return;
        }
        if (ops[0].t === 'r' && ops[1]?.t === 'r' && ops[0].r === ops[1].r) {
          this.writeReg(st, ops[0].r!, C(0));
          st.flags = { k: 'res', a: C(0) };
          return;
        }
      // fallthrough
      case 'add': case 'and': case 'or': case 'adc': case 'imul': case 'shl': case 'sal': case 'shr': case 'sar': {
        if (ops[0].t === 'r' && REG32[ops[0].r!] === 'esp') {
          const k = unref(this.val(ops[1], st));
          if (k.k === 'c') {
            if (mn === 'add') {
              // cdecl cleanup after a call / argument release
              for (let o = st.esp; o < st.esp + k.v; o += 4) st.slots.delete(o);
              st.esp += k.v;
            } else if (mn === 'sub') st.esp -= k.v;
          }
          return;
        }
        if ((mn === 'imul') && ops.length === 1) {
          // edx:eax = eax * op — compilers use the high half for division by a constant
          const x = this.val(ops[0], st);
          const m = unref(st.regs.eax ?? C(0));
          st.regs.edx = m.k === 'c' ? { k: 'b', op: 'mulhi', l: x, r: m } : { k: 'b', op: '*', l: x, r: st.regs.eax ?? RAW('eax') };
          st.regs.eax = { k: 'b', op: '*', l: x, r: st.regs.eax ?? RAW('eax') };
          return;
        }
        const a = this.val(ops[0], st);
        const bv = ops.length > 2 ? this.val(ops[2], st) : this.val(ops[1], st);
        const left = ops.length > 2 ? this.val(ops[1], st) : a;
        let res: E;
        const ua = unref(left), ub = unref(bv);
        // Me pointer normalization: and esi, -2 / and eax, 1
        if (mn === 'sar' && ua.k === 'b' && ua.op === 'mulhi' && ub.k === 'c') {
          // x * M >> (32 + s)  ==  x \ d
          const M = unref(ua.r).k === 'c' ? (unref(ua.r) as { v: number }).v >>> 0 : 1;
          const d = Math.round(2 ** (32 + ub.v) / M);
          res = { k: 'b', op: '\\', l: ua.l, r: C(d) };
        } else if (mn === 'shr' && ub.k === 'c' && ub.v === 31 && ua.k === 'b' && ua.op === '\\') {
          res = C(0); // sign-correction term of a signed division
        } else if ((mn === 'add' || mn === 'sub' || mn === 'or') && ub.k === 'c' && ub.v === 0) {
          res = left;
        } else if ((mn === 'and' || mn === 'or') && ua.k === 'v' && ua.n === 'Me') {
          res = ub.k === 'c' && (ub.v === -2 || ub.v === 0xfe || ub.v === 0xfffffffe) ? left : C(0);
        } else if (ua.k === 'sp' && ub.k === 'c' && (mn === 'add' || mn === 'sub')) {
          res = { k: 'sp', o: ua.o + (mn === 'add' ? ub.v : -ub.v) };
        } else if (ua.k === 'c' && ub.k === 'c') {
          const x = ua.v, y = ub.v;
          const r = mn === 'add' ? x + y : mn === 'sub' ? x - y : mn === 'and' ? x & y : mn === 'or' ? x | y : mn === 'xor' ? x ^ y : mn === 'imul' ? Math.imul(x, y) : mn === 'shl' || mn === 'sal' ? x << y : mn === 'shr' ? x >>> y : mn === 'sar' ? x >> y : x;
          res = C(r | 0);
        } else {
          const opName: Record<string, string> = { add: '+', sub: '-', and: 'And', or: 'Or', xor: 'Xor', imul: '*', adc: '+', sbb: '-', shl: '*', sal: '*', shr: '\\', sar: '\\' };
          let r = bv;
          if ((mn === 'shl' || mn === 'sal' || mn === 'shr' || mn === 'sar') && ub.k === 'c') r = C(2 ** ub.v);
          res = { k: 'b', op: opName[mn], l: left, r };
          if (mn === 'sub' && ub.k === 'c' && ub.v < 0) res = { k: 'b', op: '+', l: left, r: C(-ub.v) };
          if (mn === 'add' && ub.k === 'c' && ub.v < 0) res = { k: 'b', op: '-', l: left, r: C(-ub.v) };
        }
        if (ops[0].t === 'r') this.writeReg(st, ops[0].r!, res);
        else if (ops[0].t === 'm') this.store(this.addrOf(ops[0], st), res, st, i.va, { sz: ops[0].sz });
        st.flags = mn === 'sub' ? { k: 'cmp', a: left, b: bv } : { k: 'res', a: res };
        return;
      }
      case 'inc': case 'dec': case 'neg': case 'not': {
        const a = this.val(ops[0], st);
        const ua = unref(a);
        let res: E;
        if (ua.k === 'c') res = C(mn === 'inc' ? ua.v + 1 : mn === 'dec' ? ua.v - 1 : mn === 'neg' ? -ua.v : ~ua.v);
        else res = mn === 'inc' ? { k: 'b', op: '+', l: a, r: C(1) } : mn === 'dec' ? { k: 'b', op: '-', l: a, r: C(1) } : mn === 'neg' ? { k: 'u', op: '-', e: a } : { k: 'u', op: 'Not', e: a };
        // VB booleans: neg/sbb/inc patterns for comparisons: neg eax; sbb eax,eax; inc eax
        // boolean idioms: neg/inc/dec of a comparison result keep the boolean
        if ((mn === 'neg' || mn === 'inc' || mn === 'dec' || mn === 'not') && isBoolE(a)) res = mn === 'inc' || mn === 'not' ? negate(a) : a;
        if (ops[0].t === 'r') this.writeReg(st, ops[0].r!, res);
        else this.store(this.addrOf(ops[0], st), res, st, i.va, { sz: ops[0].sz });
        st.flags = mn === 'neg' ? { k: 'neg', a } : { k: 'res', a: res };
        return;
      }
      case 'cmp': st.flags = { k: 'cmp', a: this.val(ops[0], st), b: this.val(ops[1], st) }; return;
      case 'test': st.flags = { k: 'test', a: this.val(ops[0], st), b: this.val(ops[1], st), sz: ops[0].sz }; return;
      case 'xchg': {
        const a = this.val(ops[0], st), c = this.val(ops[1], st);
        if (ops[0].t === 'r') this.writeReg(st, ops[0].r!, c);
        if (ops[1].t === 'r') this.writeReg(st, ops[1].r!, a);
        return;
      }
      case 'cdq': case 'cwde': case 'cbw': case 'cwd': return;
      case 'setne': case 'sete': case 'setg': case 'setl': case 'setge': case 'setle': case 'seta': case 'setb': case 'setae': case 'setbe': {
        const cond = this.condition(mn.slice(3), st);
        if (ops[0].t === 'r') this.writeReg(st, ops[0].r!, cond);
        return;
      }
      case 'call': return this.execCall(i, st);
      case 'ret': {
        // only real epilogues (pop ebp / leave before ret), not cleanup funclets
        const k = b.insns.indexOf(i);
        const p = k > 0 ? b.insns[k - 1] : undefined;
        if (p && ((p.mn === 'pop' && p.ops[0].r === 'ebp') || p.mn === 'leave')) this.retVals.push({ eax: st.regs.eax, va: i.va, fpu: st.fpu?.length ? st.fpu[st.fpu.length - 1] : undefined });
        return;
      }
      case 'jmp': case 'nop': case 'wait': case 'fnclex': case 'leave': case 'int3': return;
      case 'sahf': st.flags = { ...st.flags, sahf: true }; return;
      case 'stosd': case 'stosb': case 'stosw': return;
      case 'idiv': case 'div': {
        const d = this.val(ops[0], st);
        const a = st.regs.eax ?? { k: 'reg', r: 'eax' };
        st.regs.edx = { k: 'b', op: 'Mod', l: a, r: d };
        st.regs.eax = { k: 'b', op: '\\', l: a, r: d };
        return;
      }
      default:
        if (mn[0] === 'f') return this.execFPU(i, st);
        if (mn[0] === 'j' || mn.startsWith('loop')) return; // terminators handled by caller
        if (ops[0]?.t === 'r') this.writeReg(st, ops[0].r!, RAW(`${mn}(...)`));
        this.cur.push({ k: 'comment', va: i.va, t: `asm: ${mn}` });
    }
    void b;
  }

  private execFPU(i: Insn, st: State) {
    const mn = i.mn, ops = i.ops;
    const top = () => st.fpu[0] ?? RAW('st0');
    const mem = (op: Operand, int = false): E => {
      if (op.t === 'm' && op.sz === 8 && !int) {
        // qword constant in image?
        const a = unref(this.addrOf(op, st));
        if (a.k === 'c' && this.an.img.isMapped(a.v)) {
          const sec = this.an.img.sectionOf(a.v);
          if (sec && !this.an.globals.has(a.v)) return { k: 'f', v: this.an.img.f64(a.v) };
        }
      }
      if (op.t === 'm' && op.sz === 4 && !int) {
        const a = unref(this.addrOf(op, st));
        if (a.k === 'c' && this.an.img.isMapped(a.v) && !this.an.globals.has(a.v)) return { k: 'f', v: this.an.img.f32(a.v) };
      }
      return this.val(op, st);
    };
    const binop = (op: string, rev: boolean, pop: boolean) => {
      let a: E, b: E;
      if (ops.length === 0) { a = st.fpu[1] ?? RAW('st1'); b = top(); st.fpu.shift(); st.fpu[0] = rev ? { k: 'b', op, l: b, r: a } : { k: 'b', op, l: a, r: b }; return; }
      if (ops.length === 1 && ops[0].t === 'm') { a = top(); b = mem(ops[0], mn.startsWith('fi')); st.fpu[0] = rev ? { k: 'b', op, l: b, r: a } : { k: 'b', op, l: a, r: b }; return; }
      // register forms: dst, src
      const di = ops[0].t === 'r' ? Number(ops[0].r![3]) : 0;
      const si = ops[1] ? Number(ops[1].r![3]) : 0;
      a = st.fpu[di] ?? RAW(`st${di}`); b = st.fpu[si] ?? RAW(`st${si}`);
      st.fpu[di] = rev ? { k: 'b', op, l: b, r: a } : { k: 'b', op, l: a, r: b };
      if (pop) st.fpu.shift();
    };
    switch (mn) {
      case 'fld': st.fpu.unshift(ops[0].t === 'r' ? (st.fpu[Number(ops[0].r![3])] ?? RAW('st')) : mem(ops[0])); return;
      case 'fild': st.fpu.unshift(this.val(ops[0], st)); return;
      case 'fldz': st.fpu.unshift({ k: 'f', v: 0 }); return;
      case 'fld1': st.fpu.unshift({ k: 'f', v: 1 }); return;
      case 'fldpi': st.fpu.unshift(RAW('3.14159265358979')); return;
      case 'fst': case 'fstp': case 'fist': case 'fistp': {
        const v = top();
        if (ops[0].t === 'm') this.store(this.addrOf(ops[0], st), v, st, i.va, { sz: ops[0].sz });
        else if (ops[0].t === 'r') st.fpu[Number(ops[0].r![3])] = v;
        if (mn.endsWith('p')) st.fpu.shift();
        return;
      }
      case 'fadd': case 'faddp': case 'fiadd': return binop('+', false, mn === 'faddp');
      case 'fsub': case 'fsubp': case 'fisub': return binop('-', false, mn === 'fsubp');
      case 'fsubr': case 'fsubrp': case 'fisubr': return binop('-', true, mn === 'fsubrp');
      case 'fmul': case 'fmulp': case 'fimul': return binop('*', false, mn === 'fmulp');
      case 'fdiv': case 'fdivp': case 'fidiv': return binop('/', false, mn === 'fdivp');
      case 'fdivr': case 'fdivrp': case 'fidivr': return binop('/', true, mn === 'fdivrp');
      case 'fchs': st.fpu[0] = { k: 'u', op: '-', e: top() }; return;
      case 'fabs': st.fpu[0] = CALL('Abs', top()); return;
      case 'fsqrt': st.fpu[0] = CALL('Sqr', top()); return;
      case 'frndint': st.fpu[0] = CALL('CLng', top()); return;
      case 'fxch': { const k = ops[0] ? Number(ops[0].r![3]) : 1; const t = st.fpu[0]; st.fpu[0] = st.fpu[k]; st.fpu[k] = t; return; }
      case 'fcom': case 'fcomp': case 'fcompp': case 'fucom': case 'fucomp': case 'fucompp': case 'ficom': case 'ficomp': case 'fcomip': case 'fucomip': case 'fcomi': case 'fucomi': {
        const a = top();
        const b = ops.length && ops[ops.length - 1].t === 'm' ? mem(ops[ops.length - 1], mn.startsWith('fi')) : (st.fpu[ops.length ? Number(ops[ops.length - 1].r![3]) : 1] ?? RAW('st1'));
        st.flags = { k: 'fcmp', a, b, sahf: mn.endsWith('i') || mn.endsWith('ip') };
        if (mn.endsWith('pp')) { st.fpu.shift(); st.fpu.shift(); } else if (mn.endsWith('p')) st.fpu.shift();
        return;
      }
      case 'ftst': st.flags = { k: 'fcmp', a: top(), b: { k: 'f', v: 0 } }; return;
      case 'fnstsw': case 'fstsw': return; // status word -> ax: flags stay in fcmp form
      case 'fnstcw': case 'fldcw': case 'fwait': case 'fnclex': case 'fninit': case 'ffree': return;
      default:
        st.fpu[0] = RAW(`${mn}(...)`);
    }
  }

  /** Build the condition (as a VB boolean expression) for a jcc suffix. */
  condition(cc: string, st: State): E {
    const f = st.flags;
    const B = (op: string, a: E, b: E): E => this.simplifyCmp(op, a, b);
    const ops: Record<string, string> = { e: '=', z: '=', ne: '<>', nz: '<>', l: '<', b: '<', le: '<=', be: '<=', g: '>', a: '>', ge: '>=', ae: '>=', nl: '>=', nb: '>=', ng: '<=', na: '<=', nle: '>', nbe: '>', nge: '<', nae: '<', c: '<', nc: '>=' };
    if (f.k === 'cmp' && ops[cc]) return B(ops[cc], f.a!, f.b!);
    if (f.k === 'test') {
      const a = f.a!, b = f.b!;
      const same = printE(a) === printE(b);
      // 16-bit test of a procedure result: VB Boolean
      if (same && f.sz === 2 && (cc === 'e' || cc === 'z' || cc === 'ne' || cc === 'nz')) {
        const u = unref(a);
        if (u.k === 'call' || u.k === 'mc' || (u.k === 'v')) {
          if (a.k === 'ref') this.consumed.add(a.def);
          return cc === 'ne' || cc === 'nz' ? a : negate(a);
        }
      }
      const base = same ? a : { k: 'b', op: 'And', l: a, r: b } as E;
      if (cc === 'e' || cc === 'z') return B('=', base, C(0));
      if (cc === 'ne' || cc === 'nz') return B('<>', base, C(0));
      if (cc === 's' || cc === 'l') return B('<', base, C(0));
      if (cc === 'ns' || cc === 'ge') return B('>=', base, C(0));
      if (cc === 'le') return B('<=', base, C(0));
      if (cc === 'g') return B('>', base, C(0));
      // test ah, mask after fcomp/fnstsw
    }
    if (f.k === 'fcmp') {
      const m = f.fmask;
      if (f.sahf || m === undefined) {
        const o = ops[cc];
        if (o) return B(o, f.a!, f.b!);
      } else {
        // test ah, mask ; jcc  (C0=0x01 less, C2=0x04 unordered, C3=0x40 equal)
        const z = cc === 'e' || cc === 'z';
        if (m === 0x41) return B(z ? '>' : '<=', f.a!, f.b!);
        if (m === 0x40) return B(z ? '<>' : '=', f.a!, f.b!);
        if (m === 0x01 || m === 0x05) return B(z ? '>=' : '<', f.a!, f.b!);
        if (m === 0x44) return B(z ? '=' : '<>', f.a!, f.b!);
      }
    }
    if (f.k === 'res' && f.a) {
      if (cc === 'e' || cc === 'z') return B('=', f.a, C(0));
      if (cc === 'ne' || cc === 'nz') return B('<>', f.a, C(0));
      if (cc === 's' || cc === 'l') return B('<', f.a, C(0));
      if (cc === 'ns' || cc === 'ge') return B('>=', f.a, C(0));
      if (cc === 'g') return B('>', f.a, C(0));
      if (cc === 'le') return B('<=', f.a, C(0));
      if (cc === 'o' || cc === 'no') return RAW(cc === 'o' ? 'Overflow' : 'Not Overflow');
    }
    return RAW(`cond_${cc}`);
  }

  /** Comparisons against 0 of comparator/boolean results become direct relations. */
  simplifyCmp(op: string, a: E, b: E): E {
    const ua = unref(a), ub = unref(b);
    if (a.k === 'ref' && ((ua.k === 'call' && (ua.cmp0 || ua.bool)) || (ua.k === 'b' && ['=', '<>', '<', '>', '<=', '>=', 'Is', 'Like'].includes(ua.op))) && ub.k === 'c' && ub.v === 0) this.consumed.add(a.def);
    if (ub.k === 'c' && ub.v === 0 && ua.k === 'call') {
      if (ua.cmp0 && (op === '=' || op === '<>')) {
        // comparator: 0 means equal
        const [l, r] = ua.args;
        const rel = ua.cmp0;
        const rr: E = { k: 'b', op: rel, l, r };
        return op === '=' ? rr : negate(rr);
      }
      if (ua.bool && (op === '=' || op === '<>')) return op === '<>' ? a : negate(a);
    }
    if (ub.k === 'c' && ub.v === 0 && ua.k === 'b' && ['=', '<>', '<', '>', '<=', '>=', 'And', 'Or', 'Like', 'Is'].includes(ua.op) && (op === '=' || op === '<>')) {
      return op === '<>' ? a : negate(a);
    }
    if (ub.k === 'c' && ub.v === 0 && ua.k === 'u' && ua.op === 'Not' && (op === '=' || op === '<>')) return op === '<>' ? a : negate(a);
    return { k: 'b', op, l: a, r: b };
  }

  private execCall(i: Insn, st: State) {
    const o = i.ops[0];
    if (!(o.t === 'm' && o.base && (o.disp === 4 || o.disp === 8))) this.inPrologue = false;
    const rtName = this.callName(i, st);
    const va = i.va;
    st.flags = { k: 'none' };
    if (rtName) {
      const ctx: RtCtx = this.rtCtx(st, va);
      runtimeCall(rtName, ctx);
      st.regs.ecx = st.regs.ecx && this.isStable(st.regs.ecx) ? st.regs.ecx : undefined;
      st.regs.edx = undefined;
      return;
    }
    // direct call to a procedure or API declare stub
    if (o.t === 'j') {
      const t = o.v!;
      const decl = this.an.declareStubs.get(t);
      const f = this.an.funcByVA.get(t);
      if (decl) {
        const n = this.pendingArgCount(st);
        const args = this.popArgs(st, n).map(a => this.byRefArg(a, st));
        this.callResult(st, { k: 'call', f: decl.func, args, target: t }, va);
        return;
      }
      if (f) {
        let n = f.argBytes / 4;
        if (!f.argBytes) n = this.pendingArgCount(st);
        const rawArgs = this.groupVariants(this.popArgs(st, n), st);
        const args = rawArgs.map(a => this.byRefArg(a, st));
        let callArgs = args;
        let name = f.name;
        if (f.obj >= 0 && f.obj !== this.f.obj) name = this.an.project.objects[f.obj].name + '.' + f.name;
        if ((f.kind === 'method' || f.kind === 'event') && f.obj >= 0 && this.an.project.objects[f.obj].kind !== 'Module') {
          // direct call to an object's method: first argument is the instance
          const me = args[0];
          callArgs = args.slice(1);
          if (me && printE(me) === 'Me') name = f.name;
          if (callArgs.length && hasHiddenRet(this.an, f)) {
            const outAddr = rawArgs[rawArgs.length - 1];
            callArgs = callArgs.slice(0, -1);
            if (outAddr) {
              this.store(outAddr, { k: 'call', f: name, args: callArgs, target: t }, st, va);
              st.regs.eax = C(0);
              return;
            }
          }
        }
        this.callResult(st, { k: 'call', f: name, args: callArgs, target: t }, va);
        return;
      }
      const n = this.pendingArgCount(st);
      const args = this.popArgs(st, n);
      this.callResult(st, { k: 'call', f: `sub_${hex(t)}`, args, target: t }, va);
      return;
    }
    // vtable call: call [reg + off]
    if (o.t === 'm' && o.base) {
      const vt = unref(st.regs[REG32[o.base]] ?? { k: 'reg', r: o.base });
      const off = o.disp ?? 0;
      const thisArg = st.slots.get(st.esp) ?? RAW('?');
      let objE: E = thisArg;
      if (vt.k === 'm' && vt.off === 0) objE = vt.base;
      const r = this.resolveVCall(va, objE, off);
      let n: number;
      if (r.params !== undefined) n = 1 + r.params;
      else n = Math.max(1, this.pendingArgCount(st));
      const args = this.popArgs(st, n);
      const rest = args.slice(1);
      const target = r.target;
      if (r.ctl) {
        // control getter: returns the control object in eax
        st.regs.eax = { k: 'mc', o: objE, n: r.name, args: [], kind: 'get' };
        return;
      }
      if (r.kind === 'get') {
        // last parameter is the [out, retval] pointer
        const out = rest.pop();
        const e: E = { k: 'mc', o: objE, n: r.name, args: rest.map(a => this.byRefArg(a, st)), kind: 'get', target };
        if (out) this.store(out, e, st, va);
        st.regs.eax = C(0);
        return;
      }
      if (r.kind === 'let' || r.kind === 'set') {
        const valArg = rest.pop();
        let v = valArg ? this.byRefArg(valArg, st) : RAW('?');
        const ty = r.types?.[r.types.length - 1] ?? '';
        const uv = unref(v);
        if (/Boolean/.test(ty) && uv.k === 'c') v = C(uv.v ? -1 : 0, 'bool');
        const dst: E = { k: 'mc', o: objE, n: r.name, args: rest.map(a => this.byRefArg(a, st)), kind: 'get' };
        this.emit({ k: 'assign', va, dst, src: v, set: r.kind === 'set' });
        st.regs.eax = C(0);
        return;
      }
      if (r.name === 'AddRef' || r.name === 'Release' || r.name === 'QueryInterface') { st.regs.eax = C(0); return; }
      // method: for project methods, the last ByRef param may be the function result
      const tf = target !== undefined ? this.an.funcByVA.get(target) : undefined;
      if (tf && rest.length && hasHiddenRet(this.an, tf)) {
        const out = rest.pop()!;
        const e: E = { k: 'mc', o: objE, n: r.name, args: rest.map(a => this.byRefArg(a, st)), kind: 'method', target };
        this.store(out, e, st, va);
        st.regs.eax = C(0);
        return;
      }
      // unknown interface: a compiler temporary passed last is the [out, retval] result
      if (/^Method_/.test(r.name) && rest.length) {
        const last = unref(rest[rest.length - 1]);
        if (last.k === 'sp' && this.freedSlots.has(last.o) && last.o >= this.localsBottom) {
          const out = rest.pop()!;
          this.store(out, { k: 'mc', o: objE, n: r.name, args: rest.map(a => this.byRefArg(a, st)), kind: rest.length ? 'method' : 'get', target }, st, va);
          st.regs.eax = C(0);
          return;
        }
      }
      const e: E = { k: 'mc', o: objE, n: r.name, args: rest.map(a => this.byRefArg(a, st)), kind: 'method', target };
      this.emit({ k: 'expr', va, e });
      st.regs.eax = C(0);
      return;
    }
    // indirect call through register / memory
    const n = this.pendingArgCount(st);
    const args = this.popArgs(st, n);
    this.callResult(st, { k: 'call', f: `CallPtr_${printE(this.val(o, st)).replace(/\W+/g, '_')}`, args }, va);
  }

  /** Collapse 16-byte by-value Variants (4 stack dwords) into a single argument. */
  groupVariants(args: E[], st: State): E[] {
    const out: E[] = [];
    const VT = new Set([2, 3, 4, 5, 6, 7, 8, 9, 0xa, 0xb, 0xc, 0x11, 0x4008, 0x4003, 0x400c, 0x4002, 0x400b, 0x2008, 0x200c]);
    for (let k = 0; k < args.length; k++) {
      const a = unref(args[k]);
      if (k + 3 < args.length) {
        if (a.k === 'c' && VT.has(a.v & 0xffff)) {
          const t = a.v & 0xffff;
          for (let j = 0; j < 4; j++) { const x = args[k + j]; if (x.k === 'ref' && j !== 2) this.consumed.add(x.def); }
          const v = args[k + 2];
          if (t === 0xa) out.push({ k: 'missing' });
          else if (t === 0xb) { const u = unref(v); out.push(u.k === 'c' ? C(u.v ? -1 : 0, 'bool') : v); }
          else if (t & 0x4000) out.push(this.lv(v));
          else out.push(v);
          k += 3;
          continue;
        }
        // copy of a local variant: slots o, o+4, o+8, o+12
        const names = [0, 1, 2, 3].map(j => { const x = unref(args[k + j]); return x.k === 'v' ? x.slot : undefined; });
        if (names[0] && names.every((n, j) => n && Number(n.slice(5)) === Number(names[0]!.slice(5)) + 4 * j)) {
          out.push(this.slotE(Number(names[0]!.slice(5))));
          k += 3;
          continue;
        }
      }
      out.push(args[k]);
    }
    void st;
    return out;
  }

  isStable(e: E) { const u = unref(e); return u.k === 'raw' && u.t.startsWith('@import:'); }

  /** Arguments passed by address print as the variable itself. */
  byRefArg(a: E, st: State): E {
    if (!a) return RAW('?');
    const u = unref(a);
    if (u.k === 'sp' && u.o < this.localsBottom) return this.variantAt(a, st);
    if (u.k === 'sp') {
      const v = st.slots.get(u.o);
      // a temp holding a computed value (e.g. string/variant temp) -> use its value;
      // a variable that was only zero-initialised by the prologue is passed itself
      if (v && v !== ZERO_INIT && unref(v).k !== 'sp') return v;
      return this.slotE(u.o);
    }
    if (u.k === 'a') return u.e;
    return a;
  }

  callResult(st: State, call: E, va: number) {
    const s: AssignStmt = { k: 'assign', va, dst: V('__tmp'), src: call, temp: true };
    this.emit(s);
    st.regs.eax = { k: 'ref', def: s };
    st.regs.ecx = undefined;
    st.regs.edx = undefined;
  }

  rtCtx(st: State, va: number): RtCtx {
    const self = this;
    const nx = self.nextInsn;
    const cdecl = nx && nx.mn === 'add' && nx.ops[0].t === 'r' && nx.ops[0].r === 'esp' && nx.ops[1].t === 'i' ? nx.ops[1].v! / 4 : undefined;
    return {
      va,
      pop: (n: number) => self.popArgs(st, n, cdecl === undefined),
      pending: () => self.pendingArgCount(st),
      reg: (r: string) => st.regs[r] ?? { k: 'reg', r },
      setReg: (r: string, v: E | undefined) => { st.regs[r] = v; },
      fpuPush: (e: E) => { st.fpu.unshift(e); },
      fpuPop: () => st.fpu.shift() ?? RAW('st0'),
      emit: (s: Stmt) => self.emit(s),
      store: (addr: E, v: E, opts?: { set?: boolean }) => self.store(addr, v, st, va, opts),
      lv: (addr: E) => self.lv(addr),
      variant: (addr: E) => self.variantAt(addr, st),
      deref: (addr: E) => self.load(addr, 4, st),
      result: (e: E) => self.callResult(st, e, va),
      onError: () => { self.onErrorSeen = true; },
      className: (clsPtr: E) => self.classNameFromPtr(clsPtr),
      dispName: (obj: E, id: number) => self.dispName(obj, id),
      byRef: (a: E) => self.byRefArg(a, st),
      alloc: (n: number) => { st.esp -= n; },
      cstr: (a: number) => {
        const img = self.an.img;
        if (!img.isMapped(a)) return undefined;
        const w = img.wstr(a, 128);
        if (/^[A-Za-z_]\w+$/.test(w)) return w;
        const t = img.cstr(a, 128);
        return /^[A-Za-z_][\w]*$/.test(t) ? t : undefined;
      },
      cdecl,
      setSlotValue: (addr: E, v: E) => {
        const u = unref(addr);
        if (u.k === 'sp') st.slots.set(u.o, v);
      },
      peek: (n: number) => this.popArgs(st, n, false),
      freed: (addr: E) => { const u = unref(addr); if (u.k === 'sp') this.freedSlots.add(u.o); },
    };
  }

  /** Class of a control expression (Me.Text1, Form1.Grid, Me.Opt(2)). */
  controlClassOf(o: E): KnownClass | undefined {
    let u = unref(o);
    if (u.k === 'mc' && u.n === '') u = unref(u.o); // control array item
    if (!(u.k === 'mc' && u.kind === 'get' && !u.args.length)) return undefined;
    const owner = this.ifaceFor(0, u.o).projObj;
    if (!owner) return undefined;
    const pf = this.env.forms?.get(owner.index);
    const name = (u as { n: string }).n;
    const cn = pf?.controls.find(c => c.name === name)?.className ?? owner.controls.find(c => c.name === name)?.className;
    if (!cn) return undefined;
    return VB_CLASSES_BY_NAME[cn] ?? VB_CLASSES_BY_NAME[cn.split('.').pop()!];
  }
  dispName(obj: E, id: number): string | undefined {
    const cls = this.controlClassOf(obj);
    if (!cls) return undefined;
    const d = cls.dispids[String(id)] ?? cls.dispids[String(id >>> 0)];
    return d?.name;
  }
  classNameFromPtr(p: E): string {
    const u = unref(p);
    if (u.k === 'c' || (u.k === 'raw' && /^[0-9]/.test(u.t))) {
      const va = u.k === 'c' ? u.v >>> 0 : 0;
      const img = this.an.img;
      // pointer to ObjectInfo of a project class / form, or to a CLSID
      for (const o of this.an.project.objects) if (o.infoVA === va || o.descVA === va) return o.name;
      if (img.isMapped(va) && img.u32(va) >= 1 && img.u32(va) <= 3 && img.isMapped(img.u32(va + 4))) {
        const clsid = img.guid(img.u32(va + 4));
        if (clsid === '{FCFB3D23-A0FA-1068-A738-08002B3371B5}') return 'Global';
        for (const k of Object.values(VB_CLASSES_BY_NAME)) if (k.clsid === clsid) return k.name;
        const comp = this.an.project.components.find(c => c.guid === clsid);
        if (comp) return comp.libName || comp.name;
        return clsid;
      }
      if (img.isMapped(va)) {
        const g = img.guid(va);
        for (const k of Object.values(VB_CLASSES_BY_NAME)) if (k.clsid === g) return k.name;
        const comp = this.an.project.components.find(c => c.guid === g);
        if (comp) return comp.libName || comp.name;
        const pe = img.u32(va);
        for (const o of this.an.project.objects) if (o.infoVA === pe || o.descVA === pe) return o.name;
        if (g) return g;
      }
    }
    if (u.k === 'raw') return u.t;
    return 'Object';
  }

  // --- driver -------------------------------------------------------------------------
  run(): DecompileResult {
    this.scanIIDs();
    this.simplifyCFG();
    this.computeLocalsBottom();
    const order = this.reversePostOrder();
    const rpo = new Map<number, number>();
    order.forEach((b, k) => rpo.set(b, k));
    for (const [b, ss] of this.succ) for (const t of ss) if ((rpo.get(t) ?? 0) <= (rpo.get(b) ?? 0)) this.backTargets.add(t);
    const liveIn = this.liveness(order);
    // pass 1: register values at block exits; pass 2: final statements
    let exitRegs = new Map<number, Record<string, E | undefined>>();
    const regVarNeeded = new Map<number, Set<string>>(); // pred block -> registers to materialize at its end
    for (let pass = 0; pass < 4; pass++) {
      const final = pass === 3;
      this.stmts = []; this.retVals = []; this.blockStmts.clear(); this.blockCond.clear(); this.consumed.clear();
      const newExit = new Map<number, Record<string, E | undefined>>();
      const exitFull = new Map<number, State>();
      for (const start of order) {
        const b = this.blocks.get(start)!;
        if (this.noise.has(start)) continue;
        let st = this.initialState();
        st.esp = start === this.f.va ? 0 : this.localsBottom;
        const preds = this.predsOf(start);
        const chainPred = preds.length === 1 && (this.succ.get(preds[0]) ?? []).length === 1 && exitFull.has(preds[0]) ? preds[0] : undefined;
        if (chainPred !== undefined) {
          const ps = exitFull.get(chainPred)!;
          st = { regs: { ...ps.regs }, esp: ps.esp, slots: new Map(ps.slots), fpu: [...ps.fpu], flags: { ...ps.flags }, pushes: [...ps.pushes] };
        } else {
          const lookup = new Map([...exitRegs, ...newExit]);
          st.regs = this.entryRegs(start, lookup, liveIn, final, regVarNeeded);
        }
        this.cur = [];
        this.inPrologue = start === this.f.va;
        this.execBlock(b, st);
        // terminator
        const last = b.insns[b.insns.length - 1];
        const succ = this.succ.get(start) ?? [];
        let cond: E | undefined;
        if (last && (last.mn[0] === 'j' && last.mn !== 'jmp')) {
          const taken = last.ops[0]?.v ?? 0;
          const fall = last.va + last.len;
          const cc = last.mn.slice(1);
          const takenNoise = this.noise.has(taken) || !this.blocks.has(taken);
          const fallNoise = this.noise.has(fall);
          if (cc === 'o' || cc === 'no') { this.succ.set(start, succ.filter(x => !this.noise.has(x))); this.predCache = undefined; }
          else if (takenNoise && !fallNoise) { this.succ.set(start, [fall]); this.predCache = undefined; }
          else if (fallNoise && !takenNoise) { this.succ.set(start, [taken]); this.predCache = undefined; }
          else if (succ.length === 2) { cond = this.condition(cc, st); this.blockCond.set(start, { cond, taken, fall }); }
        }
        // materialize register variables needed by successors
        if (final) {
          for (const r of regVarNeeded.get(start) ?? []) {
            const v = st.regs[r];
            if (!v) continue;
            const u = unref(v);
            if (u.k === 'v' && u.n === `reg_${r}`) continue;
            this.cur.push({ k: 'assign', va: last?.va ?? start, dst: V(`reg_${r}`), src: v, idx: this.stmts.length } as AssignStmt);
            this.stmts.push(this.cur[this.cur.length - 1]);
          }
        }
        this.blockStmts.set(start, this.cur);
        newExit.set(start, { ...st.regs });
        exitFull.set(start, st);
        this.exitSlots.set(start, st.slots);
      }
      if (!final) {
        exitRegs = newExit;
        regVarNeeded.clear();
        // decide which registers need variables
        for (const blk of order) {
          const live = liveIn.get(blk);
          if (!live) continue;
          const preds = this.predsOf(blk);
          if (preds.length === 1 && (this.succ.get(preds[0]) ?? []).length === 1) continue;
          const merged = this.entryRegs(blk, exitRegs, liveIn, false, new Map());
          for (const r of live) {
            const vals = preds.map(p => exitRegs.get(p)?.[r]);
            const same = merged[r] !== undefined;
            if (!same && vals.some(v => v)) for (const p of preds) {
              const set = regVarNeeded.get(p) ?? new Set<string>();
              set.add(r);
              regVarNeeded.set(p, set);
            }
          }
        }
      }
    }
    this.detectReturn();
    this.postProcess();
    const lines = this.structure(order);
    return {
      lines,
      header: this.signature(),
      errors: this.errors,
      stats: { blocks: this.fc.blocks.length, statements: this.stmts.length, gotos: this.gotoCount },
    };
  }

  private predCache?: Map<number, number[]>;
  predsOf(b: number): number[] {
    if (!this.predCache) {
      this.predCache = new Map();
      for (const [x, ss] of this.succ) {
        if (this.noise.has(x)) continue;
        for (const t of ss) { const l = this.predCache.get(t); if (l) l.push(x); else this.predCache.set(t, [x]); }
      }
    }
    return this.predCache.get(b) ?? [];
  }

  /** A register value that can be carried into another block, or undefined. */
  propagatable(v: E): E | undefined {
    if (v.k === 'ref' && !(v.def as AssignStmt).temp && (v.def as AssignStmt).dst.k === 'v') return (v.def as AssignStmt).dst;
    const u = unref(v);
    if ((u.k === 'raw' && u.t.startsWith('@import:')) || u.k === 'v' || u.k === 'c' || (u.k === 'm' && isPure(u) && unref(u.base).k === 'v')) return u;
    return undefined;
  }

  exitSlots = new Map<number, Map<number, E>>();
  private entryRegs(b: number, exits: Map<number, Record<string, E | undefined>>, liveIn: Map<number, Set<string>>, final: boolean,
    regVarNeeded: Map<number, Set<string>>): Record<string, E | undefined> {
    const preds = this.predsOf(b);
    const out: Record<string, E | undefined> = {};
    if (!preds.length) return out;
    const live = liveIn.get(b) ?? new Set<string>();
    for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi']) {
      const vals = preds.map(p => exits.get(p)?.[r]);
      const props = vals.map(v => (v ? this.propagatable(v) : undefined));
      // a register equal (in some predecessor) to the current content of the variable it aliases elsewhere
      const varCand = props.find(x => x && x.k === 'v' && x.slot);
      if (varCand && varCand.k === 'v') {
        const o = Number(varCand.slot!.slice(5));
        props.forEach((x, k) => {
          if (!x || printE(x) === printE(varCand)) return;
          const slotV = this.exitSlots.get(preds[k])?.get(o);
          if (slotV && printE(unref(slotV)) === printE(unref(x))) props[k] = varCand;
        });
      }
      if (props.every(x => x !== undefined) && props.every(x => printE(x!) === printE(props[0]!))) { out[r] = props[0]; continue; }
      const known = props.filter(x => x !== undefined) as E[];
      // import pointers cached in registers: the compiler guarantees the value on every path that calls it
      if (known.length && known.every(x => { const u = unref(x); return u.k === 'raw' && u.t.startsWith('@import:') && printE(x) === printE(known[0]); })) { out[r] = known[0]; continue; }
      // stable values survive even when unknown on a back edge (pass 1)
      if (!final && known.length && known.every(x => printE(x) === printE(known[0])) && vals.some(v => v === undefined)) {
        const u = unref(known[0]);
        if ((u.k === 'raw' && u.t.startsWith('@import:')) || (u.k === 'v' && u.n === 'Me')) { out[r] = known[0]; continue; }
      }
      if (final && live.has(r) && preds.some(p => regVarNeeded.get(p)?.has(r))) out[r] = V(`reg_${r}`);
    }
    return out;
  }

  /** Backward liveness of the general purpose registers. */
  private liveness(order: number[]): Map<number, Set<string>> {
    const GP = new Set(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi']);
    const useDef = new Map<number, { use: Set<string>; def: Set<string> }>();
    for (const start of order) {
      const b = this.blocks.get(start)!;
      const use = new Set<string>(), def = new Set<string>();
      const u = (r?: string) => { const f = r && REG32[r]; if (f && GP.has(f) && !def.has(f)) use.add(f); };
      const d = (r?: string) => { const f = r && REG32[r]; if (f && GP.has(f)) def.add(f); };
      for (const i of b.insns) {
        const ops = i.ops;
        for (const o of ops) if (o.t === 'm') { u(o.base); u(o.idx); }
        const mn = i.mn;
        if (mn === 'xor' && ops[0]?.t === 'r' && ops[1]?.t === 'r' && ops[0].r === ops[1].r) { d(ops[0].r); continue; }
        if (mn === 'call') { if (ops[0].t === 'r') u(ops[0].r); d('eax'); d('ecx'); d('edx'); continue; }
        if (['mov', 'lea', 'movzx', 'movsx', 'pop'].includes(mn) || mn.startsWith('set')) {
          if (ops[1]?.t === 'r') u(ops[1].r);
          if (ops[0]?.t === 'r') d(ops[0].r);
          continue;
        }
        if (mn === 'cdq') { u('eax'); d('edx'); continue; }
        if (mn === 'idiv' || mn === 'div') { u('eax'); u('edx'); if (ops[0].t === 'r') u(ops[0].r); d('eax'); d('edx'); continue; }
        for (const o of ops) if (o.t === 'r') u(o.r);
        if (ops[0]?.t === 'r' && !['cmp', 'test', 'push'].includes(mn) && mn[0] !== 'j') d(ops[0].r);
      }
      useDef.set(start, { use, def });
    }
    const liveIn = new Map<number, Set<string>>();
    for (const b of order) liveIn.set(b, new Set(useDef.get(b)!.use));
    for (let it = 0; it < 30; it++) {
      let changed = false;
      for (const b of [...order].reverse()) {
        const ud = useDef.get(b)!;
        const out = new Set<string>();
        for (const sx of this.succ.get(b) ?? []) for (const r of liveIn.get(sx) ?? []) out.add(r);
        const inn = new Set(ud.use);
        for (const r of out) if (!ud.def.has(r)) inn.add(r);
        const old = liveIn.get(b)!;
        if (inn.size !== old.size) { liveIn.set(b, inn); changed = true; }
      }
      if (!changed) break;
    }
    return liveIn;
  }
  gotoCount = 0;

  private computeLocalsBottom() {
    const entry = this.blocks.get(this.f.va);
    let esp = 0, chk = 0;
    if (entry) {
      let prev: Insn | undefined;
      for (const i of entry.insns) {
        const p0 = prev; prev = i;
        // "mov [ebp-X], esp" saves the stack pointer for the SEH frame: the prologue is over
        if (i.mn === 'mov' && i.ops[0].t === 'm' && i.ops[0].base === 'ebp' && i.ops[1].t === 'r' && i.ops[1].r === 'esp' && esp < -8) break;
        if (i.mn === 'push') esp -= 4;
        else if (i.mn === 'pop') esp += 4;
        else if (i.mn === 'sub' && i.ops[0].r === 'esp' && i.ops[1].t === 'i') esp -= i.ops[1].v!;
        else if (i.mn === 'mov' && i.ops[0].r === 'eax' && i.ops[1].t === 'i') chk = i.ops[1].v!;
        else if (i.mn === 'call' && i.ops[0].t === 'm' && !i.ops[0].base && this.an.iatNames.get((i.ops[0].disp ?? 0) >>> 0) === '__vbaChkstk') { esp -= chk; continue; }
        else if (i.mn === 'mov' && i.ops[0].r === 'esp') break;
        else if (i.mn === 'call') {
          // first call after prologue ends it (AddRef or runtime call)
          if (!(i.ops[0].t === 'm' && i.ops[0].base) && p0?.mn === 'push') { esp += 4; /* pushed arg is part of the call */ }
          break;
        }
        if (i.mn === 'push' && i.ops[0].t === 'r' && i.ops[0].r === 'edi') { /* end of callee-saved pushes */ }
      }
    }
    // locals live above the deepest point reached by the prologue (minus saved regs)
    this.localsBottom = esp;
    if (entry) {
      for (const i of entry.insns) {
        if (i.mn === 'mov' && i.ops[0].t === 'm' && i.ops[0].base === 'ebp' && i.ops[1].t === 'r' && i.ops[1].r === 'esp') {
          this.frameTop = (i.ops[0].disp ?? 0) - 4;
          break;
        }
      }
    }
  }

  private reversePostOrder(): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    const visit = (s: number) => {
      const stack: [number, number][] = [[s, 0]];
      seen.add(s);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const succ = this.succ.get(top[0]) ?? [];
        if (top[1] < succ.length) {
          const n = succ[top[1]++];
          if (!seen.has(n) && this.blocks.has(n)) { seen.add(n); stack.push([n, 0]); }
        } else { out.push(top[0]); stack.pop(); }
      }
    };
    visit(this.f.va);
    // unreachable roots (error handlers / resume labels)
    for (const b of this.fc.blocks) if (!seen.has(b.start) && !this.noise.has(b.start)) visit(b.start);
    return out.reverse();
  }

  // --- post processing: temp inlining ------------------------------------------------
  private postProcess() {
    const uses = new Map<AssignStmt, number[]>();
    const owner = new Map<Stmt, number>();
    this.stmts.forEach((s, ix) => owner.set(s, ix));
    const collect = (e: E, userIdx: number) => {
      walkE(e, x => {
        if (x.k === 'ref') {
          const d = x.def as AssignStmt;
          const l = uses.get(d);
          if (l) l.push(userIdx); else uses.set(d, [userIdx]);
          collect(d.src, userIdx); // nested refs used through this def count for the same user
        }
      });
    };
    // count direct uses (each ref occurrence)
    const direct = new Map<AssignStmt, number[]>();
    this.stmts.forEach((s, ix) => {
      const exprs: E[] = s.k === 'assign' ? [s.src, s.dst] : s.k === 'expr' ? [s.e] : [];
      for (const e of exprs) walkE(e, x => {
        if (x.k === 'ref') { const d = x.def as AssignStmt; const l = direct.get(d); if (l) l.push(ix); else direct.set(d, [ix]); }
      });
    });
    for (const [, l] of this.blockCond) if (l) walkE(l.cond, x => {
      if (x.k === 'ref') { const d = x.def as AssignStmt; const li = direct.get(d); if (li) li.push(Infinity); else direct.set(d, [Infinity]); }
    });
    void collect; void uses;
    // variables also read by name somewhere (not through the defining statement)
    const byName = new Map<string, number>();
    const countNames = (e: E) => walkE(e, x => { if (x.k === 'v') byName.set(x.n, (byName.get(x.n) ?? 0) + 1); });
    for (const st of this.stmts) {
      if (st.k === 'assign') { countNames(st.src); if (st.dst.k !== 'v') countNames(st.dst); }
      else if (st.k === 'expr') countNames(st.e);
    }
    for (const [, l] of this.blockCond) if (l) countNames(l.cond);
    for (const s of this.stmts) {
      if (s.k !== 'assign') continue;
      if (this.consumed.has(s)) { s.inline = true; continue; }
      const u = direct.get(s) ?? [];
      const isTempSlot = s.dst.k === 'v' && !!s.dst.slot && this.freedSlots.has(Number(s.dst.slot.slice(5)));
      if (u.length === 1 && (s.temp || (isLocal(s.dst) && (isTempSlot || !byName.get((s.dst as { n: string }).n))))) {
        s.inline = true;
      } else if (u.length > 1 && s.temp) {
        if (isPure(s.src)) s.inline = true;
        else { s.dst = V(`tmp${++this.tmpCounter}`); s.temp = false; }
      } else if (u.length === 0 && s.temp) {
        // call whose result is unused -> expression statement
      }
    }
    // remove assignments to locals that are never read (compiler temporaries)
    const reads = new Map<string, number>();
    const countReads = (e: E) => walkE(e, x => {
      if (x.k === 'v') reads.set(x.n, (reads.get(x.n) ?? 0) + 1);
      if (x.k === 'ref') { const d = x.def as AssignStmt; if (!d.inline) { const n = printE(d.dst); reads.set(n, (reads.get(n) ?? 0) + 1); } else countReads(d.src); }
    });
    for (const st of this.stmts) {
      if (st.k === 'assign') { if (!st.inline) { countReads(st.src); if (st.dst.k !== 'v') countReads(st.dst); } }
      else if (st.k === 'expr') countReads(st.e);
      else if (st.k === 'text') for (const m of st.t.matchAll(/\b(var_[0-9A-F]+|tmp\d+)\b/g)) reads.set(m[1], (reads.get(m[1]) ?? 0) + 1);
    }
    for (const [, l] of this.blockCond) if (l) countReads(l.cond);
    for (const st of this.stmts) {
      if (st.k !== 'assign' || st.inline || st.temp) continue;
      if (isLocal(st.dst) && !reads.get((st.dst as { n: string }).n) && (st.src.k === 'ref' || isPure(st.src))) {
        st.inline = true;
        // never let a call vanish with its only (dead) consumer: show it as a statement instead
        let d = st.src.k === 'ref' ? (st.src.def as AssignStmt) : undefined;
        while (d && d.inline && d.src.k === 'ref') d = d.src.def as AssignStmt;
        if (d && d.inline && !isPure(d.src) && !(d.temp && d.dst.k === 'v' && d.dst.n === '__tmp')) d.inline = false;
      }
    }
    // temporaries whose other consumers were just removed (e.g. copies kept for HRESULT checks)
    const dead = (ix: number) => {
      const c = this.stmts[ix];
      return !!c && c.k === 'assign' && !!c.inline && isLocal(c.dst) && !reads.get((c.dst as { n: string }).n);
    };
    for (const st of this.stmts) {
      if (st.k !== 'assign' || st.inline || !isLocal(st.dst)) continue;
      const d = st.dst as { slot?: string };
      if (!d.slot || !this.freedSlots.has(Number(d.slot.slice(5)))) continue;
      const live = (direct.get(st) ?? []).filter(ix => !dead(ix));
      if (live.length === 1) st.inline = true;
    }
    function isLocal(d: E) { return d.k === 'v' && /^var_/.test(d.n); }
  }

  // --- structuring ---------------------------------------------------------------------
  private structure(order: number[]): Line[] {
    const lines: Line[] = [];
    const preds = new Map<number, number[]>();
    for (const [b, ss] of this.succ) for (const s of ss) { const l = preds.get(s); if (l) l.push(b); else preds.set(s, [b]); }
    const rpoIndex = new Map<number, number>();
    order.forEach((b, i) => rpoIndex.set(b, i));
    // dominators (iterative)
    const idom = new Map<number, number>();
    const entry = this.f.va;
    idom.set(entry, entry);
    const intersect = (a: number, b: number) => {
      let g = 0;
      while (a !== b && g++ < 100000) {
        while ((rpoIndex.get(a) ?? 0) > (rpoIndex.get(b) ?? 0)) a = idom.get(a) ?? entry;
        while ((rpoIndex.get(b) ?? 0) > (rpoIndex.get(a) ?? 0)) b = idom.get(b) ?? entry;
      }
      return a;
    };
    for (let it = 0; it < 20; it++) {
      let changed = false;
      for (const b of order) {
        if (b === entry) continue;
        const ps = (preds.get(b) ?? []).filter(p => idom.has(p));
        if (!ps.length) continue;
        let nd = ps[0];
        for (const p of ps.slice(1)) nd = intersect(p, nd);
        if (idom.get(b) !== nd) { idom.set(b, nd); changed = true; }
      }
      if (!changed) break;
    }
    const dominates = (a: number, b: number) => { let x = b, g = 0; while (g++ < 10000) { if (x === a) return true; const d = idom.get(x); if (d === undefined || d === x) return x === a; x = d; } return false; };
    // loops: back edges
    const loopHeaders = new Map<number, Set<number>>();
    for (const [b, ss] of this.succ) for (const s of ss) if (idom.has(b) && dominates(s, b)) {
      // natural loop body
      const body = loopHeaders.get(s) ?? new Set<number>([s]);
      const stack = [b];
      while (stack.length) { const x = stack.pop()!; if (body.has(x)) continue; body.add(x); for (const p of preds.get(x) ?? []) stack.push(p); }
      loopHeaders.set(s, body);
    }
    // post-dominators via reverse CFG with virtual exit
    const ipdom = this.postDominators(order);
    const emitted = new Set<number>();
    const ind = (n: number) => n;
    const emitBlockStmts = (b: number, depth: number) => {
      for (const s of this.blockStmts.get(b) ?? []) {
        const t = this.stmtText(s);
        if (t !== null) lines.push({ text: t, va: s.va, indent: depth, kind: s.k === 'comment' ? 'comment' : 'code' });
      }
    };
    const label = (b: number) => this.labelNames.get(b) ?? `Label_${hex(b)}`;
    interface Ctx { loopHeader?: number; loopExit?: number; loopBody?: Set<number>; latch?: number }
    const visible = (b: number) => (this.blockStmts.get(b) ?? []).some(st => this.stmtText(st) !== null);
    // follow chains of empty single-successor blocks
    const skipEmpty = (b: number | undefined, limit?: number): number | undefined => {
      let g = 0;
      while (b !== undefined && b !== limit && g++ < 50) {
        const ss: number[] = this.succ.get(b) ?? [];
        if (visible(b) || ss.length !== 1 || this.blockCond.get(b) || loopHeaders.has(b)) return b;
        b = ss[0];
      }
      return b;
    };
    const isExitBlock = (b: number) => {
      // block (chain) without visible statements that leaves the procedure
      let x: number | undefined = b, g = 0;
      while (x !== undefined && g++ < 50) {
        if (visible(x) || this.blockCond.get(x)) return false;
        const ss: number[] = this.succ.get(x) ?? [];
        if (!ss.length) return true;
        if (ss.length > 1) return false;
        x = ss[0];
      }
      return false;
    };
    const gotoLine = (target: number, depth: number) => {
      if (isExitBlock(target)) { lines.push({ text: this.retType ? 'Exit Function' : 'Exit Sub', indent: depth }); return; }
      lines.push({ text: `GoTo ${label(target)}`, indent: depth });
      this.usedLabels.add(target);
      this.gotoCount++;
    };
    const emitRegion = (start: number | undefined, stop: number | undefined, depth: number, ctx: Ctx, guard = 0): void => {
      let node = start;
      while (node !== undefined && node !== stop && guard++ < 5000) {
        if (ctx.loopHeader !== undefined && node === ctx.loopHeader && emitted.has(node)) { return; }
        if (ctx.loopExit !== undefined && node === ctx.loopExit) {
          if (!isExitBlock(node) || true) lines.push({ text: 'Exit Do', indent: depth });
          return;
        }
        if (ctx.loopBody && !ctx.loopBody.has(node)) { gotoLine(node, depth); return; }
        if (emitted.has(node)) {
          if (isExitBlock(node) && stop === undefined && ctx.loopHeader === undefined) return;
          gotoLine(node, depth); return;
        }
        const body = loopHeaders.get(node);
        if (body && ctx.loopHeader !== node) {
          node = emitLoopAt(node, body, depth, ctx);
          continue;
        }
        if (ctx.latch !== undefined && node === ctx.latch) return;
        emitted.add(node);
        lines.push({ text: `\u0000${node}`, indent: depth }); // label placeholder
        emitBlockStmts(node, depth);
        const ss = this.succ.get(node) ?? [];
        const cond = this.blockCond.get(node);
        if (cond && ss.length === 2) {
          const join = ipdom.get(node);
          const { taken, fall } = cond;
          const sub = (from: number, cnd: E) => {
            const mark = lines.length;
            lines.push({ text: `If ${printE(cnd)} Then`, indent: depth, va: this.lastVA(node!) });
            emitRegion(from, join, depth + 1, ctx);
            return mark;
          };
          if (taken === join) {
            sub(fall, negate(cond.cond));
            lines.push({ text: 'End If', indent: depth });
          } else if (fall === join) {
            sub(taken, cond.cond);
            lines.push({ text: 'End If', indent: depth });
          } else {
            const mark = sub(fall, negate(cond.cond));
            const thenLines = lines.length - mark - 1;
            const elseMark = lines.length;
            lines.push({ text: 'Else', indent: depth });
            emitRegion(taken, join, depth + 1, ctx);
            const realThen = lines.slice(mark + 1, elseMark).some(l => !l.text.startsWith('\u0000'));
            if (!realThen) {
              // empty Then: invert the condition and drop the Else
              lines.splice(mark, elseMark - mark + 1, { text: `If ${printE(cond.cond)} Then`, indent: depth, va: this.lastVA(node) });
            }
            void thenLines;
            lines.push({ text: 'End If', indent: depth });
          }
          if (join === undefined) return;
          node = join;
          continue;
        }
        if (ss.length === 0) return;
        if (ss.length > 1) {
          for (const x of ss.slice(1)) { lines.push({ text: `' also -> ${label(x)}`, indent: depth, kind: 'comment' }); this.usedLabels.add(x); }
        }
        node = ss[0];
      }
    };
    /** Emit a loop starting at header; returns the node following the loop. */
    const emitLoopAt = (header: number, body: Set<number>, depth: number, outer: Ctx): number | undefined => {
      const exits = new Set<number>();
      for (const x of body) for (const t of this.succ.get(x) ?? []) if (!body.has(t)) exits.add(t);
      const exit = [...exits].sort((a, b) => (rpoIndex.get(a) ?? 0) - (rpoIndex.get(b) ?? 0))[0];
      const inner: Ctx = { loopHeader: header, loopExit: exit, loopBody: body };
      const hc = this.blockCond.get(header);
      // Do While form: header only tests a condition
      if (hc && !visible(header) && (body.has(hc.taken) !== body.has(hc.fall))) {
        const stay = body.has(hc.taken) ? hc.taken : hc.fall;
        const out = stay === hc.taken ? hc.fall : hc.taken;
        const stayCond = stay === hc.taken ? hc.cond : negate(hc.cond);
        emitted.add(header);
        lines.push({ text: `\u0000${header}`, indent: depth });
        lines.push({ text: `Do While ${printE(stayCond)}`, indent: depth, va: this.lastVA(header) });
        emitRegion(stay, header, depth + 1, { ...inner, loopExit: out });
        lines.push({ text: 'Loop', indent: depth });
        void outer;
        return out;
      }
      // Do ... Loop While form: a latch block tests the condition at the bottom
      for (const l of body) {
        const lc = this.blockCond.get(l);
        if (!lc || l === header) continue;
        const tTo = skipEmpty(lc.taken), fTo = skipEmpty(lc.fall);
        const tBack = tTo === header && body.has(lc.taken), fBack = fTo === header && body.has(lc.fall);
        const tOut = !body.has(lc.taken), fOut = !body.has(lc.fall);
        if ((tBack && fOut) || (fBack && tOut)) {
          const out = tBack ? lc.fall : lc.taken;
          const contCond = tBack ? lc.cond : negate(lc.cond);
          lines.push({ text: 'Do', indent: depth, va: header });
          emitRegion(header, l, depth + 1, { ...inner, latch: l, loopExit: out });
          if (!emitted.has(l)) {
            emitted.add(l);
            lines.push({ text: `\u0000${l}`, indent: depth + 1 });
            emitBlockStmts(l, depth + 1);
          }
          lines.push({ text: `Loop While ${printE(contCond)}`, indent: depth, va: this.lastVA(l) });
          return out;
        }
      }
      lines.push({ text: 'Do', indent: depth, va: header });
      emitRegion(header, undefined, depth + 1, inner);
      lines.push({ text: 'Loop', indent: depth });
      return exit;
    };
    emitRegion(entry, undefined, 1, {});
    // remaining (error handlers, unreachable from entry)
    let firstRoot = true;
    const preds2 = new Map<number, number>();
    for (const [, ss] of this.succ) for (const t of ss) preds2.set(t, (preds2.get(t) ?? 0) + 1);
    for (const b of order) {
      if (emitted.has(b) || this.noise.has(b)) continue;
      const isRoot = !preds2.get(b);
      if (!isRoot && !this.usedLabels.has(b)) continue;
      if (!visible(b) && !this.blockCond.get(b) && (this.succ.get(b) ?? []).every(t => emitted.has(t) || isExitBlock(t))) continue;
      // regions without any visible statement (unwind/cleanup funclets) are not shown
      {
        const seen = new Set<number>([b]), work = [b];
        let any = false;
        while (work.length && !any) {
          const x = work.pop()!;
          if (visible(x)) { any = true; break; }
          for (const t of this.succ.get(x) ?? []) if (!seen.has(t) && !emitted.has(t)) { seen.add(t); work.push(t); }
        }
        if (!any) continue;
      }
      if (isRoot && firstRoot && this.onErrorSeen) {
        firstRoot = false;
        lines.push({ text: this.retType ? 'Exit Function' : 'Exit Sub', indent: 1 });
        this.labelNames.set(b, 'ErrorHandler');
      }
      lines.push({ text: '', indent: 0 });
      this.usedLabels.add(b);
      emitRegion(b, undefined, 1, {});
    }
    // resolve label placeholders
    const out: Line[] = [];
    for (const l of lines) {
      if (l.text.startsWith('\u0000')) {
        const b = Number(l.text.slice(1));
        if (this.usedLabels.has(b) || this.labelNames.has(b)) out.push({ text: `${label(b)}:`, indent: 0, va: b, kind: 'label' });
        continue;
      }
      out.push(l);
    }
    // drop a trailing "Exit Sub"-like epilogue noise and collapse empty If blocks
    return cleanupLines(out);
  }

  lastVA(b: number) { const blk = this.blocks.get(b); return blk ? blk.insns[blk.insns.length - 1].va : b; }

  private postDominators(order: number[]): Map<number, number | undefined> {
    // compute on reversed graph using iterative dataflow over sets (functions are small)
    const nodes = order.filter(b => !this.noise.has(b));
    const exitNodes = nodes.filter(b => !(this.succ.get(b) ?? []).some(s => nodes.includes(s)));
    const pd = new Map<number, Set<number>>();
    const all = new Set(nodes);
    for (const n of nodes) pd.set(n, exitNodes.includes(n) ? new Set([n]) : new Set(all));
    const rev = [...nodes].reverse();
    for (let it = 0; it < 50; it++) {
      let changed = false;
      for (const n of rev) {
        if (exitNodes.includes(n)) continue;
        const ss = (this.succ.get(n) ?? []).filter(s => all.has(s));
        let inter: Set<number> | undefined;
        for (const s of ss) {
          const ps = pd.get(s)!;
          if (!inter) inter = new Set(ps);
          else for (const x of inter) if (!ps.has(x)) inter.delete(x);
        }
        const nw = inter ?? new Set<number>();
        nw.add(n);
        const old = pd.get(n)!;
        if (old.size !== nw.size || [...nw].some(x => !old.has(x))) { pd.set(n, nw); changed = true; }
      }
      if (!changed) break;
    }
    const ip = new Map<number, number | undefined>();
    for (const n of nodes) {
      const s = pd.get(n)!;
      const cands = [...s].filter(x => x !== n);
      // immediate: the candidate post-dominated by all others (closest)
      let best: number | undefined;
      for (const c of cands) {
        const cs = pd.get(c)!;
        if (cands.every(o => o === c || cs.has(o))) { best = c; break; }
      }
      ip.set(n, best);
    }
    return ip;
  }

  stmtText(s: Stmt): string | null {
    switch (s.k) {
      case 'comment': return `' ${s.t}`;
      case 'text': return s.t;
      case 'expr': {
        const e = unrefOnceForStmt(s.e);
        return stmtCall(e);
      }
      case 'assign': {
        if (s.inline) return null;
        if (s.temp) return stmtCall(s.src);
        const src = unref(s.src);
        if (src.k === 'missing') return null;
        const d = printE(s.dst);
        let v = printE(s.src);
        if (d === v) return null;
        if (s.set && (src.k === 'c' && src.v === 0)) v = 'Nothing';
        return `${s.set ? 'Set ' : ''}${d} = ${v}`;
      }
    }
  }

  signature(): string {
    const f = this.f;
    let nargs = Math.max(0, f.argBytes / 4 - (this.isObjMethod ? 1 : 0));
    if (this.retArgHidden) nargs--;
    const params: string[] = [];
    for (let k = 0; k < nargs; k++) {
      const o = (this.isObjMethod ? 8 : 4) + k * 4;
      params.push(this.slotName(o));
    }
    const kw = f.kind === 'event' || f.kind === 'main' ? 'Private Sub' : this.hasReturn() ? 'Public Function' : 'Public Sub';
    return `${kw} ${f.name}(${params.join(', ')})${this.retType ? ' As ' + this.retType : ''}`;
  }
  hasReturn() { return this.retType !== undefined; }
  retType?: string;
  retArgHidden = false;

  /** Every expression of the procedure (statements and branch conditions). */
  private allExprs(): E[] {
    const out: E[] = [];
    for (const st of this.stmts) {
      if (st.k === 'assign') { out.push(st.src, st.dst); } else if (st.k === 'expr') out.push(st.e);
    }
    for (const [, c] of this.blockCond) if (c) out.push(c.cond);
    return out;
  }

  private renameVar(from: string, to: string) {
    const seen = new Set<E>();
    const visit = (e: E) => walkE(e, x => {
      if (seen.has(x)) return;
      seen.add(x);
      if (x.k === 'v' && x.n === from) x.n = to;
    });
    for (const e of this.allExprs()) visit(e);
    for (const st of this.stmts) if (st.k === 'text') st.t = st.t.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }

  /** Infer a VB type for a variable from the values assigned to it. */
  private inferType(name: string): string | undefined {
    let t: string | undefined;
    for (const st of this.stmts) {
      if (st.k !== 'assign' || st.dst.k !== 'v' || st.dst.n !== name) continue;
      const u = unref(st.src);
      if (st.set) return 'Object';
      if (u.k === 's' || (u.k === 'b' && u.op === '&') || (u.k === 'call' && /\$$|^(CStr|Format|Chr|Space|String)$/.test(u.f))) return 'String';
      if (u.k === 'f' || (u.k === 'call' && /^(CDbl|CSng|Val|Rnd|Timer)$/.test(u.f))) t = 'Double';
      if (u.k === 'c' && u.t === 'bool' || isBoolE(u)) t = t ?? 'Boolean';
      if (u.k === 'call' && /^(CLng|Len|InStr|InStrRev|UBound|LBound)$/.test(u.f)) t = t ?? 'Long';
      if (u.k === 'call' && /^(CInt)$/.test(u.f)) t = t ?? 'Integer';
    }
    return t;
  }

  /** Recognise the function result: a local returned in eax (modules) or the hidden
   *  [out, retval] pointer that object methods write at their exit. */
  private detectReturn() {
    const f = this.f;
    if (f.kind === 'event' || f.kind === 'main') return;
    const fname = f.name;
    if (!this.isObjMethod) {
      // module procedure: eax (or st0) holds a local at every ret
      const names = new Set<string>();
      let fpu = false, ok = this.retVals.length > 0;
      for (const r of this.retVals) {
        const e = r.fpu && unref(r.fpu).k === 'v' ? (fpu = true, r.fpu) : r.eax;
        const u = e ? unref(e) : undefined;
        let n: string | undefined;
        if (e && e.k === 'ref' && (e.def as AssignStmt).dst.k === 'v') n = ((e.def as AssignStmt).dst as { n: string }).n;
        else if (u && u.k === 'v') n = u.n;
        if (!n || !/^var_/.test(n)) { ok = false; break; }
        names.add(n);
      }
      if (!ok || names.size !== 1) return;
      const local = [...names][0];
      const t = fpu ? 'Double' : this.inferType(local);
      this.renameVar(local, fname);
      this.retType = t ?? 'Long';
      return;
    }
    if (f.kind !== 'method') return;
    const nargs = f.argBytes / 4 - 1;
    if (nargs < 1) return;
    const retArg = this.slotName(8 + (nargs - 1) * 4);
    const isRet = (e: E) => { const u = e.k === 'm' ? unref(e.base) : e; return u.k === 'v' && u.n === retArg; };
    const writes: AssignStmt[] = [];
    for (const st of this.stmts) if (st.k === 'assign' && isRet(st.dst)) writes.push(st);
    if (!writes.length) return;
    // the pointer must never be read
    let read = false;
    const exprs: E[] = [];
    for (const st of this.stmts) {
      if (st.k === 'assign') { exprs.push(st.src); if (!writes.includes(st) && st.dst.k !== 'v') exprs.push(st.dst); }
      else if (st.k === 'expr') exprs.push(st.e);
      else if (st.k === 'text' && new RegExp(`\\b${retArg}\\b`).test(st.t)) read = true;
    }
    for (const [, c] of this.blockCond) if (c) exprs.push(c.cond);
    for (const e of exprs) walkE(e, x => { if (x.k === 'v' && x.n === retArg) read = true; });
    if (read) return;
    const fieldWrites = writes.filter(w => w.dst.k === 'm' && (w.dst as { off: number }).off > 0);
    const main = writes.filter(w => !fieldWrites.includes(w));
    const isZero = (e: E) => { const u = unref(e); return u.k === 'c' && u.v === 0; };
    const valueWrites = main.filter(w => !isZero(w.src));
    // initialisation stores (zeroing the caller's slot) disappear
    for (const w of writes) if (isZero(w.src) && !valueWrites.includes(w)) w.inline = true;
    for (const w of fieldWrites) w.inline = true;
    let local: string | undefined;
    for (const w of valueWrites) {
      const uw = unref(w.src);
      if (uw.k === 'raw' && uw.t === 'Empty') { w.inline = true; continue; } // result never assigned
      w.dst = V(fname);
      const u = unref(w.src);
      const n = w.src.k === 'ref' && (w.src.def as AssignStmt).dst.k === 'v' ? ((w.src.def as AssignStmt).dst as { n: string }).n : u.k === 'v' ? u.n : undefined;
      if (n && /^var_/.test(n)) local = local ?? n;
    }
    const variant = fieldWrites.some(w => (w.dst as { off: number }).off === 8);
    let t = variant ? 'Variant' : undefined;
    if (local) { t = t ?? this.inferType(local); this.renameVar(local, fname); }
    this.retType = t ?? (valueWrites.some(w => w.set) ? 'Object' : 'Variant');
    this.retArgHidden = true;
  }
}

function unrefOnceForStmt(e: E): E { return e; }

function isBoolE(e: E): boolean {
  const u = unref(e);
  if (u.k === 'b') return ['=', '<>', '<', '>', '<=', '>=', 'Is', 'Like'].includes(u.op);
  if (u.k === 'call') return !!u.bool || !!u.cmp0;
  if (u.k === 'u' && u.op === 'Not') return isBoolE(u.e);
  return false;
}

function stmtCall(e: E): string {
  const u = e.k === 'ref' ? e : e;
  if (u.k === 'call') {
    if (u.noParens || !u.args.length) return u.args.length ? `${u.f} ${u.args.map(a => printE(a)).join(', ')}` : u.f;
    return `${u.f} ${trimArgs(u.args).map(a => printE(a)).join(', ')}`.trimEnd();
  }
  if (u.k === 'mc') {
    const o = printE(u.o, 15);
    const head = o && o !== 'Global' ? `${o}.${u.n}` : u.n;
    const args = trimArgs(u.args).map(a => printE(a));
    return args.length ? `${head} ${args.join(', ')}` : head;
  }
  return printE(e);
}

function cleanupLines(lines: Line[]): Line[] {
  let out: Line[] = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    // "If x Then" immediately followed by "End If" -> drop both
    if (/^If .* Then$/.test(l.text) && lines[k + 1]?.text === 'End If') { k++; continue; }
    if (l.text === 'Else' && lines[k + 1]?.text === 'End If') continue;
    // auto-instantiation of predeclared form instances
    const m = /^If (\w+) = 0 Then$/.exec(l.text);
    if (m && lines[k + 1]?.text === `Set ${m[1]} = New ${m[1]}` && lines[k + 2]?.text === 'End If') { k += 2; continue; }
    if (m && lines[k + 1]?.text === `Set ${m[1]} = New ${m[1]}` && lines[k + 2]?.text === 'Else') {
      // keep else-part, drop the auto-instantiation
      lines[k + 2] = { ...lines[k + 2], text: `If ${m[1]} Is Nothing Then` };
    }
    out.push(l);
  }
  out = forLoops(out);
  out = elseIfs(out);
  while (out.length && out[out.length - 1].text === '') out.pop();
  return out;
}

/** Do While v <= e ... v = v + 1 Loop  ->  For v = s To e ... Next v */
function forLoops(lines: Line[]): Line[] {
  for (let k = 0; k < lines.length; k++) {
    const m = /^Do While (\S+) (<=|>=) (.+)$/.exec(lines[k].text);
    if (!m) continue;
    const v = m[1], d = lines[k].indent;
    // matching Loop
    let end = -1;
    for (let j = k + 1; j < lines.length; j++) { if (lines[j].indent === d && lines[j].text === 'Loop') { end = j; break; } if (lines[j].indent < d) break; }
    if (end < 0) continue;
    const inc = lines[end - 1];
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const im = new RegExp(`^${esc} = (?:${esc} ([+-]) (\\S+)|(\\S+) \\+ ${esc})$`).exec(inc?.text ?? '');
    if (!im || inc.indent !== d + 1) continue;
    const step = im[3] ? im[3] : (im[1] === '-' ? '-' + im[2] : im[2]);
    if ((m[2] === '<=' && step.startsWith('-')) || (m[2] === '>=' && !step.startsWith('-'))) continue;
    // initial assignment right before the loop
    const init = lines[k - 1];
    const ini = init && init.indent === d ? new RegExp(`^${esc} = (.+)$`).exec(init.text) : null;
    if (!ini) continue;
    // the counter must not be assigned elsewhere inside the body
    if (lines.slice(k + 1, end - 1).some(l => l.text.startsWith(v + ' = '))) continue;
    const stepTxt = step === '1' ? '' : ` Step ${step}`;
    lines[k - 1] = { ...init, text: `For ${v} = ${ini[1]} To ${m[3]}${stepTxt}` };
    lines.splice(k, 1); // drop "Do While"
    end -= 1;
    lines.splice(end - 1, 2, { text: `Next ${v}`, indent: d });
    for (let j = k; j < end - 1; j++) lines[j] = { ...lines[j], indent: lines[j].indent };
  }
  return lines;
}

/** Else / If ... End If / End If  ->  ElseIf */
function elseIfs(lines: Line[]): Line[] {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    for (let k = 0; k + 1 < lines.length; k++) {
      const el = lines[k];
      const nx = lines[k + 1];
      if (el.text !== 'Else' || !/^If .* Then$/.test(nx.text) || nx.indent !== el.indent + 1) continue;
      const d = el.indent;
      // inner End If at d+1, followed directly by End If at d
      let innerEnd = -1;
      for (let j = k + 2; j < lines.length; j++) {
        if (lines[j].indent <= d) break;
        if (lines[j].indent === d + 1 && lines[j].text === 'End If') { innerEnd = j; break; }
        if (lines[j].indent === d + 1 && !/^(Else|ElseIf .* Then)$/.test(lines[j].text)) break;
      }
      if (innerEnd < 0 || lines[innerEnd + 1]?.text !== 'End If' || lines[innerEnd + 1].indent !== d) continue;
      lines[k] = { ...nx, text: 'Else' + nx.text, indent: d };
      lines.splice(k + 1, 1);
      innerEnd -= 1;
      for (let j = k + 1; j < innerEnd; j++) lines[j] = { ...lines[j], indent: lines[j].indent - 1 };
      lines.splice(innerEnd, 1);
      changed = true;
    }
  }
  return lines;
}

// VBA interfaces not described by VB6.OLB (IID -> vtable offset -> [name, kind, params])
const VBA_IFACES: Record<string, Record<number, [string, 'get' | 'let' | 'set' | 'method', number]>> = {
  '{A4C466B8-499F-101B-BB78-00AA00383CBB}': { // ErrObject
    0x1c: ['Number', 'get', 1], 0x20: ['Number', 'let', 1], 0x24: ['Source', 'get', 1], 0x28: ['Source', 'let', 1],
    0x2c: ['Description', 'get', 1], 0x30: ['Description', 'let', 1], 0x34: ['HelpFile', 'get', 1], 0x38: ['HelpFile', 'let', 1],
    0x3c: ['HelpContext', 'get', 1], 0x40: ['HelpContext', 'let', 1], 0x44: ['Raise', 'method', 5], 0x48: ['Clear', 'method', 0], 0x4c: ['LastDllError', 'get', 1],
  },
  '{A4C46780-499F-101B-BB78-00AA00383CBB}': { // Collection
    0x1c: ['Item', 'get', 2], 0x20: ['Add', 'method', 4], 0x24: ['Count', 'get', 1], 0x28: ['Remove', 'method', 1], 0x2c: ['_NewEnum', 'get', 1],
  },
};

export function decompileNative(an: Analysis, f: Func, env: DecompileEnv = {}): DecompileResult {
  const d = new NativeDecompiler(an, f, env);
  try {
    const r = d.run();
    return r;
  } catch (e) {
    return { lines: [{ text: `' Decompilation failed: ${(e as Error).message}`, indent: 1, kind: 'comment' }], header: d.signature(), errors: [String(e)], stats: { blocks: 0, statements: 0, gotos: 0 } };
  }
}
