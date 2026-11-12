// Sample lines containing unresolved constructs: npx tsx tests/unk-sample.ts Method_ 30
import { readFileSync } from 'fs';
import { Session } from '../src/core/session';
const s = new Session(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')), 'x');
const pat = new RegExp(process.argv[2]); const max = Number(process.argv[3] ?? 30);
const counts = new Map<string, number>(); const ex = new Map<string, string>();
for (const f of s.an.funcs) {
  const d = s.decompile(f.va);
  for (const l of d.lines) if (pat.test(l.text)) {
    const m = /([\w.()]+)\.(Method_[0-9A-F]+)/.exec(l.text);
    const k = m ? m[1].replace(/\(.*\)/, '()').replace(/var_\w+|tmp\d+/, 'var') + '.' + m[2] : l.text.slice(0, 50);
    counts.set(k, (counts.get(k) ?? 0) + 1); if (!ex.has(k)) ex.set(k, f.fullName + ': ' + l.text.trim().slice(0, 140));
  }
}
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, max)) console.log(String(v).padStart(4), k, ' :: ', ex.get(k));
