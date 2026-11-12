import { readFileSync } from 'fs';
import { Image } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
import { parseForm } from '../src/core/vb/forms';
const img = new Image(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
let total = 0, partial = 0;
const errs: Record<string, number> = {};
for (const o of p.objects.filter(o => o.formDataVA)) {
  const f = parseForm(img, p, o);
  total += f.controls.length;
  partial += f.controls.filter(c => c.partial).length;
  for (const e of f.errors) { const k = e.replace(/^[^:]*: /, ''); errs[k] = (errs[k] ?? 0) + 1; }
  if (process.argv[2] === o.name) console.log(f.frm.split('\r\n').slice(0, Number(process.argv[3] ?? 80)).join('\n'));
  if (!process.argv[2]) console.log(o.name.padEnd(28), f.controls.length, 'ctls', f.errors.length, 'errors', f.codepage, f.errors.slice(0, 2).join(' | '));
}
console.log({ total, partial });
console.log(Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 40));
