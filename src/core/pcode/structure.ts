// Structuring for linear (GoTo-style) statement lists, as produced by the P-Code
// decompiler: forward conditional jumps become If / ElseIf / Else blocks, backward
// jumps become Do ... Loop [While], and labels nobody jumps to anymore disappear.

import { E, printE, negate } from '../decompiler/ir';
import type { Line } from '../decompiler/native';

export type LItem =
  | { k: 'stmt'; text: string; va: number; kind?: Line['kind'] }
  | { k: 'label'; id: number; va: number }
  | { k: 'if'; cond: E; target: number; va: number } // jump to target when cond is true
  | { k: 'goto'; target: number; va: number }
  | { k: 'open'; text: string; va: number } // For ... (indents following items)
  | { k: 'close'; text: string; va: number }; // Next ...

export function structureLinear(items: LItem[], exitText: string): Line[] {
  const labelAt = new Map<number, number>();
  items.forEach((it, i) => { if (it.k === 'label') labelAt.set(it.id, i); });
  const refs = new Map<number, number>();
  const addRef = (t: number, d: number) => refs.set(t, (refs.get(t) ?? 0) + d);
  for (const it of items) if (it.k === 'if' || it.k === 'goto') addRef(it.target, 1);

  /** jumps from outside [a,b) into a label inside it? */
  const enteredFromOutside = (a: number, b: number): boolean => {
    for (let i = 0; i < items.length; i++) {
      if (i >= a && i < b) continue;
      const it = items[i];
      if ((it.k === 'if' || it.k === 'goto')) { const t = labelAt.get(it.target); if (t !== undefined && t > a && t < b) return true; }
    }
    return false;
  };
  /** jumps from inside [a,b) to labels outside other than `allowed` targets */
  const balancedOpenClose = (a: number, b: number) => {
    let d = 0;
    for (let i = a; i < b; i++) { const it = items[i]; if (it.k === 'open') d++; if (it.k === 'close') { d--; if (d < 0) return false; } }
    return d === 0;
  };

  const out: Line[] = [];
  const emit = (text: string, va: number, indent: number, kind?: Line['kind']) => out.push({ text, va, indent, kind });

  const isExitGoto = (it: LItem) => it.k === 'goto' && labelAt.get(it.target) === undefined;

  const run = (a: number, b: number, depth: number) => {
    let i = a;
    while (i < b) {
      const it = items[i];
      if (it.k === 'stmt') { emit(it.text, it.va, depth, it.kind); i++; continue; }
      if (it.k === 'open') { emit(it.text, it.va, depth); depth++; i++; continue; }
      if (it.k === 'close') { depth = Math.max(1, depth - 1); emit(it.text, it.va, depth); i++; continue; }
      if (it.k === 'label') {
        // loop: a later backward jump to this label, inside the current range
        let back = -1;
        for (let j = b - 1; j > i; j--) { const x = items[j]; if ((x.k === 'if' || x.k === 'goto') && x.target === it.id) { back = j; break; } }
        if (back > i && (refs.get(it.id) ?? 0) === 1 && !enteredFromOutside(i + 1, back) && balancedOpenClose(i + 1, back)) {
          const x = items[back] as Extract<LItem, { k: 'if' | 'goto' }>;
          addRef(it.id, -1);
          emit('Do', it.va, depth);
          run(i + 1, back, depth + 1);
          emit(x.k === 'if' ? `Loop While ${printE(x.cond)}` : 'Loop', x.va, depth);
          i = back + 1;
          continue;
        }
        if ((refs.get(it.id) ?? 0) > 0) out.push({ text: `loc_${it.id.toString(16).toUpperCase()}:`, va: it.va, indent: 0, kind: 'label' });
        i++;
        continue;
      }
      if (it.k === 'goto') {
        if (isExitGoto(it)) emit(exitText, it.va, depth);
        else {
          const t = labelAt.get(it.target)!;
          // a jump to the very next label is a no-op
          let k = i + 1;
          while (k < b && items[k].k === 'label' && (items[k] as { id: number }).id !== it.target) k++;
          if (k === t) { addRef(it.target, -1); i++; continue; }
          emit(`GoTo loc_${it.target.toString(16).toUpperCase()}`, it.va, depth);
        }
        i++;
        continue;
      }
      // conditional forward jump: If Not cond Then <body> [Else <else>] End If
      const t = labelAt.get(it.target);
      if (t !== undefined && t > i && t <= b && !enteredFromOutside(i + 1, t) && balancedOpenClose(i + 1, t)) {
        const last = t - 1 > i ? items[t - 1] : undefined;
        // Else part: body ends with an unconditional forward jump past the label
        if (last && last.k === 'goto' && !isExitGoto(last)) {
          const m = labelAt.get(last.target);
          if (m !== undefined && m > t && m <= b && (refs.get(it.target) ?? 0) === 1 && !enteredFromOutside(t + 1, m) && balancedOpenClose(t + 1, m)) {
            addRef(it.target, -1); addRef(last.target, -1);
            emit(`If ${printE(negate(it.cond))} Then`, it.va, depth);
            run(i + 1, t - 1, depth + 1);
            // ElseIf chains
            emitElse(t + 1, m, depth);
            emit('End If', it.va, depth);
            i = m;
            continue;
          }
        }
        addRef(it.target, -1);
        if (t === i + 1 || (t === i + 2 && items[i + 1].k === 'label')) { i++; continue; } // empty body
        emit(`If ${printE(negate(it.cond))} Then`, it.va, depth);
        run(i + 1, t, depth + 1);
        emit('End If', it.va, depth);
        i = t;
        continue;
      }
      // backward or unstructurable
      emit(`If ${printE(it.cond)} Then ${isExitGoto({ k: 'goto', target: it.target, va: 0 }) ? exitText : `GoTo loc_${it.target.toString(16).toUpperCase()}`}`, it.va, depth);
      i++;
    }
  };

  const emitElse = (a: number, b: number, depth: number) => {
    // "Else If ..." collapses into ElseIf when the else part is a single If block
    const sub: Line[] = [];
    const save = out.length;
    run(a, b, depth + 1);
    sub.push(...out.splice(save));
    const first = sub[0];
    const single = first && /^If .* Then$/.test(first.text) && sub[sub.length - 1].text === 'End If' && sub[sub.length - 1].indent === depth + 1 &&
      sub.slice(1, -1).every(l => l.indent > depth + 1 || /^(ElseIf .* Then|Else)$/.test(l.text));
    if (single) {
      out.push({ ...first, text: 'Else' + first.text, indent: depth });
      for (const l of sub.slice(1, -1)) out.push({ ...l, indent: l.indent - 1 });
    } else if (sub.length) {
      out.push({ text: 'Else', va: sub[0].va, indent: depth });
      out.push(...sub);
    }
  };

  run(0, items.length, 1);
  // a trailing "Exit Sub" right before the end is implicit
  while (out.length && out[out.length - 1].text === exitText && out[out.length - 1].indent === 1) out.pop();
  return out;
}
