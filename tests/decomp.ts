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
const q = process.argv[2];
const fs = q === 'ALL' ? an.funcs : an.funcs.filter(f => f.fullName === q || hex(f.va) === q.toUpperCase() || f.fullName.endsWith('.' + q));
let t = Date.now(), errs = 0, gotos = 0;
for (const f of fs) {
  const r = decompileNative(an, f, { forms });
  errs += r.errors.length; gotos += r.stats.gotos;
  if (q !== 'ALL') {
    console.log(`' ${f.fullName} @ ${hex(f.va)}`);
    console.log(r.header);
    for (const l of r.lines) console.log('  '.repeat(l.indent) + l.text);
    console.log('End Sub');
    if (r.errors.length) console.log('ERRORS', r.errors.slice(0, 10));
  }
}
if (q === 'ALL') console.log('funcs', fs.length, 'ms', Date.now() - t, 'errors', errs, 'gotos', gotos);
