// Intel-syntax formatter producing typed tokens (for syntax highlighting and
// clickable references in the UI) or plain strings.

import type { Insn, Operand } from './decoder';

export type TokKind = 'mn' | 'reg' | 'num' | 'addr' | 'sym' | 'str' | 'p' | 'kw' | 'cm' | 'ws';
export interface Tok { k: TokKind; t: string; a?: number }

export interface SymResolver {
  /** Name for an address (code label, import, global), if any. */
  name?(va: number): string | undefined;
  /** Is the address a valid in-image target (makes it clickable). */
  isAddr?(va: number): boolean;
}

const hexs = (v: number) => (v < 10 && v > -10 ? String(v) : (v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16)));
const PTR: Record<number, string> = { 1: 'byte ptr ', 2: 'word ptr ', 4: 'dword ptr ', 6: 'fword ptr ', 8: 'qword ptr ', 10: 'tbyte ptr ', 16: 'xmmword ptr ' };

export function opTokens(op: Operand, insn: Insn, sym?: SymResolver): Tok[] {
  switch (op.t) {
    case 'r': return [{ k: 'reg', t: op.r! }];
    case 'i': {
      let v = op.v!;
      if (op.sx && !/^(and|or|xor|test)$/.test(insn.mn)) {
        const bits = op.sz * 8;
        if (v >= 2 ** (bits - 1)) return [{ k: 'num', t: hexs(v - 2 ** bits) }];
      }
      if (op.sz === 4 && sym?.isAddr?.(v)) {
        const n = sym.name?.(v);
        return [{ k: n ? 'sym' : 'addr', t: n ?? hexs(v), a: v }];
      }
      return [{ k: 'num', t: hexs(v) }];
    }
    case 'j': {
      const v = op.v!;
      const n = sym?.name?.(v);
      return [{ k: n ? 'sym' : 'addr', t: n ?? hexs(v), a: v }];
    }
    case 'f': return [{ k: 'num', t: hexs(op.sel!) }, { k: 'p', t: ':' }, { k: 'num', t: hexs(op.v!) }];
    case 'm': {
      const out: Tok[] = [];
      const showSize = insn.mn !== 'lea' && op.sz && PTR[op.sz];
      if (showSize) out.push({ k: 'kw', t: PTR[op.sz] });
      if (op.seg) out.push({ k: 'reg', t: op.seg }, { k: 'p', t: ':' });
      out.push({ k: 'p', t: '[' });
      let first = true;
      if (op.base) { out.push({ k: 'reg', t: op.base }); first = false; }
      if (op.idx) {
        if (!first) out.push({ k: 'p', t: ' + ' });
        out.push({ k: 'reg', t: op.idx });
        if (op.sc && op.sc > 1) out.push({ k: 'p', t: '*' }, { k: 'num', t: String(op.sc) });
        first = false;
      }
      if (op.disp !== undefined && (op.disp !== 0 || first)) {
        let d = op.disp;
        if (first) {
          d = d >>> 0;
          const n = sym?.name?.(d);
          if (n) out.push({ k: 'sym', t: n, a: d });
          else if (sym?.isAddr?.(d)) out.push({ k: 'addr', t: hexs(d), a: d });
          else out.push({ k: 'num', t: hexs(d) });
        } else {
          out.push({ k: 'p', t: d < 0 ? ' - ' : ' + ' }, { k: 'num', t: hexs(Math.abs(d)) });
        }
      }
      out.push({ k: 'p', t: ']' });
      return out;
    }
  }
}

export function insnTokens(insn: Insn, sym?: SymResolver): Tok[] {
  const out: Tok[] = [];
  if (insn.pfx) out.push({ k: 'mn', t: insn.pfx + ' ' });
  out.push({ k: 'mn', t: insn.mn });
  insn.ops.forEach((op, i) => {
    out.push({ k: 'p', t: i === 0 ? ' ' : ', ' });
    out.push(...opTokens(op, insn, sym));
  });
  return out;
}

export function formatInsn(insn: Insn, sym?: SymResolver): string {
  return insnTokens(insn, sym).map(t => t.t).join('');
}
