import { readFileSync } from 'fs';
import { Image, hex } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
import { analyze, disassembleFunction, symbolName, funcContaining } from '../src/core/analysis/analysis';
import { formatInsn } from '../src/core/x86/format';
import { INTERFACES_BY_NAME } from '../src/core/data/vbclasses';
const img = new Image(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
const an = analyze(img, p);
const g = INTERFACES_BY_NAME[process.argv[2] ?? '_TextBox'].guid;
// find guid bytes
const want = g;
const hits: number[] = [];
for (const s of img.sections) for (let o = s.rawOffset; o + 16 < s.rawOffset + s.rawSize; o += 4) { const va = s.va + (o - s.rawOffset); if (img.u32(va) === parseInt(g.slice(1, 9), 16) && img.guid(va) === want) hits.push(va); }
console.log(g, hits.map(h => hex(h)));
const xs = an.xrefs.get(hits[0]) ?? [];
console.log('xrefs', xs.length);
const sym = { name: (a: number) => symbolName(an, a) ?? (an.strings.get(a) ? JSON.stringify(an.strings.get(a)!.text) : undefined), isAddr: (a: number) => img.inImage(a) };
for (const x of xs.slice(0, 2)) {
  const f = funcContaining(an, x.from)!;
  const fc = disassembleFunction(an, f);
  const idx = fc.insns.findIndex(i => i.va === x.from);
  console.log('==', f.fullName);
  for (const i of fc.insns.slice(Math.max(0, idx - 25), idx + 3)) console.log('  ' + hex(i.va) + '  ' + formatInsn(i, sym));
}
