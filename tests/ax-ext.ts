import { readFileSync } from 'fs';
import { Image } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
import { parseForm } from '../src/core/vb/forms';
const img = new Image(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
for (const o of p.objects) { if (!o.formDataVA) continue; const f = parseForm(img, p, o); const b = img.slice(o.formDataVA, o.formDataSize);
 for (const c of f.controls) { if (c.typeCode !== 0xff) continue; let q = c.offset + 3 + 1 + 1 + (c.arrayIndex !== undefined ? 2 : 0); const nl = b[q] | b[q+1]<<8; q += 2 + nl + 1 + 1; const pl = b[q]|b[q+1]<<8; q += 2+pl+1;
  console.log(o.name.padEnd(14), c.name.padEnd(16), [...b.subarray(q, q+24)].map(x=>x.toString(16).padStart(2,'0')).join(' ')); } }
