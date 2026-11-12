// Linear normalisation of address expressions: sum of coef*atom + const.
// Used to recognise SAFEARRAY element accesses:
//   pvData(+0x0C) + (index - lLbound(+0x14)) * elemSize + fieldOffset

import { E, printE, unref } from './ir';

export interface Lin { terms: Map<string, { atom: E; coef: number }>; c: number }

export function linear(e: E, depth = 0): Lin | undefined {
  if (depth > 24) return undefined;
  const u = unref(e);
  if (u.k === 'c') return { terms: new Map(), c: u.v };
  if (u.k === 'b' && (u.op === '+' || u.op === '-')) {
    const l = linear(u.l, depth + 1), r = linear(u.r, depth + 1);
    if (!l || !r) return atom(u);
    return add(l, r, u.op === '-' ? -1 : 1);
  }
  if (u.k === 'b' && u.op === '*') {
    const l = linear(u.l, depth + 1), r = linear(u.r, depth + 1);
    if (l && r) {
      if (!r.terms.size) return scale(l, r.c);
      if (!l.terms.size) return scale(r, l.c);
    }
    return atom(u);
  }
  if (u.k === 'u' && u.op === '-') { const l = linear(u.e, depth + 1); return l ? scale(l, -1) : atom(u); }
  return atom(u);
}

function atom(e: E): Lin { const m = new Map(); m.set(printE(e), { atom: e, coef: 1 }); return { terms: m, c: 0 }; }
function scale(a: Lin, k: number): Lin { const m = new Map(); for (const [s, t] of a.terms) m.set(s, { atom: t.atom, coef: t.coef * k }); return { terms: m, c: a.c * k }; }
function add(a: Lin, b: Lin, sign: number): Lin {
  const m = new Map(a.terms);
  for (const [s, t] of b.terms) {
    const ex = m.get(s);
    const coef = (ex?.coef ?? 0) + t.coef * sign;
    if (coef === 0) m.delete(s); else m.set(s, { atom: t.atom, coef });
  }
  return { terms: m, c: a.c + b.c * sign };
}

/** Recognise an element address; returns array descriptor expression, index and field offset. */
export function arrayElement(addr: E): { arr: E; index: E; elemSize: number; field: number } | undefined {
  const lin = linear(addr);
  if (!lin || lin.terms.size < 2) return undefined;
  // find pvData term: m(D, 0xC) with coef 1
  for (const [, t] of lin.terms) {
    const a = unref(t.atom);
    if (t.coef !== 1 || a.k !== 'm' || a.off !== 0x0c) continue;
    const D = a.base;
    const dKey = printE(D);
    // lower bound term m(D, 0x14) with coefficient -size
    let size = 0;
    for (const [, u] of lin.terms) { const b = unref(u.atom); if (b.k === 'm' && b.off === 0x14 && printE(b.base) === dKey) size = -u.coef; }
    const rest = [...lin.terms.values()].filter(x => {
      const b = unref(x.atom);
      return !(b.k === 'm' && (b.off === 0x0c || b.off === 0x14) && printE(b.base) === dKey);
    });
    if (!rest.length) {
      if (size > 0) return undefined;
      return undefined;
    }
    // index terms must share the element size coefficient
    const coef = size > 0 ? size : rest[0].coef;
    if (coef <= 0 || rest.some(x => x.coef % coef !== 0)) continue;
    let index: E | undefined;
    for (const x of rest) {
      const k = x.coef / coef;
      const term: E = k === 1 ? x.atom : { k: 'b', op: '*', l: x.atom, r: { k: 'c', v: k } };
      index = index ? { k: 'b', op: '+', l: index, r: term } : term;
    }
    let field = lin.c % coef;
    let idxConst = Math.trunc(lin.c / coef);
    if (field < 0) { field += coef; idxConst -= 1; }
    if (idxConst) index = { k: 'b', op: idxConst > 0 ? '+' : '-', l: index!, r: { k: 'c', v: Math.abs(idxConst) } };
    if (size === 0) {
      // no lower-bound subtraction: index relative to LBound (0-based arrays)
    }
    return { arr: D, index: index!, elemSize: coef, field };
  }
  return undefined;
}
