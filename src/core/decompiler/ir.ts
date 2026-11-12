// Expression / statement IR for the decompiler and a VB-syntax printer.

export type E =
  | { k: 'c'; v: number; t?: 'bool' | 'hex' } // integer constant
  | { k: 'f'; v: number } // floating point constant
  | { k: 's'; v: string } // string literal
  | { k: 'v'; n: string; slot?: string } // named variable / location
  | { k: 'a'; e: E } // address-of (ByRef)
  | { k: 'm'; base: E; off: number; sz: number } // memory [base + off]
  | { k: 'b'; op: string; l: E; r: E }
  | { k: 'u'; op: string; e: E }
  | { k: 'call'; f: string; args: E[]; noParens?: boolean; bool?: boolean; cmp0?: string; target?: number }
  | { k: 'mc'; o: E; n: string; args: E[]; kind?: 'get' | 'let' | 'set' | 'method'; target?: number }
  | { k: 'sp'; o: number } // stack pointer value
  | { k: 'raw'; t: string }
  | { k: 'new'; cls: string }
  | { k: 'missing' }
  | { k: 'ref'; def: Stmt } // value defined by an assignment statement (inlinable)
  | { k: 'reg'; r: string }; // unknown incoming register

export type Stmt =
  | { k: 'assign'; va: number; dst: E; src: E; set?: boolean; temp?: boolean; inline?: boolean; idx?: number; useIdx?: number[] }
  | { k: 'expr'; va: number; e: E }
  | { k: 'text'; va: number; t: string }
  | { k: 'comment'; va: number; t: string };

export const C = (v: number, t?: 'bool' | 'hex'): E => ({ k: 'c', v, t });
export const S = (v: string): E => ({ k: 's', v });
export const V = (n: string, slot?: string): E => ({ k: 'v', n, slot });
export const RAW = (t: string): E => ({ k: 'raw', t });
export const CALL = (f: string, ...args: E[]): E => ({ k: 'call', f, args });

const PREC: Record<string, number> = {
  Imp: 1, Eqv: 2, Xor: 3, Or: 4, And: 5, Not: 6,
  '=': 7, '<>': 7, '<': 7, '>': 7, '<=': 7, '>=': 7, Like: 7, Is: 7,
  '&': 8, '+': 9, '-': 9, Mod: 10, '\\': 11, '*': 12, '/': 12, neg: 13, '^': 14,
};

type AssignStmt0 = Extract<Stmt, { k: 'assign' }>;
export function unref(e: E): E {
  let g = 0;
  while (e.k === 'ref' && g++ < 64) {
    const d = e.def as AssignStmt0;
    e = d.src;
  }
  return e;
}

type AssignStmt = Extract<Stmt, { k: 'assign' }>;

export function quote(s: string): string {
  let out = '';
  let inStr = false;
  const parts: string[] = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x22) {
      if (inStr) { parts.push('"' + out + '"'); out = ''; inStr = false; }
      parts.push(c === 13 ? 'vbCr' : c === 10 ? 'vbLf' : c === 9 ? 'vbTab' : c === 0 ? 'vbNullChar' : c === 8 ? 'vbBack' : `Chr$(${c})`);
    } else { out += ch; inStr = true; }
  }
  if (inStr || !parts.length) parts.push('"' + out + '"');
  return parts.join(' & ').replace(/vbCr & vbLf/g, 'vbCrLf');
}

export function fmtNum(v: number, t?: 'bool' | 'hex'): string {
  if (t === 'bool') return v ? 'True' : 'False';
  if (t === 'hex' || (Math.abs(v) >= 0x10000 && (v >>> 0).toString(16).length >= 6)) {
    const u = v >>> 0;
    return '&H' + u.toString(16).toUpperCase() + (u > 0xffff ? '&' : '');
  }
  return String(v);
}

export function printE(e: E, prec = 0): string {
  switch (e.k) {
    case 'c': return e.v < 0 && prec > 12 ? `(${fmtNum(e.v, e.t)})` : fmtNum(e.v, e.t);
    case 'f': return String(Number.isInteger(e.v) ? e.v + '#' : +e.v.toPrecision(15));
    case 's': return quote(e.v);
    case 'v': return e.n;
    case 'a': return printE(e.e, prec);
    case 'm': {
      const b = printE(e.base, 15);
      const off = (e.off >>> 0).toString(16).toUpperCase();
      if (b === 'Me') return `m_${off}`;
      return off === '0' ? `${b}.Value` : `${b}.field_${off}`;
    }
    case 'b': {
      // canonical order: constants on the right of commutative operators
      if ((e.op === '+' || e.op === '*') && unref(e.l).k === 'c' && unref(e.r).k !== 'c') return printE({ ...e, l: e.r, r: e.l }, prec);
      const p = PREC[e.op] ?? 7;
      const s = `${printE(e.l, p)} ${e.op} ${printE(e.r, p + 1)}`;
      return p < prec ? `(${s})` : s;
    }
    case 'u': {
      if (e.op === 'Not') { const s = `Not ${printE(e.e, PREC.Not)}`; return PREC.Not < prec ? `(${s})` : s; }
      if (e.op === '-') { const s = `-${printE(e.e, PREC.neg)}`; return PREC.neg < prec ? `(${s})` : s; }
      return `${e.op}(${printE(e.e)})`;
    }
    case 'call': {
      if (e.noParens) return e.args.length ? `${e.f} ${e.args.map(a => printE(a)).join(', ')}` : e.f;
      return `${e.f}(${e.args.map(a => printE(a)).join(', ')})`;
    }
    case 'mc': {
      const o = printE(e.o, 15);
      if (e.n === '') return `${o}(${e.args.map(a => printE(a)).join(', ')})`; // default member (control array item)
      const head = o && o !== 'Global' ? `${o}.${e.n}` : e.n;
      if (e.kind === 'get' && !e.args.length) return head;
      return e.args.length ? `${head}(${e.args.map(a => printE(a)).join(', ')})` : head;
    }
    case 'sp': return `[esp${e.o >= 0 ? '+' : ''}${e.o}]`;
    case 'raw': return e.t;
    case 'new': return `New ${e.cls}`;
    case 'missing': return '';
    case 'reg': return e.r;
    case 'ref': {
      const d = e.def as AssignStmt;
      if (d.inline) return printE(d.src, prec);
      return printE(d.dst, prec);
    }
  }
}

/** Strip trailing "missing" optional arguments. */
export function trimArgs(args: E[]): E[] {
  const a = [...args];
  while (a.length && unref(a[a.length - 1]).k === 'missing') a.pop();
  return a;
}

export function isPure(e: E): boolean {
  e = unref(e);
  switch (e.k) {
    case 'c': case 'f': case 's': case 'v': case 'missing': case 'reg': case 'sp': case 'raw': return true;
    case 'a': return isPure(e.e);
    case 'm': return isPure(e.base);
    case 'b': return isPure(e.l) && isPure(e.r);
    case 'u': return isPure(e.e);
    default: return false;
  }
}

/** Visit every sub-expression (not descending into inlined refs twice). */
export function walkE(e: E, fn: (x: E) => void) {
  fn(e);
  switch (e.k) {
    case 'a': walkE(e.e, fn); break;
    case 'm': walkE(e.base, fn); break;
    case 'b': walkE(e.l, fn); walkE(e.r, fn); break;
    case 'u': walkE(e.e, fn); break;
    case 'call': e.args.forEach(a => walkE(a, fn)); break;
    case 'mc': walkE(e.o, fn); e.args.forEach(a => walkE(a, fn)); break;
  }
}

export function negate(e: E): E {
  const x = unref(e);
  if (x.k === 'b') {
    const inv: Record<string, string> = { '=': '<>', '<>': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
    if (inv[x.op]) return { k: 'b', op: inv[x.op], l: x.l, r: x.r };
  }
  if (x.k === 'u' && x.op === 'Not') return x.e;
  return { k: 'u', op: 'Not', e };
}
