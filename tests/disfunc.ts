import { readFileSync } from 'fs';
import { Image, hex } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
import { analyze, disassembleFunction, symbolName } from '../src/core/analysis/analysis';
import { formatInsn } from '../src/core/x86/format';
const img = new Image(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
const an = analyze(img, p);
const q = process.argv[2];
const f = an.funcs.find(f => f.fullName === q || hex(f.va) === q.toUpperCase())!;
const fc = disassembleFunction(an, f);
const sym = { name: (a: number) => symbolName(an, a) ?? (an.strings.get(a) ? JSON.stringify(an.strings.get(a)!.text) : undefined), isAddr: (a: number) => img.inImage(a) };
console.log(f.fullName, hex(f.va), 'args', f.argBytes);
for (const b of fc.blocks) {
  console.log(`-- block ${hex(b.start)} -> ${b.succ.map(s => hex(s)).join(',')}`);
  for (const i of b.insns) {
    let c = '';
    if (i.mn === 'call' && i.ops[0].t === 'm' && i.ops[0].base && i.ops[0].disp) c = '';
    console.log('  ' + hex(i.va) + '  ' + formatInsn(i, sym) + c);
  }
}
