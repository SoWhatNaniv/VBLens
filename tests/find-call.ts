// Print disassembly context around calls to a runtime import: npx tsx tests/find-call.ts __vbaInStrVar [n]
import { readFileSync } from 'fs';
import { Session } from '../src/core/session';
const s = new Session(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')), 'x');
const name = process.argv[2]; let n = Number(process.argv[3] ?? 2);
for (const f of s.an.funcs) {
  const d = s.disasm(f.va);
  d.rows.forEach((r, i) => {
    if (n <= 0) return;
    if (r.toks.some(t => t.t.includes(name)) && r.toks[0].t.startsWith('call')) {
      n--;
      console.log('==', f.fullName);
      for (const x of d.rows.slice(Math.max(0, i - 12), i + 3)) console.log(x.va.toString(16), x.toks.map(t => t.t).join(''), x.comment ? ' ; ' + x.comment : '');
    }
  });
  if (n <= 0) break;
}
