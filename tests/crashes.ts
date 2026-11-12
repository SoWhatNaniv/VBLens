import { readFileSync } from 'fs';
import { Session } from '../src/core/session';
import { NativeDecompiler } from '../src/core/decompiler/native';
const s = new Session(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')), 'x');
let n = 0;
for (const f of s.an.funcs) {
  const d = new NativeDecompiler(s.an, f, { forms: s.forms });
  try { const r = d.run(); for (const e of r.errors) if (/reading/.test(e) && n++ < 6) console.log(f.fullName, e); } catch (e) { console.log('CRASH', f.fullName, (e as Error).message); }
}
console.log('n', n);
