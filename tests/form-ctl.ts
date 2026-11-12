import { readFileSync } from 'fs';
import { Image } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
import { parseForm } from '../src/core/vb/forms';
const img = new Image(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
const o = p.objects.find(o => o.name === process.argv[2])!;
const f = parseForm(img, p, o);
const b = img.slice(o.formDataVA, o.formDataSize);
const hexs = (a: Uint8Array) => [...a].map(x => x.toString(16).padStart(2, '0')).join(' ');
for (const c of f.controls) {
  if (process.argv[3] && c.name !== process.argv[3]) continue;
  const len = b[c.offset] | b[c.offset + 1] << 8;
  console.log(c.name, c.className, 'off', c.offset.toString(16), 'len', len.toString(16), c.partial ? 'PARTIAL' : '', c.props.map(p => p.name + '=' + p.value).join('; ').slice(0, 300));
  if (process.argv[3]) console.log(hexs(b.subarray(c.offset, c.offset + Math.min(len + 6, 400))));
}
console.log(f.errors);
