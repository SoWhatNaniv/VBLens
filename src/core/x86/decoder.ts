// Compact IA-32 (32-bit protected mode) instruction decoder.
// Covers the general purpose instruction set, x87 FPU, system instructions
// and the common MMX/SSE/SSE2 forms — everything the VB5/6 native compiler
// (Microsoft C2 backend) emits plus typical hand-written/packer code.

export interface Operand {
  t: 'r' | 'i' | 'm' | 'j' | 'f'; // register, immediate, memory, branch target, far pointer
  sz: number; // operand size in bytes (0 = unsized, e.g. lea)
  r?: string;
  v?: number; // immediate value (zero-extended to sz) or branch target VA
  seg?: string;
  base?: string;
  idx?: string;
  sc?: number;
  disp?: number;
  sel?: number;
  sx?: boolean; // sign-extended imm8
}

export interface Insn {
  va: number;
  len: number;
  mn: string;
  ops: Operand[];
  pfx: string; // "rep" | "repne" | "lock" | ""
  bad?: boolean;
}

const R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const SREG = ['es', 'cs', 'ss', 'ds', 'fs', 'gs', 'seg6', 'seg7'];
const CC = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];
const GRP1 = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const GRP2 = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'];

const reg = (r: string, sz: number): Operand => ({ t: 'r', r, sz });
const simm = (v: number, sz: number): Operand => ({ ...imm(v, sz), sx: true });
const imm = (v: number, sz: number): Operand => ({ t: 'i', v: sz === 4 ? v >>> 0 : sz === 2 ? v & 0xffff : v & 0xff, sz });
const regBySize = (n: number, sz: number) => (sz === 1 ? R8[n] : sz === 2 ? R16[n] : R32[n]);

class Cursor {
  constructor(public b: Uint8Array, public p: number, public end: number) {}
  ok(n = 1) { return this.p + n <= this.end; }
  u8() { if (this.p >= this.end) throw OOB; return this.b[this.p++]; }
  i8() { const v = this.u8(); return (v << 24) >> 24; }
  u16() { const v = this.u8() | (this.u8() << 8); return v; }
  i16() { return (this.u16() << 16) >> 16; }
  u32() { const v = this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24); return v >>> 0; }
  i32() { return this.u32() | 0; }
}
const OOB = new Error('oob');

interface State {
  c: Cursor;
  va: number;
  start: number;
  opsz: number; // 2 or 4
  adsz: number; // 2 or 4
  seg: string | undefined;
  rep: number; // 0, 0xf2, 0xf3
  lock: boolean;
  p66: boolean;
  modrm?: { mod: number; reg: number; rm: number };
}

function readModRM(s: State) {
  if (!s.modrm) {
    const m = s.c.u8();
    s.modrm = { mod: m >> 6, reg: (m >> 3) & 7, rm: m & 7 };
  }
  return s.modrm;
}

/** Decode the r/m part as memory (or register when mod==3 using regKind). */
function rm(s: State, sz: number, regKind: 'gp' | 'mm' | 'xmm' | 'st' = 'gp'): Operand {
  const m = readModRM(s);
  if (m.mod === 3) {
    if (regKind === 'mm') return reg('mm' + m.rm, 8);
    if (regKind === 'xmm') return reg('xmm' + m.rm, 16);
    if (regKind === 'st') return reg(`st(${m.rm})`, 10);
    return reg(regBySize(m.rm, sz || s.opsz), sz || s.opsz);
  }
  const op: Operand = { t: 'm', sz };
  if (s.adsz === 2) {
    const bases: [string | undefined, string | undefined][] = [['bx', 'si'], ['bx', 'di'], ['bp', 'si'], ['bp', 'di'], ['si', undefined], ['di', undefined], ['bp', undefined], ['bx', undefined]];
    if (m.mod === 0 && m.rm === 6) op.disp = s.c.u16();
    else {
      op.base = bases[m.rm][0];
      op.idx = bases[m.rm][1];
      if (op.idx) op.sc = 1;
      if (m.mod === 1) op.disp = s.c.i8();
      else if (m.mod === 2) op.disp = s.c.i16();
    }
    if (op.base === 'bp' && !s.seg) op.seg = undefined;
  } else {
    if (m.rm === 4) {
      const sib = s.c.u8();
      const scale = 1 << (sib >> 6);
      const index = (sib >> 3) & 7;
      const base = sib & 7;
      if (index !== 4) { op.idx = R32[index]; op.sc = scale; }
      if (base === 5 && m.mod === 0) op.disp = s.c.i32();
      else op.base = R32[base];
    } else if (m.rm === 5 && m.mod === 0) {
      op.disp = s.c.u32();
    } else op.base = R32[m.rm];
    if (m.mod === 1) op.disp = s.c.i8();
    else if (m.mod === 2) op.disp = s.c.i32();
  }
  if (s.seg) op.seg = s.seg;
  return op;
}

const G = (s: State, sz: number) => { const m = readModRM(s); return reg(regBySize(m.reg, sz || s.opsz), sz || s.opsz); };

function moffs(s: State, sz: number): Operand {
  const disp = s.adsz === 4 ? s.c.u32() : s.c.u16();
  return { t: 'm', sz, disp, seg: s.seg };
}

function relTarget(s: State, size: 1 | 2 | 4): Operand {
  const d = size === 1 ? s.c.i8() : size === 2 ? s.c.i16() : s.c.i32();
  const target = (s.va + (s.c.p - s.start) + d) >>> 0;
  return { t: 'j', sz: 4, v: target };
}

function strOps(s: State, mn: string, sz: number): Operand[] {
  const di: Operand = { t: 'm', sz, base: s.adsz === 4 ? 'edi' : 'di', seg: 'es' };
  const si: Operand = { t: 'm', sz, base: s.adsz === 4 ? 'esi' : 'si', seg: s.seg };
  const acc = reg(regBySize(0, sz), sz);
  switch (mn) {
    case 'movs': return [di, si];
    case 'cmps': return [si, di];
    case 'stos': return [di, acc];
    case 'lods': return [acc, si];
    case 'scas': return [acc, di];
    case 'ins': return [di, reg('dx', 2)];
    case 'outs': return [reg('dx', 2), si];
  }
  return [];
}

const sfx = (sz: number) => (sz === 1 ? 'b' : sz === 2 ? 'w' : 'd');

export function decode(bytes: Uint8Array, offset: number, va: number, maxLen = 15): Insn {
  const end = Math.min(bytes.length, offset + maxLen);
  const s: State = { c: new Cursor(bytes, offset, end), va, start: offset, opsz: 4, adsz: 4, seg: undefined, rep: 0, lock: false, p66: false };
  try {
    const r = decodeInner(s);
    r.len = s.c.p - offset;
    r.va = va;
    if (!r.pfx) r.pfx = s.lock ? 'lock' : '';
    return r;
  } catch {
    return { va, len: 1, mn: '(bad)', ops: [], pfx: '', bad: true };
  }
}

function mk(mn: string, ops: Operand[] = [], pfx = ''): Insn { return { va: 0, len: 0, mn, ops, pfx }; }

function decodeInner(s: State): Insn {
  const c = s.c;
  let op: number;
  for (let n = 0; ; n++) {
    if (n > 14) throw OOB;
    op = c.u8();
    if (op === 0x66) { s.opsz = 2; s.p66 = true; continue; }
    if (op === 0x67) { s.adsz = 2; continue; }
    if (op === 0xf0) { s.lock = true; continue; }
    if (op === 0xf2 || op === 0xf3) { s.rep = op; continue; }
    if (op === 0x26) { s.seg = 'es'; continue; }
    if (op === 0x2e) { s.seg = 'cs'; continue; }
    if (op === 0x36) { s.seg = 'ss'; continue; }
    if (op === 0x3e) { s.seg = 'ds'; continue; }
    if (op === 0x64) { s.seg = 'fs'; continue; }
    if (op === 0x65) { s.seg = 'gs'; continue; }
    break;
  }
  const v = s.opsz;
  const repName = s.rep === 0xf3 ? 'rep' : s.rep === 0xf2 ? 'repne' : '';

  // ALU block 00-3F
  if (op < 0x40 && (op & 7) < 6) {
    const mn = GRP1[op >> 3];
    switch (op & 7) {
      case 0: return mk(mn, [rm(s, 1), G(s, 1)]);
      case 1: return mk(mn, [rm(s, v), G(s, v)]);
      case 2: return mk(mn, [G(s, 1), rm(s, 1)]);
      case 3: return mk(mn, [G(s, v), rm(s, v)]);
      case 4: return mk(mn, [reg('al', 1), imm(c.u8(), 1)]);
      case 5: return mk(mn, [reg(regBySize(0, v), v), imm(v === 4 ? c.u32() : c.u16(), v)]);
    }
  }
  switch (op) {
    case 0x06: return mk('push', [reg('es', 2)]);
    case 0x07: return mk('pop', [reg('es', 2)]);
    case 0x0e: return mk('push', [reg('cs', 2)]);
    case 0x16: return mk('push', [reg('ss', 2)]);
    case 0x17: return mk('pop', [reg('ss', 2)]);
    case 0x1e: return mk('push', [reg('ds', 2)]);
    case 0x1f: return mk('pop', [reg('ds', 2)]);
    case 0x27: return mk('daa');
    case 0x2f: return mk('das');
    case 0x37: return mk('aaa');
    case 0x3f: return mk('aas');
    case 0x0f: return decode0F(s);
  }
  if (op >= 0x40 && op <= 0x47) return mk('inc', [reg(regBySize(op & 7, v), v)]);
  if (op >= 0x48 && op <= 0x4f) return mk('dec', [reg(regBySize(op & 7, v), v)]);
  if (op >= 0x50 && op <= 0x57) return mk('push', [reg(regBySize(op & 7, v), v)]);
  if (op >= 0x58 && op <= 0x5f) return mk('pop', [reg(regBySize(op & 7, v), v)]);
  if (op >= 0x70 && op <= 0x7f) return mk('j' + CC[op & 15], [relTarget(s, 1)]);
  if (op >= 0x91 && op <= 0x97) return mk('xchg', [reg(regBySize(op & 7, v), v), reg(regBySize(0, v), v)]);
  if (op >= 0xb0 && op <= 0xb7) return mk('mov', [reg(R8[op & 7], 1), imm(c.u8(), 1)]);
  if (op >= 0xb8 && op <= 0xbf) return mk('mov', [reg(regBySize(op & 7, v), v), imm(v === 4 ? c.u32() : c.u16(), v)]);
  if (op >= 0xd8 && op <= 0xdf) return decodeFPU(s, op);

  switch (op) {
    case 0x60: return mk(v === 2 ? 'pushaw' : 'pushal');
    case 0x61: return mk(v === 2 ? 'popaw' : 'popal');
    case 0x62: return mk('bound', [G(s, v), rm(s, v * 2)]);
    case 0x63: return mk('arpl', [rm(s, 2), G(s, 2)]);
    case 0x68: return mk('push', [imm(v === 4 ? c.u32() : c.u16(), v)]);
    case 0x69: { const g = G(s, v); const e = rm(s, v); return mk('imul', [g, e, imm(v === 4 ? c.u32() : c.u16(), v)]); }
    case 0x6a: return mk('push', [simm(c.i8(), v)]);
    case 0x6b: { const g = G(s, v); const e = rm(s, v); return mk('imul', [g, e, simm(c.i8(), v)]); }
    case 0x6c: return mk('insb', strOps(s, 'ins', 1), repName);
    case 0x6d: return mk('ins' + sfx(v), strOps(s, 'ins', v), repName);
    case 0x6e: return mk('outsb', strOps(s, 'outs', 1), repName);
    case 0x6f: return mk('outs' + sfx(v), strOps(s, 'outs', v), repName);
    case 0x80: case 0x82: { const m = readModRM(s); const e = rm(s, 1); return mk(GRP1[m.reg], [e, imm(c.u8(), 1)]); }
    case 0x81: { const m = readModRM(s); const e = rm(s, v); return mk(GRP1[m.reg], [e, imm(v === 4 ? c.u32() : c.u16(), v)]); }
    case 0x83: { const m = readModRM(s); const e = rm(s, v); return mk(GRP1[m.reg], [e, simm(c.i8(), v)]); }
    case 0x84: return mk('test', [rm(s, 1), G(s, 1)]);
    case 0x85: return mk('test', [rm(s, v), G(s, v)]);
    case 0x86: return mk('xchg', [rm(s, 1), G(s, 1)]);
    case 0x87: return mk('xchg', [rm(s, v), G(s, v)]);
    case 0x88: return mk('mov', [rm(s, 1), G(s, 1)]);
    case 0x89: return mk('mov', [rm(s, v), G(s, v)]);
    case 0x8a: return mk('mov', [G(s, 1), rm(s, 1)]);
    case 0x8b: return mk('mov', [G(s, v), rm(s, v)]);
    case 0x8c: { const m = readModRM(s); const e = rm(s, m.mod === 3 ? v : 2); return mk('mov', [e, reg(SREG[m.reg], 2)]); }
    case 0x8d: { const m = readModRM(s); if (m.mod === 3) throw OOB; const g = G(s, v); const e = rm(s, 0); return mk('lea', [g, e]); }
    case 0x8e: { const m = readModRM(s); const e = rm(s, m.mod === 3 ? v : 2); return mk('mov', [reg(SREG[m.reg], 2), e]); }
    case 0x8f: { const m = readModRM(s); if (m.reg !== 0) throw OOB; return mk('pop', [rm(s, v)]); }
    case 0x90: return s.rep === 0xf3 ? mk('pause') : mk('nop');
    case 0x98: return mk(v === 2 ? 'cbw' : 'cwde');
    case 0x99: return mk(v === 2 ? 'cwd' : 'cdq');
    case 0x9a: { const off = v === 4 ? c.u32() : c.u16(); const sel = c.u16(); return mk('lcall', [{ t: 'f', sz: v, v: off, sel }]); }
    case 0x9b: return mk('wait');
    case 0x9c: return mk(v === 2 ? 'pushf' : 'pushfd');
    case 0x9d: return mk(v === 2 ? 'popf' : 'popfd');
    case 0x9e: return mk('sahf');
    case 0x9f: return mk('lahf');
    case 0xa0: return mk('mov', [reg('al', 1), moffs(s, 1)]);
    case 0xa1: return mk('mov', [reg(regBySize(0, v), v), moffs(s, v)]);
    case 0xa2: return mk('mov', [moffs(s, 1), reg('al', 1)]);
    case 0xa3: return mk('mov', [moffs(s, v), reg(regBySize(0, v), v)]);
    case 0xa4: return mk('movsb', strOps(s, 'movs', 1), repName);
    case 0xa5: return mk('movs' + sfx(v), strOps(s, 'movs', v), repName);
    case 0xa6: return mk('cmpsb', strOps(s, 'cmps', 1), s.rep === 0xf3 ? 'repe' : repName);
    case 0xa7: return mk('cmps' + sfx(v), strOps(s, 'cmps', v), s.rep === 0xf3 ? 'repe' : repName);
    case 0xa8: return mk('test', [reg('al', 1), imm(c.u8(), 1)]);
    case 0xa9: return mk('test', [reg(regBySize(0, v), v), imm(v === 4 ? c.u32() : c.u16(), v)]);
    case 0xaa: return mk('stosb', strOps(s, 'stos', 1), repName);
    case 0xab: return mk('stos' + sfx(v), strOps(s, 'stos', v), repName);
    case 0xac: return mk('lodsb', strOps(s, 'lods', 1), repName);
    case 0xad: return mk('lods' + sfx(v), strOps(s, 'lods', v), repName);
    case 0xae: return mk('scasb', strOps(s, 'scas', 1), s.rep === 0xf3 ? 'repe' : repName);
    case 0xaf: return mk('scas' + sfx(v), strOps(s, 'scas', v), s.rep === 0xf3 ? 'repe' : repName);
    case 0xc0: { const m = readModRM(s); const e = rm(s, 1); return mk(GRP2[m.reg], [e, imm(c.u8(), 1)]); }
    case 0xc1: { const m = readModRM(s); const e = rm(s, v); return mk(GRP2[m.reg], [e, imm(c.u8(), 1)]); }
    case 0xc2: return mk('ret', [imm(c.u16(), 2)]);
    case 0xc3: return mk('ret');
    case 0xc4: { const m = readModRM(s); if (m.mod === 3) throw OOB; return mk('les', [G(s, v), rm(s, v + 2)]); }
    case 0xc5: { const m = readModRM(s); if (m.mod === 3) throw OOB; return mk('lds', [G(s, v), rm(s, v + 2)]); }
    case 0xc6: { const m = readModRM(s); if (m.reg !== 0) throw OOB; const e = rm(s, 1); return mk('mov', [e, imm(c.u8(), 1)]); }
    case 0xc7: { const m = readModRM(s); if (m.reg !== 0) throw OOB; const e = rm(s, v); return mk('mov', [e, imm(v === 4 ? c.u32() : c.u16(), v)]); }
    case 0xc8: { const a = c.u16(); const b = c.u8(); return mk('enter', [imm(a, 2), imm(b, 1)]); }
    case 0xc9: return mk('leave');
    case 0xca: return mk('retf', [imm(c.u16(), 2)]);
    case 0xcb: return mk('retf');
    case 0xcc: return mk('int3');
    case 0xcd: return mk('int', [imm(c.u8(), 1)]);
    case 0xce: return mk('into');
    case 0xcf: return mk(v === 2 ? 'iret' : 'iretd');
    case 0xd0: { const m = readModRM(s); const e = rm(s, 1); return mk(GRP2[m.reg], [e, imm(1, 1)]); }
    case 0xd1: { const m = readModRM(s); const e = rm(s, v); return mk(GRP2[m.reg], [e, imm(1, 1)]); }
    case 0xd2: { const m = readModRM(s); const e = rm(s, 1); return mk(GRP2[m.reg], [e, reg('cl', 1)]); }
    case 0xd3: { const m = readModRM(s); const e = rm(s, v); return mk(GRP2[m.reg], [e, reg('cl', 1)]); }
    case 0xd4: return mk('aam', [imm(c.u8(), 1)]);
    case 0xd5: return mk('aad', [imm(c.u8(), 1)]);
    case 0xd6: return mk('salc');
    case 0xd7: return mk('xlatb');
    case 0xe0: return mk('loopne', [relTarget(s, 1)]);
    case 0xe1: return mk('loope', [relTarget(s, 1)]);
    case 0xe2: return mk('loop', [relTarget(s, 1)]);
    case 0xe3: return mk(s.adsz === 2 ? 'jcxz' : 'jecxz', [relTarget(s, 1)]);
    case 0xe4: return mk('in', [reg('al', 1), imm(c.u8(), 1)]);
    case 0xe5: return mk('in', [reg(regBySize(0, v), v), imm(c.u8(), 1)]);
    case 0xe6: return mk('out', [imm(c.u8(), 1), reg('al', 1)]);
    case 0xe7: return mk('out', [imm(c.u8(), 1), reg(regBySize(0, v), v)]);
    case 0xe8: return mk('call', [relTarget(s, v === 4 ? 4 : 2)]);
    case 0xe9: return mk('jmp', [relTarget(s, v === 4 ? 4 : 2)]);
    case 0xea: { const off = v === 4 ? c.u32() : c.u16(); const sel = c.u16(); return mk('ljmp', [{ t: 'f', sz: v, v: off, sel }]); }
    case 0xeb: return mk('jmp', [relTarget(s, 1)]);
    case 0xec: return mk('in', [reg('al', 1), reg('dx', 2)]);
    case 0xed: return mk('in', [reg(regBySize(0, v), v), reg('dx', 2)]);
    case 0xee: return mk('out', [reg('dx', 2), reg('al', 1)]);
    case 0xef: return mk('out', [reg('dx', 2), reg(regBySize(0, v), v)]);
    case 0xf1: return mk('int1');
    case 0xf4: return mk('hlt');
    case 0xf5: return mk('cmc');
    case 0xf6: case 0xf7: {
      const sz = op === 0xf6 ? 1 : v;
      const m = readModRM(s);
      const e = rm(s, sz);
      const names = ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'];
      if (m.reg <= 1) return mk('test', [e, imm(sz === 1 ? c.u8() : sz === 4 ? c.u32() : c.u16(), sz)]);
      return mk(names[m.reg], [e]);
    }
    case 0xf8: return mk('clc');
    case 0xf9: return mk('stc');
    case 0xfa: return mk('cli');
    case 0xfb: return mk('sti');
    case 0xfc: return mk('cld');
    case 0xfd: return mk('std');
    case 0xfe: {
      const m = readModRM(s);
      if (m.reg > 1) throw OOB;
      return mk(m.reg === 0 ? 'inc' : 'dec', [rm(s, 1)]);
    }
    case 0xff: {
      const m = readModRM(s);
      switch (m.reg) {
        case 0: return mk('inc', [rm(s, v)]);
        case 1: return mk('dec', [rm(s, v)]);
        case 2: return mk('call', [rm(s, 4)]);
        case 3: if (m.mod === 3) throw OOB; return mk('lcall', [rm(s, v + 2)]);
        case 4: return mk('jmp', [rm(s, 4)]);
        case 5: if (m.mod === 3) throw OOB; return mk('ljmp', [rm(s, v + 2)]);
        case 6: return mk('push', [rm(s, v)]);
      }
      throw OOB;
    }
  }
  throw OOB;
}

function decode0F(s: State): Insn {
  const c = s.c;
  const v = s.opsz;
  const op = c.u8();
  if (op >= 0x80 && op <= 0x8f) return mk('j' + CC[op & 15], [relTarget(s, v === 4 ? 4 : 2)]);
  if (op >= 0x90 && op <= 0x9f) { readModRM(s); return mk('set' + CC[op & 15], [rm(s, 1)]); }
  if (op >= 0x40 && op <= 0x4f) return mk('cmov' + CC[op & 15], [G(s, v), rm(s, v)]);
  if (op >= 0xc8 && op <= 0xcf) return mk('bswap', [reg(R32[op & 7], 4)]);
  switch (op) {
    case 0x00: {
      const m = readModRM(s);
      const n = ['sldt', 'str', 'lldt', 'ltr', 'verr', 'verw'][m.reg];
      if (!n) throw OOB;
      return mk(n, [rm(s, m.mod === 3 && m.reg < 2 ? v : 2)]);
    }
    case 0x01: {
      const m = readModRM(s);
      if (m.mod === 3) {
        const k = (m.reg << 3) | m.rm;
        const names: Record<number, string> = { 0x01: 'vmcall', 0x08: 'monitor', 0x09: 'mwait', 0x10: 'xgetbv', 0x11: 'xsetbv', 0x3e: 'swapgs', 0x39: 'rdtscp', 0x3f: 'rdtscp' };
        if (m.reg === 4) return mk('smsw', [rm(s, v)]);
        if (m.reg === 6) return mk('lmsw', [rm(s, 2)]);
        if (names[k]) return mk(names[k]);
        if (k === 0x39) return mk('rdtscp');
        throw OOB;
      }
      const n = ['sgdt', 'sidt', 'lgdt', 'lidt', 'smsw', '', 'lmsw', 'invlpg'][m.reg];
      if (!n) throw OOB;
      return mk(n, [rm(s, m.reg === 4 || m.reg === 6 ? 2 : m.reg === 7 ? 1 : 6)]);
    }
    case 0x02: return mk('lar', [G(s, v), rm(s, 2)]);
    case 0x03: return mk('lsl', [G(s, v), rm(s, 2)]);
    case 0x05: return mk('syscall');
    case 0x06: return mk('clts');
    case 0x07: return mk('sysret');
    case 0x08: return mk('invd');
    case 0x09: return mk('wbinvd');
    case 0x0b: return mk('ud2');
    case 0x0e: return mk('femms');
    case 0xff: return mk('ud0');
    case 0x0d: { const m = readModRM(s); return mk(m.reg === 1 ? 'prefetchw' : 'prefetch', [rm(s, 1)]); }
    case 0x18: {
      const m = readModRM(s);
      if (m.mod === 3) return mk('nop', [rm(s, v), G(s, v)]);
      const n = ['prefetchnta', 'prefetcht0', 'prefetcht1', 'prefetcht2'][m.reg];
      return n ? mk(n, [rm(s, 1)]) : mk('nop', [rm(s, v)]);
    }
    case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e: case 0x1f: {
      readModRM(s);
      return mk('nop', [rm(s, v)]);
    }
    case 0x20: { const m = readModRM(s); return mk('mov', [reg(R32[m.rm], 4), reg('cr' + m.reg, 4)]); }
    case 0x21: { const m = readModRM(s); return mk('mov', [reg(R32[m.rm], 4), reg('dr' + m.reg, 4)]); }
    case 0x22: { const m = readModRM(s); return mk('mov', [reg('cr' + m.reg, 4), reg(R32[m.rm], 4)]); }
    case 0x23: { const m = readModRM(s); return mk('mov', [reg('dr' + m.reg, 4), reg(R32[m.rm], 4)]); }
    case 0x30: return mk('wrmsr');
    case 0x31: return mk('rdtsc');
    case 0x32: return mk('rdmsr');
    case 0x33: return mk('rdpmc');
    case 0x34: return mk('sysenter');
    case 0x35: return mk('sysexit');
    case 0x77: return mk('emms');
    case 0xa0: return mk('push', [reg('fs', 2)]);
    case 0xa1: return mk('pop', [reg('fs', 2)]);
    case 0xa2: return mk('cpuid');
    case 0xa3: return mk('bt', [rm(s, v), G(s, v)]);
    case 0xa4: { const e = rm(s, v); const g = G(s, v); return mk('shld', [e, g, imm(c.u8(), 1)]); }
    case 0xa5: return mk('shld', [rm(s, v), G(s, v), reg('cl', 1)]);
    case 0xa8: return mk('push', [reg('gs', 2)]);
    case 0xa9: return mk('pop', [reg('gs', 2)]);
    case 0xaa: return mk('rsm');
    case 0xab: return mk('bts', [rm(s, v), G(s, v)]);
    case 0xac: { const e = rm(s, v); const g = G(s, v); return mk('shrd', [e, g, imm(c.u8(), 1)]); }
    case 0xad: return mk('shrd', [rm(s, v), G(s, v), reg('cl', 1)]);
    case 0xae: {
      const m = readModRM(s);
      if (m.mod === 3) {
        const n = ['', '', '', '', '', 'lfence', 'mfence', 'sfence'][m.reg];
        if (!n) throw OOB;
        return mk(n);
      }
      const n = ['fxsave', 'fxrstor', 'ldmxcsr', 'stmxcsr', 'xsave', 'xrstor', 'xsaveopt', 'clflush'][m.reg];
      return mk(n, [rm(s, m.reg === 2 || m.reg === 3 ? 4 : m.reg === 7 ? 1 : 0)]);
    }
    case 0xaf: return mk('imul', [G(s, v), rm(s, v)]);
    case 0xb0: return mk('cmpxchg', [rm(s, 1), G(s, 1)]);
    case 0xb1: return mk('cmpxchg', [rm(s, v), G(s, v)]);
    case 0xb2: return mk('lss', [G(s, v), rm(s, v + 2)]);
    case 0xb3: return mk('btr', [rm(s, v), G(s, v)]);
    case 0xb4: return mk('lfs', [G(s, v), rm(s, v + 2)]);
    case 0xb5: return mk('lgs', [G(s, v), rm(s, v + 2)]);
    case 0xb6: return mk('movzx', [G(s, v), rm(s, 1)]);
    case 0xb7: return mk('movzx', [G(s, v), rm(s, 2)]);
    case 0xb8: if (s.rep === 0xf3) return mk('popcnt', [G(s, v), rm(s, v)]); throw OOB;
    case 0xb9: return mk('ud1', [G(s, v), rm(s, v)]);
    case 0xba: {
      const m = readModRM(s);
      if (m.reg < 4) throw OOB;
      const e = rm(s, v);
      return mk(['bt', 'bts', 'btr', 'btc'][m.reg - 4], [e, imm(c.u8(), 1)]);
    }
    case 0xbb: return mk('btc', [rm(s, v), G(s, v)]);
    case 0xbc: return mk(s.rep === 0xf3 ? 'tzcnt' : 'bsf', [G(s, v), rm(s, v)]);
    case 0xbd: return mk(s.rep === 0xf3 ? 'lzcnt' : 'bsr', [G(s, v), rm(s, v)]);
    case 0xbe: return mk('movsx', [G(s, v), rm(s, 1)]);
    case 0xbf: return mk('movsx', [G(s, v), rm(s, 2)]);
    case 0xc0: return mk('xadd', [rm(s, 1), G(s, 1)]);
    case 0xc1: return mk('xadd', [rm(s, v), G(s, v)]);
    case 0xc7: {
      const m = readModRM(s);
      if (m.reg === 1 && m.mod !== 3) return mk('cmpxchg8b', [rm(s, 8)]);
      if (m.reg === 6 && m.mod === 3) return mk('rdrand', [rm(s, v)]);
      if (m.reg === 7 && m.mod === 3) return mk('rdseed', [rm(s, v)]);
      throw OOB;
    }
  }
  return decodeSSE(s, op);
}

// --- MMX / SSE / SSE2 (subset) ---------------------------------------------
type SseForm = [string, string, string, string]; // none, 66, F3, F2
const SSE: Record<number, SseForm> = {
  0x10: ['movups', 'movupd', 'movss', 'movsd'],
  0x11: ['movups', 'movupd', 'movss', 'movsd'],
  0x12: ['movlps', 'movlpd', 'movsldup', 'movddup'],
  0x13: ['movlps', 'movlpd', '', ''],
  0x14: ['unpcklps', 'unpcklpd', '', ''],
  0x15: ['unpckhps', 'unpckhpd', '', ''],
  0x16: ['movhps', 'movhpd', 'movshdup', ''],
  0x17: ['movhps', 'movhpd', '', ''],
  0x28: ['movaps', 'movapd', '', ''],
  0x29: ['movaps', 'movapd', '', ''],
  0x2a: ['cvtpi2ps', 'cvtpi2pd', 'cvtsi2ss', 'cvtsi2sd'],
  0x2b: ['movntps', 'movntpd', '', ''],
  0x2c: ['cvttps2pi', 'cvttpd2pi', 'cvttss2si', 'cvttsd2si'],
  0x2d: ['cvtps2pi', 'cvtpd2pi', 'cvtss2si', 'cvtsd2si'],
  0x2e: ['ucomiss', 'ucomisd', '', ''],
  0x2f: ['comiss', 'comisd', '', ''],
  0x50: ['movmskps', 'movmskpd', '', ''],
  0x51: ['sqrtps', 'sqrtpd', 'sqrtss', 'sqrtsd'],
  0x52: ['rsqrtps', '', 'rsqrtss', ''],
  0x53: ['rcpps', '', 'rcpss', ''],
  0x54: ['andps', 'andpd', '', ''],
  0x55: ['andnps', 'andnpd', '', ''],
  0x56: ['orps', 'orpd', '', ''],
  0x57: ['xorps', 'xorpd', '', ''],
  0x58: ['addps', 'addpd', 'addss', 'addsd'],
  0x59: ['mulps', 'mulpd', 'mulss', 'mulsd'],
  0x5a: ['cvtps2pd', 'cvtpd2ps', 'cvtss2sd', 'cvtsd2ss'],
  0x5b: ['cvtdq2ps', 'cvtps2dq', 'cvttps2dq', ''],
  0x5c: ['subps', 'subpd', 'subss', 'subsd'],
  0x5d: ['minps', 'minpd', 'minss', 'minsd'],
  0x5e: ['divps', 'divpd', 'divss', 'divsd'],
  0x5f: ['maxps', 'maxpd', 'maxss', 'maxsd'],
  0xc2: ['cmpps', 'cmppd', 'cmpss', 'cmpsd'],
  0xc6: ['shufps', 'shufpd', '', ''],
  0xd6: ['', 'movq', 'movq2dq', 'movdq2q'],
  0xe6: ['', 'cvttpd2dq', 'cvtdq2pd', 'cvtpd2dq'],
  0xe7: ['movntq', 'movntdq', '', ''],
  0x70: ['pshufw', 'pshufd', 'pshufhw', 'pshuflw'],
};
// MMX / SSE2 integer ops valid with no prefix (mm) or 66 (xmm)
const PINT: Record<number, string> = {
  0x60: 'punpcklbw', 0x61: 'punpcklwd', 0x62: 'punpckldq', 0x63: 'packsswb', 0x64: 'pcmpgtb', 0x65: 'pcmpgtw', 0x66: 'pcmpgtd', 0x67: 'packuswb',
  0x68: 'punpckhbw', 0x69: 'punpckhwd', 0x6a: 'punpckhdq', 0x6b: 'packssdw', 0x74: 'pcmpeqb', 0x75: 'pcmpeqw', 0x76: 'pcmpeqd',
  0xd1: 'psrlw', 0xd2: 'psrld', 0xd3: 'psrlq', 0xd4: 'paddq', 0xd5: 'pmullw', 0xd8: 'psubusb', 0xd9: 'psubusw', 0xda: 'pminub', 0xdb: 'pand',
  0xdc: 'paddusb', 0xdd: 'paddusw', 0xde: 'pmaxub', 0xdf: 'pandn', 0xe0: 'pavgb', 0xe1: 'psraw', 0xe2: 'psrad', 0xe3: 'pavgw', 0xe4: 'pmulhuw',
  0xe5: 'pmulhw', 0xe8: 'psubsb', 0xe9: 'psubsw', 0xea: 'pminsw', 0xeb: 'por', 0xec: 'paddsb', 0xed: 'paddsw', 0xee: 'pmaxsw', 0xef: 'pxor',
  0xf1: 'psllw', 0xf2: 'pslld', 0xf3: 'psllq', 0xf4: 'pmuludq', 0xf5: 'pmaddwd', 0xf6: 'psadbw', 0xf8: 'psubb', 0xf9: 'psubw', 0xfa: 'psubd',
  0xfb: 'psubq', 0xfc: 'paddb', 0xfd: 'paddw', 0xfe: 'paddd', 0x6c: 'punpcklqdq', 0x6d: 'punpckhqdq',
};

function decodeSSE(s: State, op: number): Insn {
  const c = s.c;
  const pi = s.rep === 0xf3 ? 2 : s.rep === 0xf2 ? 3 : s.p66 ? 1 : 0;
  const clearPfx = () => { if (pi >= 2) s.rep = 0; };
  const xmmReg = () => reg('xmm' + readModRM(s).reg, 16);
  const mmReg = () => reg('mm' + readModRM(s).reg, 8);
  if (SSE[op]) {
    const mn = SSE[op][pi];
    if (!mn) throw OOB;
    clearPfx();
    const memSz = pi === 2 ? 4 : pi === 3 ? 8 : 16;
    switch (op) {
      case 0x11: case 0x13: case 0x17: case 0x29: case 0x2b: case 0xe7: {
        const xr = op === 0xe7 && pi === 0 ? mmReg() : xmmReg();
        return mk(mn, [rm(s, op === 0x13 || op === 0x17 || (op === 0xe7 && pi === 0) ? 8 : memSz, op === 0xe7 && pi === 0 ? 'mm' : 'xmm'), xr]);
      }
      case 0x2a: {
        const x = xmmReg();
        return mk(mn, [x, pi >= 2 ? rm(s, 4) : rm(s, 8, 'mm')]);
      }
      case 0x2c: case 0x2d: {
        if (pi >= 2) { const g = G(s, 4); return mk(mn, [g, rm(s, pi === 2 ? 4 : 8, 'xmm')]); }
        const m = mmReg(); return mk(mn, [m, rm(s, pi === 1 ? 16 : 8, 'xmm')]);
      }
      case 0x50: { const g = G(s, 4); return mk(mn, [g, rm(s, 16, 'xmm')]); }
      case 0xc2: case 0xc6: case 0x70: {
        const isMM = op === 0x70 && pi === 0;
        const x = isMM ? mmReg() : xmmReg();
        const e = rm(s, isMM ? 8 : 16, isMM ? 'mm' : 'xmm');
        return mk(mn, [x, e, imm(c.u8(), 1)]);
      }
      case 0xd6: {
        if (pi === 1) { const x = xmmReg(); return mk(mn, [rm(s, 8, 'xmm'), x]); }
        if (pi === 2) { const m = readModRM(s); return mk(mn, [reg('xmm' + m.reg, 16), reg('mm' + m.rm, 8)]); }
        const m = readModRM(s); return mk(mn, [reg('mm' + m.reg, 8), reg('xmm' + m.rm, 16)]);
      }
    }
    const x = xmmReg();
    const e = rm(s, op === 0x12 || op === 0x16 || (op === 0x5a && pi === 0) || (op === 0xe6 && pi === 2) ? 8 : memSz, 'xmm');
    return mk(mn, [x, e]);
  }
  if (PINT[op]) {
    if (pi >= 2) throw OOB;
    if (pi === 1) { const x = xmmReg(); return mk(PINT[op], [x, rm(s, 16, 'xmm')]); }
    const m = mmReg(); return mk(PINT[op], [m, rm(s, 8, 'mm')]);
  }
  switch (op) {
    case 0x6e: { if (pi === 1) { const x = xmmReg(); return mk('movd', [x, rm(s, 4)]); } const m = mmReg(); return mk('movd', [m, rm(s, 4)]); }
    case 0x7e: {
      if (pi === 2) { s.rep = 0; const x = xmmReg(); return mk('movq', [x, rm(s, 8, 'xmm')]); }
      if (pi === 1) { const x = xmmReg(); return mk('movd', [rm(s, 4), x]); }
      const m = mmReg(); return mk('movd', [rm(s, 4), m]);
    }
    case 0x6f: {
      if (pi === 1 || pi === 2) { s.rep = 0; const x = xmmReg(); return mk(pi === 1 ? 'movdqa' : 'movdqu', [x, rm(s, 16, 'xmm')]); }
      const m = mmReg(); return mk('movq', [m, rm(s, 8, 'mm')]);
    }
    case 0x7f: {
      if (pi === 1 || pi === 2) { s.rep = 0; const x = xmmReg(); return mk(pi === 1 ? 'movdqa' : 'movdqu', [rm(s, 16, 'xmm'), x]); }
      const m = mmReg(); return mk('movq', [rm(s, 8, 'mm'), m]);
    }
    case 0x71: case 0x72: case 0x73: {
      const m = readModRM(s);
      const tbl: Record<number, string[]> = {
        0x71: ['', '', 'psrlw', '', 'psraw', '', 'psllw', ''],
        0x72: ['', '', 'psrld', '', 'psrad', '', 'pslld', ''],
        0x73: ['', '', 'psrlq', 'psrldq', '', '', 'psllq', 'pslldq'],
      };
      const n = tbl[op][m.reg];
      if (!n || m.mod !== 3) throw OOB;
      const r = pi === 1 ? reg('xmm' + m.rm, 16) : reg('mm' + m.rm, 8);
      return mk(n, [r, imm(c.u8(), 1)]);
    }
    case 0xc3: return mk('movnti', [rm(s, 4), G(s, 4)]);
    case 0xc4: { const x = pi === 1 ? xmmReg() : mmReg(); const e = rm(s, 2); return mk('pinsrw', [x, e, imm(c.u8(), 1)]); }
    case 0xc5: { const g = G(s, 4); const m = readModRM(s); const r = pi === 1 ? reg('xmm' + m.rm, 16) : reg('mm' + m.rm, 8); return mk('pextrw', [g, r, imm(c.u8(), 1)]); }
    case 0xd7: { const g = G(s, 4); const m = readModRM(s); return mk('pmovmskb', [g, pi === 1 ? reg('xmm' + m.rm, 16) : reg('mm' + m.rm, 8)]); }
    case 0xf7: { const m = readModRM(s); return mk(pi === 1 ? 'maskmovdqu' : 'maskmovq', [pi === 1 ? reg('xmm' + m.reg, 16) : reg('mm' + m.reg, 8), pi === 1 ? reg('xmm' + m.rm, 16) : reg('mm' + m.rm, 8)]); }
  }
  throw OOB;
}

// --- x87 FPU ----------------------------------------------------------------
const FPU_MEM: Record<number, [string, number][]> = {
  0xd8: [['fadd', 4], ['fmul', 4], ['fcom', 4], ['fcomp', 4], ['fsub', 4], ['fsubr', 4], ['fdiv', 4], ['fdivr', 4]],
  0xd9: [['fld', 4], ['', 0], ['fst', 4], ['fstp', 4], ['fldenv', 0], ['fldcw', 2], ['fnstenv', 0], ['fnstcw', 2]],
  0xda: [['fiadd', 4], ['fimul', 4], ['ficom', 4], ['ficomp', 4], ['fisub', 4], ['fisubr', 4], ['fidiv', 4], ['fidivr', 4]],
  0xdb: [['fild', 4], ['fisttp', 4], ['fist', 4], ['fistp', 4], ['', 0], ['fld', 10], ['', 0], ['fstp', 10]],
  0xdc: [['fadd', 8], ['fmul', 8], ['fcom', 8], ['fcomp', 8], ['fsub', 8], ['fsubr', 8], ['fdiv', 8], ['fdivr', 8]],
  0xdd: [['fld', 8], ['fisttp', 8], ['fst', 8], ['fstp', 8], ['frstor', 0], ['', 0], ['fnsave', 0], ['fnstsw', 2]],
  0xde: [['fiadd', 2], ['fimul', 2], ['ficom', 2], ['ficomp', 2], ['fisub', 2], ['fisubr', 2], ['fidiv', 2], ['fidivr', 2]],
  0xdf: [['fild', 2], ['fisttp', 2], ['fist', 2], ['fistp', 2], ['fbld', 10], ['fild', 8], ['fbstp', 10], ['fistp', 8]],
};
const D9_REG: Record<number, string> = {
  0xd0: 'fnop', 0xe0: 'fchs', 0xe1: 'fabs', 0xe4: 'ftst', 0xe5: 'fxam', 0xe8: 'fld1', 0xe9: 'fldl2t', 0xea: 'fldl2e', 0xeb: 'fldpi',
  0xec: 'fldlg2', 0xed: 'fldln2', 0xee: 'fldz', 0xf0: 'f2xm1', 0xf1: 'fyl2x', 0xf2: 'fptan', 0xf3: 'fpatan', 0xf4: 'fxtract',
  0xf5: 'fprem1', 0xf6: 'fdecstp', 0xf7: 'fincstp', 0xf8: 'fprem', 0xf9: 'fyl2xp1', 0xfa: 'fsqrt', 0xfb: 'fsincos', 0xfc: 'frndint',
  0xfd: 'fscale', 0xfe: 'fsin', 0xff: 'fcos',
};

function decodeFPU(s: State, op: number): Insn {
  const m = readModRM(s);
  if (m.mod !== 3) {
    const [mn, sz] = FPU_MEM[op][m.reg];
    if (!mn) throw OOB;
    return mk(mn, [rm(s, sz)]);
  }
  const st = (i: number) => reg(`st(${i})`, 10);
  const i = m.rm;
  const code = 0xc0 | (m.reg << 3) | m.rm;
  switch (op) {
    case 0xd8: {
      const n = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'][m.reg];
      return mk(n, [st(0), st(i)]);
    }
    case 0xd9: {
      if (m.reg === 0) return mk('fld', [st(i)]);
      if (m.reg === 1) return mk('fxch', [st(i)]);
      if (m.reg === 3) return mk('fstpnce', [st(i)]);
      const n = D9_REG[code];
      if (!n) throw OOB;
      return mk(n);
    }
    case 0xda: {
      if (code === 0xe9) return mk('fucompp');
      const n = ['fcmovb', 'fcmove', 'fcmovbe', 'fcmovu'][m.reg];
      if (!n) throw OOB;
      return mk(n, [st(0), st(i)]);
    }
    case 0xdb: {
      if (code === 0xe2) return mk('fnclex');
      if (code === 0xe3) return mk('fninit');
      if (code === 0xe0) return mk('fneni');
      if (code === 0xe1) return mk('fndisi');
      if (code === 0xe4) return mk('fsetpm');
      const n = ['fcmovnb', 'fcmovne', 'fcmovnbe', 'fcmovnu', '', 'fucomi', 'fcomi', ''][m.reg];
      if (!n) throw OOB;
      return mk(n, [st(0), st(i)]);
    }
    case 0xdc: {
      const n = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsubr', 'fsub', 'fdivr', 'fdiv'][m.reg];
      return mk(n, [st(i), st(0)]);
    }
    case 0xdd: {
      const n = ['ffree', 'fxch', 'fst', 'fstp', 'fucom', 'fucomp', '', ''][m.reg];
      if (!n) throw OOB;
      return mk(n, [st(i)]);
    }
    case 0xde: {
      if (code === 0xd9) return mk('fcompp');
      const n = ['faddp', 'fmulp', 'fcomp', '', 'fsubrp', 'fsubp', 'fdivrp', 'fdivp'][m.reg];
      if (!n) throw OOB;
      return mk(n, [st(i), st(0)]);
    }
    case 0xdf: {
      if (code === 0xe0) return mk('fnstsw', [reg('ax', 2)]);
      const n = ['ffreep', 'fxch', 'fstp', 'fstp', '', 'fucomip', 'fcomip', ''][m.reg];
      if (!n) throw OOB;
      return n === 'fucomip' || n === 'fcomip' ? mk(n, [st(0), st(i)]) : mk(n, [st(i)]);
    }
  }
  throw OOB;
}

// --- helpers for analysis -----------------------------------------------------
export const isRet = (i: Insn) => i.mn === 'ret' || i.mn === 'retf' || i.mn === 'iretd';
export const isUncondJmp = (i: Insn) => i.mn === 'jmp' || i.mn === 'ljmp';
export const isCondJmp = (i: Insn) => (i.mn[0] === 'j' && i.mn !== 'jmp') || i.mn.startsWith('loop');
export const isCall = (i: Insn) => i.mn === 'call' || i.mn === 'lcall';
export const branchTarget = (i: Insn): number | undefined => (i.ops[0]?.t === 'j' ? i.ops[0].v : undefined);
