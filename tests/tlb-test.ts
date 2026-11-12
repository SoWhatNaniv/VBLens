// Load OCX type libraries into a session and measure unresolved members: npx tsx tests/tlb-test.ts a.ocx b.ocx
import { readFileSync } from 'fs';
import { Session } from '../src/core/session';
const s = new Session(new Uint8Array(readFileSync(process.env.VB_SAMPLE ?? 'samples/EshkolPlus.exe')), 'x');
const count = () => { let m = 0, d = 0; for (const f of s.an.funcs) for (const l of s.decompile(f.va).lines) { m += (l.text.match(/Method_[0-9A-F]+/g) ?? []).length; d += (l.text.match(/DispID_[0-9A-F]+/g) ?? []).length; } return { m, d }; };
console.log('before', count());
for (const p of process.argv.slice(2)) { try { console.log(p.split('/').pop(), JSON.stringify(s.loadTypeLib(new Uint8Array(readFileSync(p))))); } catch (e) { console.log('ERR', p, (e as Error).message); } }
console.log('after', count());
const f = s.an.funcs.find(f => f.fullName === 'kelet.show_big_arrival')!;
console.log(s.decompile(f.va).lines.slice(5, 16).map(l => '  '.repeat(l.indent) + l.text).join('\n'));
