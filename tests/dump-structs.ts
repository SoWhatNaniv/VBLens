import { readFileSync } from 'fs';
import { Image, hex } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
const img = new Image(new Uint8Array(readFileSync(process.argv[2] ?? process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
console.log(p.projectName, p.projectExeName, 'pcode', p.isPCode, 'objs', p.objects.length, 'declares', p.declares.length, 'components', p.components.length);
console.log('warnings', p.warnings);
for (const o of p.objects.slice(0, 6)) {
  console.log(o.index, o.kind, o.name, 'methods', o.methods.length, '/', o.methodCount, 'ctls', o.controls.length, 'gui', o.guiIndex, hex(o.formDataVA));
  for (const c of o.controls.slice(0, 3)) console.log('   ', c.name, c.className, c.events.map(e => `${e.name}@${hex(e.targetVA)}`).join(' '));
}
const kinds: Record<string, number> = {};
for (const o of p.objects) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
console.log(kinds);
const unk = new Set<string>();
for (const o of p.objects) for (const c of o.controls) if (!c.libName) unk.add(c.eventGuid);
console.log('unknown control event guids', [...unk]);
console.log(p.declares.slice(0, 8).map(d => `${d.type} ${d.lib}!${d.func}`));
console.log(p.components.slice(0, 5));
