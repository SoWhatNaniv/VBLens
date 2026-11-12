// Dump per-block statements before structuring: npx tsx tests/blockdump.ts <name>
import { readFileSync } from 'fs';
import { Session } from '../src/core/session';
import { NativeDecompiler } from '../src/core/decompiler/native';
import { printE } from '../src/core/decompiler/ir';
const s = new Session(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')), 'x');
const f = s.an.funcs.find(f => f.fullName === process.argv[2])!;
const d = new NativeDecompiler(s.an, f, { forms: s.forms });
d.run();
const anyD = d as unknown as { blockStmts: Map<number, unknown[]>; noise: Set<number>; succ: Map<number, number[]>; blockCond: Map<number, { cond: never } | undefined> };
for (const [b, sts] of [...anyD.blockStmts].sort((a, b) => a[0] - b[0])) {
  const c = anyD.blockCond.get(b);
  console.log(`-- ${b.toString(16)}${anyD.noise.has(b) ? ' NOISE' : ''} -> ${(anyD.succ.get(b) ?? []).map(x => x.toString(16)).join(',')}${c ? ' if ' + printE(c.cond) : ''}`);
  for (const st of sts as { k: string; inline?: boolean; dst?: never; src?: never; e?: never; t?: string }[]) console.log('   ', st.inline ? '(inl)' : '', st.k === 'assign' ? printE(st.dst!) + ' = ' + printE(st.src!) : st.k === 'expr' ? printE(st.e!) : st.t ?? st.k);
}
console.log('errors', d.run().errors);
