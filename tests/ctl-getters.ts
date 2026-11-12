import { readFileSync } from 'fs';
import { Image, hex } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
import { analyze, disassembleFunction } from '../src/core/analysis/analysis';
import { INTERFACES_BY_GUID } from '../src/core/data/vbclasses';
const img = new Image(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
const an = analyze(img, p);
const objIdx = Number(process.argv[2] ?? 0);
const res = new Map<number, Set<string>>();
for (const f of an.funcs.filter(f => f.obj === objIdx)) {
  const fc = disassembleFunction(an, f);
  const ins = fc.insns;
  for (let k = 0; k < ins.length; k++) {
    const i = ins[k];
    if (i.mn === 'call' && i.ops[0].t === 'm' && i.ops[0].base && !i.ops[0].idx && (i.ops[0].disp ?? 0) >= 0x2f8 && (i.ops[0].disp ?? 0) < 0x6f8) {
      // following ObjSet then HresultCheckObj with IID
      for (let j = k + 1; j < Math.min(ins.length, k + 30); j++) {
        const q = ins[j];
        if (q.mn === 'push' && q.ops[0].t === 'i' && img.isMapped(q.ops[0].v!)) {
          const g = img.guid(q.ops[0].v!);
          const ifc = INTERFACES_BY_GUID[g];
          if (ifc) { const s = res.get(i.ops[0].disp!) ?? new Set(); s.add(ifc.name); res.set(i.ops[0].disp!, s); break; }
        }
      }
    }
  }
}
const o = p.objects[objIdx];
console.log(o.name, o.controls.length);
for (const [off, s] of [...res].sort((a, b) => a[0] - b[0])) console.log(hex(off), [...s].join(','));
console.log(o.controls.map(c => `${c.index}:${c.name}:${c.className}:${hex(c.fieldOffset)}:${c.ctlIndex}`).join(' '));
