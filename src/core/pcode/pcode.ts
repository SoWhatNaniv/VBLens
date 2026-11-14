// VB5/6 P-Code support: procedure discovery (ProcDscInfo / "RTMI"),
// disassembly driven by the opcode table and a stack-machine decompiler.
//
// Opcode encodings/operand formats/stack effects come from the Apache-2.0
// licensed "visualbasic" crate (data/opcodes.csv) — see third_party/.

import type { Image } from '../pe/pe';
import { selectCases } from '../decompiler/native';
import { hex } from '../pe/pe';
import type { VBProject } from '../vb/structures';
import type { Analysis } from '../analysis/analysis';
import { probeString, symbolName } from '../analysis/analysis';
import { runtimeOrdinalName } from '../analysis/runtime';
import type { Tok } from '../x86/format';
import type { DecompileResult, Line } from '../decompiler/native';
import { C, E, RAW, S, V, printE, negate } from '../decompiler/ir';
import { structureLinear, LItem } from './structure';
import { vbRuntimeName } from '../decompiler/runtime';
import { VB_CLASSES_BY_NAME } from '../data/vbclasses';
import table from '../data/pcode-opcodes.json';

type OpInfo = [number, string, string, number, number, string, number]; // size, mnemonic, format, pops, pushes, category, fpuPush
const TABLES = table as unknown as OpInfo[][];

export interface POperand { k: 'a' | 's' | 'l' | 'c' | 'v' | 'x' | '1' | '2' | '4'; v: number; v2?: number; text: string; target?: number }
export interface PInsn { va: number; off: number; len: number; mn: string; cat: string; pops: number; pushes: number; ops: POperand[]; lead: number }

export interface PCodeRow { va: number; bytes: string; toks: Tok[]; comment?: string; label?: string; blockStart?: boolean }

export interface PCodeProc {
  va: number; // first P-Code byte
  size: number;
  rtmi: number; // ProcDscInfo
  name: string;
  fullName: string;
  kind: 'event' | 'method' | 'proc' | 'main';
  obj: number;
  argBytes: number;
  frameSize: number;
  constPool: number;
  insns: PInsn[];
  rows: PCodeRow[];
  ctl?: string;
  event?: string;
}

/** Find the ProcDscInfo pointer behind a method/event entry (stub or direct). */
let objectInfos = new Set<number>();
function rtmiFromEntry(img: Image, p: number): number {
  if (!p || !img.isMapped(p)) return 0;
  // a ProcDscInfo starts with a pointer to its object's ObjectInfo
  const valid = (r: number) => img.isMapped(r) && img.u16(r + 8) > 0 && img.u16(r + 8) < 0x8000 && (objectInfos.size === 0 || objectInfos.has(img.u32(r)));
  // stubs load the descriptor into edx ("mov edx, RTMI"), possibly after a short prologue
  const k = img.u8(p) === 0xba ? 0 : img.u8(p) === 0x33 && img.u8(p + 1) === 0xc0 && img.u8(p + 2) === 0xba ? 2 : -1;
  if (k >= 0) { const r = img.u32(p + k + 1); return valid(r) ? r : 0; }
  for (let j = 1; j < 16; j++) if (img.u8(p + j) === 0xba) { const r = img.u32(p + j + 1); if (valid(r) && objectInfos.size) return r; }
  // direct ProcDscInfo pointer
  if (valid(p) && objectInfos.has(img.u32(p))) return p;
  return 0;
}

export function pcodeProcs(img: Image, project: VBProject): PCodeProc[] {
  objectInfos = new Set(project.objects.map(o => o.infoVA).filter(v => !!v));
  const byRtmi = new Map<number, PCodeProc>();
  const add = (rtmi: number, name: string, obj: number, kind: PCodeProc['kind'], ctl?: string, event?: string) => {
    if (!rtmi || byRtmi.has(rtmi)) return;
    const size = img.u16(rtmi + 8);
    const va = rtmi - size;
    if (!img.isMapped(va)) return;
    const oi = img.u32(rtmi);
    const constPool = img.isMapped(oi) ? img.u32(oi + 0x34) : 0;
    const o = project.objects[obj];
    const p: PCodeProc = {
      va, size, rtmi, name, fullName: o ? `${o.name}.${name}` : name, kind, obj,
      argBytes: img.u16(rtmi + 4), frameSize: img.u16(rtmi + 6), constPool, insns: [], rows: [], ctl, event,
    };
    byRtmi.set(rtmi, p);
  };
  for (const o of project.objects) {
    // events first (better names)
    for (const c of o.controls) for (const e of c.events) {
      const r = rtmiFromEntry(img, e.stubVA);
      const self = ['Form', 'MDIForm', 'UserControl', 'Class', 'PropertyPage', 'UserDocument'].includes(c.className);
      if (r) add(r, `${self ? c.className : c.name}_${e.name}`, o.index, 'event', c.name, e.name);
    }
    if (o.pcodeMethodsVA && img.isMapped(o.pcodeMethodsVA)) {
      for (let i = 0; i < o.pcodeMethodCount && i < 4096; i++) {
        const r = rtmiFromEntry(img, img.u32(o.pcodeMethodsVA + i * 4));
        if (r) add(r, o.methodNames[i] ?? `Proc_${o.index}_${i}_${hex(r - img.u16(r + 8))}`, o.index, 'method');
      }
    }
  }
  if (project.subMainVA) {
    const r = rtmiFromEntry(img, project.subMainVA);
    if (r) add(r, 'Main', -1, 'main');
  }
  const procs = [...byRtmi.values()];
  for (const p of procs) disassemble(img, project, p);
  return procs.sort((a, b) => a.va - b.va);
}

function constString(img: Image, cp: number, idx: number): string | undefined {
  if (!cp) return undefined;
  const p = img.u32(cp + idx * 4);
  if (!img.isMapped(p)) return undefined;
  const s = probeString(img, p);
  if (s) return s.text;
  const w = img.wstr(p, 256);
  return w && /^[\x20-\x7e\u0080-￿]*$/.test(w) ? w : undefined;
}

function disassemble(img: Image, project: VBProject, p: PCodeProc) {
  const bytes = img.slice(p.va, p.size);
  let pos = 0;
  const targets = new Set<number>();
  while (pos < bytes.length) {
    const start = pos;
    let t = 0;
    let op = bytes[pos++];
    let lead = -1;
    if (op >= 0xfb) { lead = op; t = op - 0xfb + 1; op = bytes[pos++] ?? 0; }
    const info = TABLES[t]?.[op] ?? [0, 'InvalidExcode', '', 0, 0, '', 0];
    const [size, mn, fmt, pops, pushes, cat] = info;
    const ops: POperand[] = [];
    let len = size;
    if (size === -1) {
      const n = (bytes[pos] | (bytes[pos + 1] << 8));
      len = (lead >= 0 ? 2 : 1) + 2 + n;
      ops.push({ k: '2', v: n, text: `(${n} bytes)` });
      pos = start + len;
    } else if (size <= 0) {
      len = lead >= 0 ? 2 : 1;
      pos = start + len;
    } else {
      // operands per format
      const total = lead >= 0 ? size + 1 : size;
      const end = start + total;
      const specs = [...fmt.matchAll(/%([a-z0-9}])/g)].map(m => m[1]);
      for (const sp of specs) {
        if (pos >= end) break;
        const u16 = () => (bytes[pos] | (bytes[pos + 1] << 8));
        const i16 = () => (u16() << 16) >> 16;
        switch (sp) {
          case '1': ops.push({ k: '1', v: bytes[pos], text: String(bytes[pos]) }); pos += 1; break;
          case '2': { const v = i16(); ops.push({ k: '2', v, text: v < 10 && v > -10 ? String(v) : '0x' + (v & 0xffff).toString(16) }); pos += 2; break; }
          case '4': { const v = (bytes[pos] | bytes[pos + 1] << 8 | bytes[pos + 2] << 16 | bytes[pos + 3] << 24); ops.push({ k: '4', v, text: '0x' + (v >>> 0).toString(16) }); pos += 4; break; }
          case 'a': { const v = i16(); ops.push({ k: 'a', v, text: frameName(v) }); pos += 2; break; }
          case 's': { const v = u16(); const s = constString(img, p.constPool, v); ops.push({ k: 's', v, text: s !== undefined ? JSON.stringify(s) : `cp[${v}]` }); pos += 2; break; }
          case 'l': { const v = u16(); targets.add(v); ops.push({ k: 'l', v, text: `loc_${hex(p.va + v)}`, target: p.va + v }); pos += 2; break; }
          case 'c': { const v = u16(); ops.push({ k: 'c', v, text: constRef(img, project, p.constPool, v) }); pos += 2; break; }
          case 'v': { const a = u16(); const b = bytes[pos + 2] | (bytes[pos + 3] << 8); ops.push({ k: 'v', v: a, v2: b, text: `[vtbl+0x${a.toString(16)}], ${b}` }); pos += 4; break; }
          case 'x': { const a = u16(); const b = bytes[pos + 2] | (bytes[pos + 3] << 8); ops.push({ k: 'x', v: a, v2: b, text: `${constRef(img, project, p.constPool, a)}, ${b}` }); pos += 4; break; }
          default: break;
        }
      }
      pos = end;
    }
    p.insns.push({ va: p.va + start, off: start, len: pos - start, mn, cat, pops, pushes, ops, lead });
    if (pos <= start) pos = start + 1;
    // nothing after the last return is reachable (alignment / data)
    if (/^ExitProc/.test(mn) && ![...targets].some(t => t >= pos)) break;
  }
  for (const i of p.insns) {
    const raw = img.slice(i.va, i.len);
    const toks: Tok[] = [{ k: 'mn', t: i.mn }];
    i.ops.forEach((o, k) => {
      toks.push({ k: 'p', t: k ? ', ' : ' ' });
      if (o.k === 'l') toks.push({ k: 'addr', t: o.text, a: o.target });
      else if (o.k === 's' && o.text.startsWith('"')) toks.push({ k: 'str', t: o.text });
      else if (o.k === 'a') toks.push({ k: 'reg', t: o.text });
      else if (o.k === 'c' || o.k === 'x') toks.push({ k: 'sym', t: o.text });
      else toks.push({ k: 'num', t: o.text });
    });
    p.rows.push({ va: i.va, bytes: [...raw].map(x => x.toString(16).padStart(2, '0')).join(' '), toks, blockStart: targets.has(i.off) || i.off === 0, label: targets.has(i.off) ? `loc_${hex(i.va)}` : undefined });
  }
  if (p.rows.length) p.rows[0].label = p.fullName;
}

function frameName(v: number): string {
  if (v < 0) return `var_${(-v).toString(16).toUpperCase()}`;
  return `arg_${v.toString(16).toUpperCase()}`;
}

function constRef(img: Image, project: VBProject, cp: number, idx: number): string {
  if (!cp) return `cp[${idx}]`;
  const p = img.u32(cp + idx * 4);
  if (!img.isMapped(p)) return `cp[${idx}]=${hex(p)}`;
  // declare / import / object info
  const d = project.declares.find(d => d.entryVA === p);
  if (d) return d.func;
  // declare stub: A1 xx xx xx xx 0B C0 74 02 FF E0 68 <info>
  if (img.u8(p) === 0xa1 && img.u8(p + 5) === 0x0b && img.u8(p + 11) === 0x68) {
    const info = img.u32(p + 12);
    const d2 = project.declares.find(d => d.entryVA === info);
    if (d2) return d2.func;
  }
  const o = project.objects.find(o => o.infoVA === p || o.descVA === p);
  if (o) return o.name;
  const impName = (i: { name?: string | null; ordinal?: number | null; dll: string }) => i.name ?? (i.ordinal != null ? runtimeOrdinalName(i.dll, i.ordinal) : undefined) ?? `#${i.ordinal}`;
  const imp = img.importsByIat.get(p);
  if (imp) return impName(imp);
  // jump thunk to an import
  if (img.u8(p) === 0xff && img.u8(p + 1) === 0x25) { const i2 = img.importsByIat.get(img.u32(p + 2)); if (i2) return impName(i2); }
  const s = probeString(img, p);
  if (s) return JSON.stringify(s.text);
  return `cp[${idx}]=${hex(p)}`;
}

// --- decompiler -------------------------------------------------------------------

const BIN: [RegExp, string][] = [
  [/^Add/, '+'], [/^Sub/, '-'], [/^Mul/, '*'], [/^Div/, '/'], [/^Idv/, '\\'], [/^Mod/, 'Mod'], [/^Pwr/, '^'],
  [/^And/, 'And'], [/^Or/, 'Or'], [/^Xor/, 'Xor'], [/^Eqv/, 'Eqv'], [/^Imp/, 'Imp'], [/^Concat/, '&'],
  [/^Eq/, '='], [/^Ne(?!xt|w)/, '<>'], [/^Lt/, '<'], [/^Le/, '<='], [/^Gt/, '>'], [/^Ge/, '>='], [/^Like/, 'Like'], [/^Is$/, 'Is'],
];

interface SVal { e: E; n: number } // value and its size in stack slots

export function decompilePCodeProc(img: Image, project: VBProject, an: Analysis, p: PCodeProc, procs?: Map<number, PCodeProc>): DecompileResult {
  const items: LItem[] = [];
  const stack: SVal[] = [];
  const fpu: E[] = [];
  const errors: string[] = [];
  const obj = p.obj >= 0 ? project.objects[p.obj] : undefined;
  const isObj = !!obj && obj.kind !== 'Module';
  const byRtmi = new Map<number, PCodeProc>();
  for (const q of procs?.values() ?? []) byRtmi.set(q.rtmi, q);
  const targets = new Set<number>();
  for (const i of p.insns) for (const o of i.ops) if (o.k === 'l') targets.add(o.v);
  // event handlers: typed parameter names from the control's event interface
  const argNames = new Map<number, string>();
  if (p.kind === 'event' && obj) {
    const ctl = obj.controls.filter(c => p.name.startsWith(c.name + '_')).sort((a, b) => b.name.length - a.name.length)[0];
    const ev = ctl ? p.name.slice(ctl.name.length + 1) : '';
    const cls = ctl ? VB_CLASSES_BY_NAME[ctl.className] : undefined;
    const params = cls ? cls.eventParams[cls.events.indexOf(ev)] : undefined;
    let off = isObj ? 0xc : 8;
    if (ctl?.isArray) { argNames.set(off, 'Index'); off += 4; }
    for (const pr of params ?? []) { argNames.set(off, pr.split(' ')[0]); off += 4; }
  }
  // functions: "ExitProcCb… argBytes, retSize" copies the first local back as the result
  let retOff: number | undefined, retSize = 0;
  for (const i of p.insns) if (/^ExitProcCb/.test(i.mn)) {
    const at = i.va + (i.lead >= 0 ? 2 : 1);
    retSize = img.u16(at + 2);
    if (retSize > 0 && retSize <= 16) retOff = -(0x84 + retSize);
    break;
  }
  let retStore = '';
  const fname = (o?: POperand): string => {
    if (!o) return '?';
    if (o.k === 'a' && retOff !== undefined && o.v === retOff) return p.name;
    if (o.k === 'a' && isObj && o.v === 8) return 'Me';
    if (o.k === 'a' && argNames.has(o.v)) return argNames.get(o.v)!;
    return o.text;
  };
  const fv = (o?: POperand): E => V(fname(o));
  const push = (e: E, n = 1) => stack.push({ e, n });
  const pop = (): E => stack.pop()?.e ?? RAW('?');
  const popSlots = (n: number): E[] => { const out: E[] = []; let got = 0; while (got < n && stack.length) { const v = stack.pop()!; got += v.n; out.push(v.e); } return out; };
  const fpop = (): E => fpu.pop() ?? RAW('?');
  const stmt = (text: string, va: number, kind?: Line['kind']) => items.push({ k: 'stmt', text, va, kind });
  const flush = (va: number) => {
    // values left on the stack at a statement boundary were calls whose result was ignored
    for (const v of stack) { const u = v.e; if (u.k === 'call' || u.k === 'mc') stmt(callStmt(u), va); }
    stack.length = 0;
    for (const f of fpu) if (f.k === 'call' || f.k === 'mc') stmt(callStmt(f), va);
    fpu.length = 0;
  };
  const callStmt = (e: E): string => {
    if (e.k === 'call') return `${e.f}${e.args.length ? ' ' + e.args.map(a => printE(a)).join(', ') : ''}`;
    if (e.k === 'mc') { const h = printE({ ...e, args: [] }); return `${h}${e.args.length ? ' ' + e.args.map(a => printE(a)).join(', ') : ''}`; }
    return printE(e);
  };
  const methodName = (o: VBObjectLike | undefined, off: number): { name: string; args?: number } => {
    if (o && !o.methods.length && o.pcodeMethodsVA && off >= o.vtableBase && (off - o.vtableBase) % 4 === 0) {
      // P-Code objects: the method table lists the vtable slots in order
      const idx = (off - o.vtableBase) / 4;
      if (idx < o.pcodeMethodCount) {
        const q = rtmiFromEntry(img, img.u32(o.pcodeMethodsVA + idx * 4));
        const pr = q ? byRtmi.get(q) : undefined;
        if (pr) return { name: pr.name, args: Math.max(0, pr.argBytes / 4 - 1) };
      }
    }
    if (o) {
      const m = o.methods.find(m => m.vtableOffset === off);
      if (m) {
        const q = rtmiFromEntry(img, m.targetVA);
        const pr = q ? byRtmi.get(q) : undefined;
        const nm = pr?.name ?? m.name ?? an.funcByVA.get(m.targetVA)?.name;
        if (nm) return { name: nm, args: pr ? Math.max(0, pr.argBytes / 4 - 1) : undefined };
      }
    }
    return { name: `Method_${hex(off)}` };
  };
  const forStack: { ctr: E; tmp: string }[] = [];
  let pendingSet = false;
  for (const i of p.insns) {
    if (targets.has(i.off)) { flush(i.va); items.push({ k: 'label', id: i.va, va: i.va }); }
    const mn = i.mn;
    const o0 = i.ops[0], o1 = i.ops[1];
    try {
      // ---- literals
      if (/^Lit(I2|I4|UI1|I1|Bool)\b|^LitI2_Byte|^LitI2FP|^LitI4FP|^LitI2$|^LitI4$/.test(mn)) { const v = o0 ? (o0.k === '1' ? (mn === 'LitI2_Byte' ? (o0.v << 24) >> 24 : o0.v) : o0.v) : 0; push(C(v)); continue; }
      if (/^LitVar(I2|I4|UI1)/.test(mn)) { push(C(o1?.v ?? o0?.v ?? 0)); continue; }
      if (/^Lit(Var)?Str/.test(mn)) { const so = i.ops.find(o => o.k === 's'); push(so && so.text.startsWith('"') ? S(JSON.parse(so.text)) : RAW(so?.text ?? '""')); continue; }
      if (mn === 'LitNothing') { push(RAW('Nothing')); continue; }
      if (/^LitVar_?(Null|Empty|Missing|TRUE|FALSE)/i.test(mn)) { const w = mn.replace(/^LitVar_?/, ''); push(w === 'Missing' ? { k: 'missing' } : /true/i.test(w) ? RAW('True') : /false/i.test(w) ? RAW('False') : RAW(w)); continue; }
      if (/^LitR8|^LitR4|^LitDate/.test(mn) && i.ops.length && i.ops.every(o => o.k === '4')) {
        // floating point literals go to the FPU stack
        const dv = new DataView(new ArrayBuffer(8));
        let v: number;
        if (i.ops.length >= 2) { dv.setUint32(0, i.ops[0].v >>> 0, true); dv.setUint32(4, i.ops[1].v >>> 0, true); v = dv.getFloat64(0, true); }
        else { dv.setUint32(0, i.ops[0].v >>> 0, true); v = dv.getFloat32(0, true); }
        fpu.push({ k: 'f', v: +v.toPrecision(15) });
        continue;
      }
      if (/^C(R4|R8)(R4|R8)$/.test(mn)) continue;
      if (/^LitR8|^LitR4|^LitCy|^LitDate|^LitVarR8/.test(mn)) { const t = RAW(i.ops.map(o => o.text).join(' ')); if (/R4|R8/.test(mn) && !/Var/.test(mn)) fpu.push(t); else push(t, /Cy|Date/.test(mn) ? 2 : 1); continue; }
      // ---- frame loads / stores
      if (mn === 'FLdPrThis') { push(V('Me')); continue; }
      if (/^FLdZeroAd/.test(mn)) { push(fv(o0)); continue; }
      if (/^FLd(FPR4|FPR8)/.test(mn) || /^ILd(FPR4|FPR8)/.test(mn)) { fpu.push(fv(o0)); continue; }
      if (/^FLdRf|^FLdPr|^FLd|^ILd/.test(mn)) { push(fv(o0), /Var$/.test(mn) && !/Rf/.test(mn) ? 4 : /R8|Cy/.test(mn) ? 2 : 1); continue; }
      if (/^FDupVar/.test(mn)) { push(fv(o0), 4); continue; }
      if (/^(FSt|ISt)(FPR4|FPR8)/.test(mn)) { stmt(`${fname(o0)} = ${printE(fpop())}`, i.va); continue; }
      if (/^FSt|^ISt|^FMove/.test(mn)) {
        const noPop = /NoPop/.test(mn);
        const v = noPop ? (stack[stack.length - 1]?.e ?? RAW('?')) : pop();
        const set = /Ad|Obj|Unk/.test(mn) && !/StrCopy/.test(mn);
        if (retOff !== undefined && o0?.k === 'a' && o0.v === retOff && !retStore) retStore = mn;
        stmt(`${set || pendingSet ? 'Set ' : ''}${fname(o0)} = ${printE(deAddr(v))}`, i.va);
        pendingSet = false;
        continue;
      }
      if (mn === 'ZeroRetVal') continue;
      // ---- members (UDT fields / object variables)
      if (/^FMemLd/.test(mn)) { const e = V(`${fname(o0)}.m_${hex((o1?.v ?? 0) & 0xffff)}`); if (/FPR/.test(mn)) fpu.push(e); else push(e); continue; }
      if (/^FMemSt/.test(mn)) { const v = /FPR/.test(mn) ? fpop() : pop(); stmt(`${fname(o0)}.m_${hex((o1?.v ?? 0) & 0xffff)} = ${printE(deAddr(v))}`, i.va); continue; }
      if (/^MemLd/.test(mn)) { const base = pop(); const e = V(`${printE(deAddr(base))}.m_${hex((o0?.v ?? 0) & 0xffff)}`); if (/FPR/.test(mn)) fpu.push(e); else push(e, /Var$/.test(mn) && !/Rf/.test(mn) ? 4 : 1); continue; }
      if (/^MemSt/.test(mn)) { const base = pop(); const v = /FPR/.test(mn) ? fpop() : pop(); stmt(`${/Ad$/.test(mn) ? 'Set ' : ''}${printE(deAddr(base))}.m_${hex((o0?.v ?? 0) & 0xffff)} = ${printE(deAddr(v))}`, i.va); continue; }
      // ---- arrays
      if (/^Ary1Ld/.test(mn)) { const arr = pop(); const idx = pop(); const e: E = { k: 'call', f: printE(deAddr(arr)), args: [deAddr(idx)] }; if (/FPR/.test(mn)) fpu.push(e); else push(e, /Var$/.test(mn) && !/Rf/.test(mn) ? 4 : 1); continue; }
      if (/^Ary1St/.test(mn)) { const arr = pop(); const idx = pop(); const v = /FPR/.test(mn) ? fpop() : pop(); stmt(`${printE(deAddr(arr))}(${printE(deAddr(idx))}) = ${printE(deAddr(v))}`, i.va); continue; }
      if (/^AryLd/.test(mn)) { const arr = pop(); const n = Math.max(1, o0?.v ?? 1); const idx: E[] = []; for (let k = 0; k < n; k++) idx.push(deAddr(pop())); push({ k: 'call', f: printE(deAddr(arr)), args: idx.reverse() }); continue; }
      if (/^AryLock|^AryUnlock/.test(mn)) { pop(); continue; }
      // ---- globals
      if (/^ImpAdLd/.test(mn)) { push(V(o0?.text ?? 'global')); continue; }
      if (/^ImpAdSt/.test(mn)) { const v = pop(); stmt(`${/Ad$/.test(mn) ? 'Set ' : ''}${o0?.text ?? 'global'} = ${printE(deAddr(v))}`, i.va); continue; }
      // ---- calls
      if (/^ImpAdCall/.test(mn)) {
        const x = i.ops.find(o => o.k === 'x' || o.k === 'c');
        const bytes = x?.v2 ?? i.ops.find(o => o.k === '2')?.v ?? 0;
        const args = popSlots(Math.floor(bytes / 4)).map(deAddr);
        const name = vbRuntimeName((x?.text ?? 'Import').split(',')[0]).replace(/^cp\[\d+\]=/, 'sub_');
        const call: E = { k: 'call', f: name, args };
        if (/Hresult|NonVirt/.test(mn) || /FPR/.test(mn)) stmt(callStmt(call), i.va);
        else push(call);
        continue;
      }
      if (mn === 'GetLastError') continue;
      if (/^ThisVCall/.test(mn)) {
        const off = (o0?.v ?? 0) & 0xffff;
        const m = methodName(obj, off);
        const args = m.args !== undefined ? popSlots(m.args).map(deAddr) : popSlots(Math.max(0, stack.reduce((a, v) => a + v.n, 0))).map(deAddr);
        const e: E = { k: 'mc', o: V('Me'), n: m.name, args, kind: 'method' };
        if (/Hresult/.test(mn)) stmt(callStmt(e), i.va); else push(e);
        continue;
      }
      if (/^VCall/.test(mn)) {
        const v = i.ops.find(o => o.k === 'v');
        const off = (v?.v ?? o0?.v ?? 0) & 0xffff;
        const objE = deAddr(pop());
        const argBytes = v?.v2;
        const args = argBytes !== undefined ? popSlots(Math.max(0, Math.floor(argBytes / 4) - 1)).map(deAddr) : [];
        const e: E = { k: 'mc', o: objE, n: `Method_${hex(off)}`, args, kind: 'method' };
        if (/Hresult/.test(mn)) stmt(callStmt(e), i.va); else if (/FPR/.test(mn)) fpu.push(e); else push(e);
        continue;
      }
      if (/^Late(Id|Mem)/.test(mn)) {
        const objE = deAddr(pop());
        const nm = (i.ops.find(o => o.k === 's' || o.k === 'c')?.text ?? (o1 ?? o0)?.text ?? 'member').replace(/"/g, '');
        const name = /^0x/.test(nm) ? `DispID_${nm.slice(2).toUpperCase()}` : nm;
        if (/St/.test(mn)) { const val = pop(); stmt(`${printE(objE)}.${name} = ${printE(deAddr(val))}`, i.va); }
        else if (/Call/.test(mn) && !/Ld/.test(mn)) stmt(`${printE(objE)}.${name}`, i.va);
        else push({ k: 'mc', o: objE, n: name, args: [], kind: 'get' }, /Var/.test(mn) ? 4 : 1);
        continue;
      }
      if (mn === 'New') { push({ k: 'new', cls: (o0?.text ?? 'Object').replace(/^cp\[.*/, 'Object') }); continue; }
      if (/^NewIfNull|^CastAd|^PopAdLd|^PopTmpLdAd|^CVarRef|^CDargRef|^CVarAd|^CVarUnk/.test(mn)) {
        // pass-through: these move a value into a temp / take its address
        if ((/^CVarRef|^CDargRef/.test(mn)) && o0?.k === 'a') { push(fv(o0), 1); continue; }
        if (/FPR/.test(mn)) { push(fpu.length ? fpop() : fv(o0)); continue; }
        if (!stack.length && o0?.k === 'a') { push(fv(o0)); continue; }
        continue;
      }
      if (/^PopFPR/.test(mn)) { push(fpop()); continue; }
      if (/^PopAd$|^PopTmp/.test(mn)) { const v = pop(); if (v.k === 'call' || v.k === 'mc') stmt(callStmt(v), i.va); continue; }
      // ---- arithmetic / comparisons
      const bin = BIN.find(([re]) => re.test(mn));
      if (bin) {
        if (/R4|R8|Cy/.test(mn) && i.pops === 0) {
          const b = fpop(), a = fpop();
          const e: E = { k: 'b', op: bin[1], l: a, r: b };
          if (i.pushes) push(e); else fpu.push(e);
          continue;
        }
        const b = pop(), a = pop();
        push({ k: 'b', op: bin[1], l: deAddr(a), r: deAddr(b) }, /Var$/.test(mn) ? 4 : 1);
        continue;
      }
      if (/^Not/.test(mn)) { push(negate(deAddr(pop()))); continue; }
      if (/^UMi/.test(mn)) { if (/R4|R8/.test(mn) && i.pops === 0) fpu.push({ k: 'u', op: '-', e: fpop() }); else push({ k: 'u', op: '-', e: deAddr(pop()) }); continue; }
      // ---- conversions
      if (/^C(R4|R8)(I2|I4|UI1|Var|Str|Bool|Cy)/.test(mn)) { fpu.push(deAddr(pop())); continue; }
      if (/^C(I2|I4|UI1|Bool|Str|Cy)(R4|R8)/.test(mn)) { const t = mn.match(/^C(I2|I4|UI1|Bool|Str|Cy)/)![1]; const f = { I2: 'CInt', I4: 'CLng', UI1: 'CByte', Bool: 'CBool', Str: 'CStr', Cy: 'CCur' }[t]!; push({ k: 'call', f, args: [fpop()] }); continue; }
      if (/^CVar(R4|R8)/.test(mn)) { push(fpop(), 4); continue; }
      if (/^CStr2(Ansi|Uni)|^CStrAry/.test(mn)) continue; // marshalling only
      if (/^C(Str|Var|I2|I4|R4|R8|Bool|UI1|Cy|Date)/.test(mn)) {
        const v = deAddr(pop());
        const to = mn.match(/^C(Str|Var|I2|I4|R4|R8|Bool|UI1|Cy|Date)/)![1];
        const from = mn.slice(1 + to.length);
        const f = { Str: 'CStr', I2: 'CInt', I4: 'CLng', R4: 'CSng', R8: 'CDbl', Bool: 'CBool', UI1: 'CByte', Cy: 'CCur', Date: 'CDate', Var: '' }[to]!;
        // widening between integer types or into a Variant is implicit
        const implicit = to === 'Var' || (to === 'I4' && /^(I2|UI1|Bool)/.test(from)) || (to === 'I2' && /^(UI1|Bool)/.test(from)) || (to === 'Str' && from.startsWith('Var') && false);
        const isConst = v.k === 'c' || v.k === 's';
        push(implicit || !f || (isConst && to !== 'Str' && to !== 'Date') ? v : { k: 'call', f, args: [v] }, to === 'Var' ? 4 : 1);
        continue;
      }
      // ---- intrinsics
      if (/^FnLen/.test(mn)) { push({ k: 'call', f: /LenB/.test(mn) ? 'LenB' : 'Len', args: [deAddr(o0?.k === 'a' ? fv(o0) : pop())] }); continue; }
      if (/^FnStrComp/.test(mn)) { const b = pop(), a = pop(); push({ k: 'call', f: 'StrComp', args: [deAddr(a), deAddr(b)] }); continue; }
      if (mn === 'RaiseEvent') { const n = i.ops.find(o => o.k === '4'); const args = popSlots(n ? (n.v >> 16) & 0xff : 0); stmt(`RaiseEvent Event_${(o0?.v ?? 0) & 0xffff}${args.length ? '(' + args.map(a => printE(deAddr(a))).join(', ') + ')' : ''}`, i.va); continue; }
      // ---- control flow
      if (/^ForI|^ForUI1|^ForStep|^ForR|^ForCy|^ForVar/.test(mn)) {
        const step = /Step/.test(mn) ? deAddr(pop()) : undefined;
        const end = deAddr(pop()); const ctr = deAddr(pop()); const start = deAddr(pop());
        flush(i.va);
        forStack.push({ ctr, tmp: fname(o0) });
        items.push({ k: 'open', text: `For ${printE(ctr)} = ${printE(start)} To ${printE(end)}${step ? ' Step ' + printE(step) : ''}`, va: i.va });
        continue;
      }
      if (/^Next/.test(mn)) {
        if (/Step/.test(mn)) pop();
        const f = forStack.pop();
        flush(i.va);
        items.push({ k: 'close', text: `Next${f ? ' ' + printE(f.ctr) : ''}`, va: i.va });
        continue;
      }
      if (mn === 'BranchF' || mn === 'BranchT' || mn === 'BranchFVar' || mn === 'BranchTVar') {
        const c = deAddr(pop());
        flush(i.va);
        const t = i.ops.find(o => o.k === 'l');
        items.push({ k: 'if', cond: mn.startsWith('BranchF') ? negate(c) : c, target: t?.target ?? 0, va: i.va });
        continue;
      }
      if (mn === 'Branch') { flush(i.va); const t = i.ops.find(o => o.k === 'l'); items.push({ k: 'goto', target: t?.target ?? 0, va: i.va }); continue; }
      if (mn === 'OnErrorGoto') { const t = i.ops.find(o => o.k === 'l'); stmt(t && t.v !== 0xffff ? `On Error GoTo loc_${hex(t.target ?? 0)}` : 'On Error GoTo 0', i.va); continue; }
      if (/^OnError/.test(mn)) { stmt(/Resume/.test(mn) ? 'On Error Resume Next' : `' ${mn}`, i.va); continue; }
      if (/^Resume/.test(mn)) { stmt(mn === 'ResumeNext' ? 'Resume Next' : 'Resume', i.va); continue; }
      if (/^ExitProc/.test(mn)) {
        if (/I2|I4|R4|R8|Cy|Str|Var|Ad/.test(mn.replace('ExitProcCb', 'ExitProc').replace('Hresult', '')) && (stack.length || fpu.length)) stmt(`${p.name} = ${printE(deAddr(/R4|R8/.test(mn) ? fpop() : pop()))}`, i.va);
        flush(i.va);
        items.push({ k: 'goto', target: -1, va: i.va }); // exit
        continue;
      }
      if (/^FFree|^LargeBos|^Bos|^InvalidExcode|^Unknown/.test(mn)) { if (/Bos/.test(mn)) flush(i.va); continue; }
      if (/^CopyBytes/.test(mn)) { const a = popSlots(2); stmt(`' CopyBytes ${a.map(x => printE(deAddr(x))).join(', ')}`, i.va, 'comment'); continue; }
      // generic: honour the table's stack effects
      const args = i.pops > 0 ? popSlots(i.pops).map(deAddr) : [];
      if (i.pushes > 0) push({ k: 'call', f: mn, args: args.reverse() }, i.pushes === 4 || i.pushes === 2 ? i.pushes : 1);
      else stmt(`' ${mn} ${[...args.reverse().map(a => printE(a)), ...i.ops.map(o => o.text)].join(', ')}`.trimEnd(), i.va, 'comment');
    } catch (e) {
      errors.push(`${hex(i.va)}: ${(e as Error).message}`);
    }
  }
  flush(p.va + p.size);
  void symbolName;
  const exitText = retOff !== undefined ? (isObj && [...(procs?.values() ?? [])].filter(q => q.obj === p.obj && q.name === p.name).length > 1 ? 'Exit Property' : 'Exit Function') : 'Exit Sub';
  const lines = structureLinear(items, exitText);
  let nargs = Math.max(0, Math.floor(p.argBytes / 4) - (isObj ? 1 : 0));
  let kw = p.kind === 'event' || p.kind === 'main' ? 'Private Sub' : 'Public Sub';
  let asType = '';
  if (retOff !== undefined) {
    nargs = Math.max(0, nargs - 1); // the [out, retval] pointer
    asType = /Str/.test(retStore) ? 'String' : /Ad|Obj|Unk/.test(retStore) ? 'Object' : /FPR8|R8/.test(retStore) ? 'Double' : /FPR4/.test(retStore) ? 'Single' : /Var/.test(retStore) || retSize === 16 ? 'Variant' : retSize === 2 ? 'Integer' : retSize === 8 ? 'Double' : 'Long';
    kw = 'Public Function';
  }
  // property procedures share their name with a sibling (Get / Let / Set)
  const twins = [...(procs?.values() ?? [])].filter(q => q.obj === p.obj && q.name === p.name);
  if (isObj && twins.length > 1) kw = retOff !== undefined ? 'Public Property Get' : 'Public Property Let';
  return {
    lines: selectCases(lines.map(l => ({ ...l, kind: l.kind ?? (l.text.startsWith("'") ? 'comment' : 'code') }))),
    header: `${kw} ${p.name}(${(argNames.size ? [...argNames.values()] : Array.from({ length: nargs }, (_, k) => `arg_${hex((isObj ? 0xc : 8) + k * 4)}`)).join(', ')})${asType ? ' As ' + asType : ''}`,
    errors,
    stats: { blocks: 0, statements: lines.length, gotos: lines.filter(l => /\bGoTo loc_/.test(l.text)).length },
  };
}

type VBObjectLike = VBProject['objects'][number];

function deAddr(e: E): E { return e.k === 'a' ? e.e : e; }
