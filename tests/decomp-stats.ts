import { readFileSync } from 'fs';
import { Image, hex } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
import { analyze } from '../src/core/analysis/analysis';
import { decompileNative } from '../src/core/decompiler/native';
import { parseForm } from '../src/core/vb/forms';
const img = new Image(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
const an = analyze(img, p);
const forms = new Map(p.objects.filter(o => o.formDataVA).map(o => [o.index, parseForm(img, p, o)]));
const errs: Record<string, number> = {};
const gotoF: [string, number, number][] = [];
const unk: Record<string, number> = {};
let lines = 0;
for (const f of an.funcs) {
  const r = decompileNative(an, f, { forms });
  for (const e of r.errors) { const k = e.replace(/^[0-9A-F]+: /, ''); errs[k] = (errs[k] ?? 0) + 1; }
  gotoF.push([f.fullName, r.stats.gotos, r.lines.length]);
  lines += r.lines.length;
  for (const l of r.lines) for (const m of l.text.matchAll(/\b(Method_[0-9A-F]+|cond_\w+|asm: \w+|\?|Event\d+|CallPtr_\w+|sub_[0-9A-F]+)\b/g)) unk[m[1].replace(/_[0-9A-F]+$/, '')] = (unk[m[1].replace(/_[0-9A-F]+$/, '')] ?? 0) + 1;
}
console.log('lines', lines);
console.log(Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 15));
console.log(gotoF.sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log(Object.entries(unk).sort((a, b) => b[1] - a[1]).slice(0, 25));
const zero = gotoF.filter(g => g[1] === 0).length;
console.log('funcs with 0 gotos', zero, 'of', gotoF.length);
console.log(gotoF.filter(g => g[1] > 0 && g[2] < 60).slice(0, 10));
