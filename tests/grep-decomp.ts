// print decompiled lines matching a regex, with function names (first N)
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
const re = new RegExp(process.argv[2]);
let n = 0; const max = Number(process.argv[3] ?? 30);
for (const f of an.funcs) {
  const r = decompileNative(an, f, { forms });
  for (const l of r.lines) if (re.test(l.text)) { console.log(f.fullName.padEnd(40), l.va ? hex(l.va) : '      ', l.text); if (++n >= max) process.exit(0); }
}
