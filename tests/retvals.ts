// Survey what eax / st0 hold at "ret" across all procedures (return value detection research).
import { readFileSync } from 'fs';
import { Session } from '../src/core/session';
import { NativeDecompiler } from '../src/core/decompiler/native';
import { printE, unref } from '../src/core/decompiler/ir';
const s = new Session(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')), 'x');
const counts = new Map<string, number>();
const ex = new Map<string, string[]>();
for (const f of s.an.funcs) {
  if (f.obj < 0) continue;
  const o = s.project.objects[f.obj];
  const d = new NativeDecompiler(s.an, f, { forms: s.forms });
  try { d.run(); } catch { continue; }
  for (const r of d.retVals) {
    const u = r.eax ? unref(r.eax) : undefined;
    const kind = `${o.kind === 'Module' ? 'mod' : 'obj'}:${u ? u.k + (u.k === 'v' ? (/^var_/.test(u.n) ? ':local' : ':' + u.n.replace(/_.*/, '')) : u.k === 'c' ? ':' + u.v : '') : 'none'}${r.fpu ? '+fpu' : ''}`;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const l = ex.get(kind) ?? []; if (l.length < 3) l.push(f.fullName + ' ' + (u ? printE(u).slice(0, 60) : '')); ex.set(kind, l);
  }
}
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k, '  e.g.', ex.get(k)!.join(' | '));
