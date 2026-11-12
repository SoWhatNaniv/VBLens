// Compares our decoder against a capstone linear-sweep dump (tests/capdump.py).
import { readFileSync } from 'fs';
import { Image } from '../src/core/pe/pe';
import { decode } from '../src/core/x86/decoder';
import { formatInsn } from '../src/core/x86/format';

const img = new Image(new Uint8Array(readFileSync(process.argv[2])));
const lines = readFileSync(process.argv[3], 'utf8').split('\n');
const ALIAS: Record<string, string> = { fcompi: 'fcomip', fucompi: 'fucomip', feni8087_nop: 'fneni', fdisi8087_nop: 'fndisi', setpm: 'fsetpm' };
const norm = (s: string) => s
  .replace(/^(bnd|notrack|repz|repne|rep) (j|ret|call|retf)/, '$2')
  .replace(/^(bnd|notrack) /, '')
  .replace(/^(\w+)/, m => ALIAS[m] ?? m)
  .replace(/^l(jmp|call) /, '$1 ')
  .replace(/(?<![\w(])-?(0x[0-9a-f]+|\d+)(?![\w)])/g, m => { const v = m.startsWith('-') ? -Number(m.slice(1)) : Number(m); return String(v >>> 0); })
  .replace(/\b(xword|tbyte|fword|dword|qword|word|byte) ptr /g, '').replace(/\bptr /g, '')
  .replace(/\bds:/g, '')
  .replace(/^(rcl|rcr|rol|ror|shl|shr|sal|sar) (.*), 1$/, '$1 $2')
  .replace(/st\(0\), /g, '').replace(/, st\(0\)$/, '')
  .replace(/\s+/g, ' ').trim();
let total = 0, lenMismatch = 0, textMismatch = 0;
const byMn: Record<string, number> = {};
const samples: string[] = [];
for (const ln of lines) {
  if (!ln) continue;
  const [a, l, mn, ops] = ln.split('\t');
  if (mn === '.byte') continue;
  const va = parseInt(a, 16);
  const off = img.offsetOf(va);
  const ins = decode(img.bytes, off, va);
  total++;
  const ours = formatInsn(ins);
  const theirs = (mn + ' ' + (ops ?? '')).trim();
  if (ins.len !== Number(l)) {
    lenMismatch++;
    byMn['LEN:' + mn] = (byMn['LEN:' + mn] ?? 0) + 1;
    if (samples.length < 400) samples.push(`LEN ${a} [${Buffer.from(img.slice(va, Number(l))).toString('hex')}] cap="${theirs}" ours="${ours}" (${ins.len})`);
    continue;
  }
  if (norm(ours) !== norm(theirs)) {
    textMismatch++;
    const k = mn + ' / ' + ins.mn;
    byMn[k] = (byMn[k] ?? 0) + 1;
    if ((byMn[k] ?? 0) <= 2 && samples.length < 400) samples.push(`TXT ${a} [${Buffer.from(img.slice(va, Number(l))).toString('hex')}] cap="${theirs}" ours="${ours}"`);
  }
}
console.log({ total, lenMismatch, textMismatch });
console.log(Object.entries(byMn).sort((x, y) => y[1] - x[1]).slice(0, 60));
console.log(samples.slice(0, Number(process.argv[4] ?? 60)).join('\n'));
