// Run the full pipeline over a set of files and report crashes / stats: npx tsx tests/corpus.ts files...
import { readFileSync } from 'fs';
import { Session } from '../src/core/session';
for (const p of process.argv.slice(2)) {
  const name = p.split('/').pop()!;
  try {
    const t = Date.now();
    const s = new Session(new Uint8Array(readFileSync(p)), name);
    const ov = s.overview();
    let lines = 0, errs = 0, crash = 0, gotos = 0;
    for (const f of s.an.funcs) { try { const d = s.decompile(f.va); lines += d.lines.length; errs += d.errors.length; gotos += d.lines.filter(l => /\bGoTo Label_/.test(l.text)).length; } catch { crash++; } }
    let formErr = 0, ctls = 0;
    for (const o of s.project.objects) { const fv = s.form(o.index); if (fv) { formErr += fv.errors.length; } }
    ctls = ov.controls;
    console.log(`${name.padEnd(28)} ${ov.compile.padEnd(8)} objs=${s.project.objects.length} funcs=${s.an.funcs.length} lines=${lines} gotos=${gotos} errs=${errs} crash=${crash} ctls=${ctls} formErr=${formErr} ${Date.now() - t}ms`);
  } catch (e) { console.log(`${name.padEnd(28)} FAIL ${(e as Error).message.slice(0, 100)}`); }
}
