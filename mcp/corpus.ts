/**
 * Robustness check: drives the built server through every read-only tool on a list of
 * binaries and reports internal errors or oversized replies.
 *
 *   npm run build:mcp && npx tsx mcp/corpus.ts a.exe b.ocx ...
 */
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const c = new Client({ name: 'corpus', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist-mcp/vblens-mcp.mjs', '--no-persist', '--no-ui'], env: getDefaultEnvironment() }));
type R = { isError?: boolean; content: { text: string }[]; structuredContent?: any };
let calls = 0, internal = 0, big = 0;
const call = async (n: string, a: Record<string, unknown>) => { calls++; const r = await c.callTool({ name: n, arguments: a }) as R; const t = r.content[0].text; if (/Internal error/.test(t)) { internal++; console.log('INTERNAL', n, JSON.stringify(a), t.slice(0, 200)); } if (t.length > 26000) { big++; console.log('BIG', n, t.length); } return r; };
for (const f of process.argv.slice(2)) {
  const o = await call('vb_open_file', { path: f, response_format: 'json' });
  if (o.isError) { console.log('skip', f.split('/').pop(), '-', o.content[0].text.slice(0, 90)); continue; }
  const id = o.structuredContent.file_id;
  const objs = (await call('vb_list_objects', { response_format: 'json' })).structuredContent.objects as { name: string; index: number; has_form: boolean }[];
  const procs = (await call('vb_list_procedures', { limit: 500, response_format: 'json' })).structuredContent.procedures as { address: string }[];
  const pick = procs.filter((_, i) => i % Math.max(1, Math.floor(procs.length / 25)) === 0);
  for (const p of pick) { for (const [n, a] of [['vb_decompile', { procedure: p.address, addresses: true }], ['vb_disassemble', { target: p.address }], ['vb_get_cfg', { procedure: p.address, instructions: true, response_format: 'json' }], ['vb_get_procedure_info', { procedure: p.address }], ['vb_get_xrefs', { target: p.address, deep: false }]] as const) await call(n, a); }
  for (const ob of objs.slice(0, 12)) { await call('vb_decompile_object', { object: String(ob.index) }); if (ob.has_form) { await call('vb_get_form', { object: ob.name }); await call('vb_get_form', { object: ob.name, view: 'frm' }); await call('vb_get_form', { object: ob.name, response_format: 'json' }); } }
  for (const [n, a] of [['vb_list_strings', { limit: 1000 }], ['vb_list_imports', { limit: 1000, response_format: 'json' }], ['vb_list_api_declares', { limit: 1000 }], ['vb_search', { query: 'a' }], ['vb_search_code', { query: 'e', limit: 500 }], ['vb_get_overview', {}]] as const) await call(n, a);
  console.log('ok  ', f.split('/').pop(), o.structuredContent.compiled_as, procs.length, 'procs');
  await call('vb_close_file', { file: id });
}
console.log({ calls, internal, big });
await c.close();
if (internal || big) process.exit(1);
