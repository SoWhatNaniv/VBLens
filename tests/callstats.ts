// Statistics on how runtime functions are called (push counts, cdecl cleanup, register args)
import { readFileSync, writeFileSync } from 'fs';
import { Image } from '../src/core/pe/pe';
import { parseVBProject } from '../src/core/vb/structures';
import { analyze, disassembleFunction } from '../src/core/analysis/analysis';
const img = new Image(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')));
const p = parseVBProject(img);
const an = analyze(img, p);
type S = { n: number; pushes: Record<number, number>; cdecl: Record<number, number>; ecx: number; edx: number; usesEax: number; fpu: number };
const st: Record<string, S> = {};
for (const f of an.funcs) {
  const fc = disassembleFunction(an, f);
  for (const b of fc.blocks) {
    const regVal: Record<string, string> = {};
    let pushes = 0; let ecxSet = false, edxSet = false;
    b.insns.forEach((i, k) => {
      if (i.mn === 'mov' && i.ops[0].t === 'r' && i.ops[1].t === 'm' && !i.ops[1].base && i.ops[1].disp !== undefined) {
        const n = an.iatNames.get(i.ops[1].disp >>> 0); if (n) regVal[i.ops[0].r!] = n; else delete regVal[i.ops[0].r!];
      }
      if (i.mn === 'push') pushes++;
      if (i.ops[0]?.t === 'r' && (i.ops[0].r === 'ecx') && i.mn !== 'push' && i.mn !== 'call') ecxSet = true;
      if (i.ops[0]?.t === 'r' && (i.ops[0].r === 'edx') && i.mn !== 'push' && i.mn !== 'call') edxSet = true;
      if (i.mn === 'call') {
        let name: string | undefined;
        const o = i.ops[0];
        if (o.t === 'm' && !o.base && o.disp !== undefined) name = an.iatNames.get(o.disp >>> 0);
        else if (o.t === 'r') name = regVal[o.r!];
        else if (o.t === 'j') name = an.thunks.get(o.v!);
        if (name) {
          const s = st[name] ??= { n: 0, pushes: {}, cdecl: {}, ecx: 0, edx: 0, usesEax: 0, fpu: 0 };
          s.n++; s.pushes[pushes] = (s.pushes[pushes] ?? 0) + 1;
          const nx = b.insns[k + 1];
          if (nx && nx.mn === 'add' && nx.ops[0].r === 'esp') s.cdecl[nx.ops[1].v!] = (s.cdecl[nx.ops[1].v!] ?? 0) + 1;
          if (ecxSet) s.ecx++; if (edxSet) s.edx++;
          if (nx && /^f/.test(nx.mn) && nx.mn !== 'fnclex') s.fpu++;
        }
        pushes = 0; ecxSet = false; edxSet = false;
        for (const r of ['eax', 'ecx', 'edx']) delete regVal[r];
      }
    });
  }
}
const rows = Object.entries(st).sort((a, b) => b[1].n - a[1].n);
writeFileSync(process.env.OUT ?? 'callstats.txt', rows.map(([n, s]) => `${n}\t${s.n}\tpush=${JSON.stringify(s.pushes)}\tcdecl=${JSON.stringify(s.cdecl)}\tecx=${s.ecx}\tedx=${s.edx}\tfpu=${s.fpu}`).join('\n'));
console.log(rows.length);
