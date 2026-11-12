// Decompile functions of any file: npx tsx tests/pc.ts <file> [nameFilter] [max]
import { readFileSync } from 'fs';
import { Session } from '../src/core/session';
const s = new Session(new Uint8Array(readFileSync(process.argv[2])), 'x');
const filt = process.argv[3] ?? ''; let max = Number(process.argv[4] ?? 3);
for (const f of s.an.funcs) {
  if (filt && !f.fullName.includes(filt)) continue;
  if (max-- <= 0) break;
  const d = s.decompile(f.va);
  console.log(d.header); for (const l of d.lines) console.log('  '.repeat(l.indent + 1) + l.text); console.log(d.footer);
  if (d.errors.length) console.log('ERR', d.errors);
}
