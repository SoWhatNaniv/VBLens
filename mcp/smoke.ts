/**
 * Self-check: starts the built server over stdio, calls every tool the way an agent
 * would, and exits non-zero on any failure.
 *
 *   npm run build:mcp && VB_SAMPLE=/path/to/some-vb6.exe npm run test:mcp
 *
 * Optional: VB_PCODE (a P-Code binary), VB_BAD (a non-VB PE), VB_TLB (an ActiveX .ocx).
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SAMPLE = process.env.VB_SAMPLE;
if (!SAMPLE || !existsSync(SAMPLE)) {
  console.error('Set VB_SAMPLE to the path of a VB5/VB6 executable to test with.');
  process.exit(2);
}
import { safeRelPath } from './tools';

const SERVER = process.env.VBLENS_MCP ?? 'dist-mcp/vblens-mcp.mjs';
const stateDir = mkdtempSync(path.join(tmpdir(), 'vblens-mcp-state-'));
const outDir = mkdtempSync(path.join(tmpdir(), 'vblens-mcp-out-'));

function connect(extraArgs: string[] = []): Promise<Client> {
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  const args = [SERVER, '--state-dir', stateDir, ...extraArgs];
  return client.connect(new StdioClientTransport({ command: process.execPath, args, env: getDefaultEnvironment() })).then(() => client);
}

type Result = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };
let calls = 0;
let maxLen = 0;

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  calls++;
  const r = (await c.callTool({ name, arguments: args })) as Result;
  const text = r.content.map(x => x.text ?? '').join('');
  maxLen = Math.max(maxLen, text.length);
  assert.ok(text.length <= 26_000, `${name} returned ${text.length} characters`);
  return r;
}
const text = (r: Result) => r.content.map(x => x.text ?? '').join('\n');
async function ok(c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await call(c, name, args);
  assert.ok(!r.isError, `${name}(${JSON.stringify(args)}) failed: ${text(r)}`);
  return text(r);
}
async function json<T>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(c, name, { ...args, response_format: 'json' });
  assert.ok(!r.isError, `${name}(${JSON.stringify(args)}) failed: ${text(r)}`);
  assert.ok(r.structuredContent, `${name} json mode returned no structuredContent`);
  assert.deepEqual(JSON.parse(text(r)), r.structuredContent, `${name}: text and structuredContent differ`);
  return r.structuredContent as T;
}
async function fails(c: Client, name: string, args: Record<string, unknown>, expect: RegExp): Promise<void> {
  const r = await call(c, name, args);
  assert.equal(r.isError, true, `${name}(${JSON.stringify(args)}) should fail`);
  assert.match(text(r), expect, `${name} error text`);
}
const step = (s: string) => console.error(`  ok  ${s}`);

interface Page { total: number; count: number; has_more: boolean; next_offset?: number }
interface ProcRow { address: string; name: string; kind: string; size: number }

try {
  let c = await connect();

  const { tools } = await c.listTools();
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, [
    'vb_app_status', 'vb_close_file', 'vb_decompile', 'vb_decompile_object', 'vb_disassemble', 'vb_export_project', 'vb_get_cfg', 'vb_get_form',
    'vb_get_overview', 'vb_get_procedure_info', 'vb_get_user_view', 'vb_get_xrefs', 'vb_list_api_declares', 'vb_list_files', 'vb_list_imports',
    'vb_list_objects', 'vb_list_procedures', 'vb_list_strings', 'vb_load_type_library', 'vb_open_app', 'vb_open_file', 'vb_read_bytes',
    'vb_rename', 'vb_resolve_address', 'vb_search', 'vb_search_code', 'vb_set_comment', 'vb_show_in_app',
  ]);
  for (const t of tools) {
    assert.ok(t.title && t.description && t.description.length > 40, `${t.name} needs a title and description`);
    assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', `${t.name} needs annotations`);
  }
  step(`${tools.length} tools listed with titles, descriptions and annotations`);

  // --- before anything is open
  await fails(c, 'vb_list_objects', {}, /vb_open_file/);
  await fails(c, 'vb_open_file', { path: path.join(tmpdir(), 'does-not-exist.exe') }, /not found/i);
  await fails(c, 'vb_open_file', { path: tmpdir() }, /folder/i);
  assert.match(await ok(c, 'vb_list_files'), /No file is open/);
  step('helpful errors before a file is open');

  // --- the app link (no browser connected here; tests/e2e/live.py covers a real one)
  let status = '';
  for (let i = 0; i < 40 && !/App address/.test(status); i++) { status = await ok(c, 'vb_app_status'); await new Promise(r => setTimeout(r, 100)); }
  const appUrl = /App address: (\S+)/.exec(status)?.[1];
  assert.ok(appUrl, `vb_app_status should report the app address: ${status}`);
  const page = await fetch(appUrl!);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /window\.__VBLENS_LIVE__=\{"token":"[0-9a-f]{48}"/, 'the served app carries its live token');
  assert.equal((await fetch(new URL('/live/rpc', appUrl), { method: 'POST', body: '{}' })).status, 401, 'app calls need the token');
  await fails(c, 'vb_get_user_view', {}, /No app window is connected/);
  await fails(c, 'vb_show_in_app', { target: '0x00401000' }, /vb_open_app/);
  step(`app served at ${appUrl} with token-protected live channel`);

  // --- open
  const ov = await json<{ file_id: string; sha256: string; procedures: number; compiled_as: string; reused: boolean; objects: Record<string, number> }>(c, 'vb_open_file', { path: SAMPLE });
  assert.ok(ov.procedures > 0 && /^[0-9a-f]{64}$/.test(ov.sha256) && !ov.reused);
  const again = await json<{ reused: boolean }>(c, 'vb_open_file', { path: SAMPLE });
  assert.equal(again.reused, true, 'reopening the same path should be instant');
  assert.match(await ok(c, 'vb_get_overview'), /Compiled as: (Native code|P-Code)/);
  assert.match(await ok(c, 'vb_list_files'), new RegExp('\\* ' + ov.file_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  step(`opened ${ov.file_id}: ${ov.compiled_as}, ${ov.procedures} procedures`);

  // --- structure
  const objs = await json<{ objects: { index: number; name: string; kind: string; procedures: number; has_form: boolean }[] }>(c, 'vb_list_objects');
  assert.ok(objs.objects.length > 0);
  await ok(c, 'vb_list_objects');
  const busiest = [...objs.objects].sort((a, b) => b.procedures - a.procedures)[0];
  const page1 = await json<Page & { procedures: ProcRow[] }>(c, 'vb_list_procedures', { limit: 5 });
  assert.equal(page1.count, Math.min(5, page1.total));
  if (page1.has_more) {
    const page2 = await json<Page & { procedures: ProcRow[] }>(c, 'vb_list_procedures', { limit: 5, offset: page1.next_offset });
    assert.notEqual(page2.procedures[0].address, page1.procedures[0].address, 'pagination should advance');
  }
  const inObj = await json<Page & { procedures: ProcRow[] }>(c, 'vb_list_procedures', { object: busiest.name, sort: 'size', limit: 500 });
  assert.equal(inObj.total, busiest.procedures);
  assert.ok(inObj.procedures.every((p, i, a) => i === 0 || a[i - 1].size >= p.size), 'sort=size should be descending');
  await ok(c, 'vb_list_procedures', { name_contains: 'zzzz_no_such_name' });
  await fails(c, 'vb_list_procedures', { object: 'NoSuchObject_zz' }, /vb_list_objects/);
  step(`objects and procedures (${objs.objects.length} objects, pagination, filters, sort)`);

  // --- code
  const big = inObj.procedures[0];
  const mid = inObj.procedures[Math.floor(inObj.procedures.length / 2)];
  const src = await ok(c, 'vb_decompile', { procedure: mid.name });
  assert.match(src, /\b(Sub|Function|Property)\b/);
  assert.match(src, /End (Sub|Function|Property)/);
  const withAddr = await ok(c, 'vb_decompile', { procedure: mid.address, addresses: true });
  assert.match(withAddr, /^0x[0-9A-F]{8} {2}/m);
  const paged = await ok(c, 'vb_decompile', { procedure: big.name, limit: 5 });
  if (/More: call again with offset=5/.test(paged)) await ok(c, 'vb_decompile', { procedure: big.name, limit: 5, offset: 5 });
  await fails(c, 'vb_decompile', { procedure: 'No_Such_Procedure_zz' }, /vb_list_procedures|Closest/);
  await fails(c, 'vb_decompile', { procedure: '0x00000010' }, /not inside/);
  const asm = await ok(c, 'vb_disassemble', { target: mid.name, bytes: true, limit: 50 });
  assert.match(asm, /^0x[0-9A-F]{8} {2}/m);
  const cfg = await json<{ block_count: number; blocks: unknown[] }>(c, 'vb_get_cfg', { procedure: big.name });
  assert.ok(cfg.block_count >= 1 && cfg.blocks.length >= 1 && cfg.blocks.length <= cfg.block_count);
  await ok(c, 'vb_get_cfg', { procedure: mid.name, instructions: true });
  const info = await json<{ name: string; address: string; callers: unknown[]; callees: unknown[] }>(c, 'vb_get_procedure_info', { procedure: mid.address });
  assert.equal(info.name, mid.name);
  await ok(c, 'vb_get_procedure_info', { procedure: big.name });
  const small = [...objs.objects].filter(o => o.procedures > 0).sort((a, b) => a.procedures - b.procedures)[0];
  assert.match(await ok(c, 'vb_decompile_object', { object: small.name, limit: 200 }), /Attribute VB_Name/);
  step('decompile, disassemble, CFG, procedure info, whole-object source');

  // --- data
  const strs = await json<Page & { strings: { address: string; text: string; refs: number }[] }>(c, 'vb_list_strings', { min_length: 4, limit: 20 });
  await ok(c, 'vb_list_strings', { regex: '^[A-Za-z]', limit: 10 });
  await fails(c, 'vb_list_strings', { regex: '(' }, /Invalid regular expression/);
  if (strs.strings.length) {
    const s0 = strs.strings.find(s => s.refs > 0) ?? strs.strings[0];
    const x = await json<Page & { references: { procedure: string }[] }>(c, 'vb_get_xrefs', { target: s0.address });
    assert.ok(x.total >= 0);
    const r = await json<{ kind: string }>(c, 'vb_resolve_address', { address: s0.address });
    assert.equal(r.kind, 'string');
    await ok(c, 'vb_read_bytes', { address: s0.address, length: 64 });
  }
  const imps = await json<Page & { imports: { name: string; uses: number }[] }>(c, 'vb_list_imports', { used_only: true, limit: 10 });
  if (imps.imports.length) {
    const x = await json<Page>(c, 'vb_get_xrefs', { target: imps.imports[0].name, limit: 5 });
    assert.ok(x.total > 0, `${imps.imports[0].name} should have references`);
  }
  const decl = await json<Page & { declares: { name: string; uses: number }[] }>(c, 'vb_list_api_declares', {});
  await ok(c, 'vb_list_api_declares', { contains: 'kernel' });
  const usedDecl = decl.declares.find(d => d.uses > 0);
  if (usedDecl) assert.match(await ok(c, 'vb_get_xrefs', { target: usedDecl.name }), /API declare/);
  await ok(c, 'vb_get_xrefs', { target: mid.name, deep: false });
  await fails(c, 'vb_get_xrefs', { target: 'NoSuchThing_zz' }, /vb_list_imports/);
  await fails(c, 'vb_read_bytes', { address: '0x00000004' }, /mapped sections/);
  await fails(c, 'vb_read_bytes', { address: 'banana' }, /not an address/);
  step('strings, imports, API declares, xrefs, resolve, read bytes');

  // --- forms
  const form = objs.objects.find(o => o.has_form);
  if (form) {
    const tree = await ok(c, 'vb_get_form', { object: form.name });
    assert.match(tree, /controls/);
    const fj = await json<Page & { controls: { name: string }[] }>(c, 'vb_get_form', { object: form.name });
    assert.ok(fj.controls.length >= 1);
    await ok(c, 'vb_get_form', { object: form.name, view: 'control', control: fj.controls[fj.controls.length - 1].name });
    assert.match(await ok(c, 'vb_get_form', { object: form.name, view: 'frm', limit: 40 }), /VERSION|Begin/);
    await fails(c, 'vb_get_form', { object: form.name, view: 'control', control: 'NoSuchControl_zz' }, /view="controls"/);
  }
  const noForm = objs.objects.find(o => !o.has_form);
  if (noForm) await fails(c, 'vb_get_form', { object: noForm.name }, /no form layout/);
  step('form controls, single control, .frm text');

  // --- search
  const frag = mid.name.split('.').pop()!.slice(0, 6);
  const found = await json<{ count: number }>(c, 'vb_search', { query: frag });
  assert.ok(found.count > 0, `vb_search should find "${frag}"`);
  await ok(c, 'vb_search', { query: 'zzqqxxnotthere' });
  const grep = await json<{ count: number; has_more: boolean; next_offset?: number; matches: { procedure: string }[] }>(c, 'vb_search_code', { query: 'End', regex: false, object: small.name, limit: 5 });
  assert.ok(grep.count >= 0);
  const g2 = await json<{ count: number; matches: { line: string }[] }>(c, 'vb_search_code', { query: '^\\s*If\\b.*Then', regex: true, limit: 10 });
  assert.ok(g2.matches.every(m => /If\b/.test(m.line)));
  await fails(c, 'vb_search_code', { query: '(', regex: true }, /Invalid regular expression/);
  step('fuzzy search and code search');

  // --- annotations persist across server restarts
  const target = inObj.procedures.find(p => p.address !== mid.address) ?? mid;
  await fails(c, 'vb_rename', { target: target.address, new_name: '1bad' }, /not a valid name/);
  await fails(c, 'vb_rename', { target: target.address, new_name: 'Dim' }, /reserved/);
  assert.match(await ok(c, 'vb_rename', { target: target.address, new_name: 'McpSmokeRenamed' }), /Saved for future sessions/);
  const other = inObj.procedures.find(p => p.address !== target.address);
  if (other) await fails(c, 'vb_rename', { target: other.address, new_name: 'mcpsmokerenamed' }, /already has a procedure/);
  assert.match(await ok(c, 'vb_decompile', { procedure: `${busiest.name}.McpSmokeRenamed` }), /McpSmokeRenamed/);
  const lineAddr = /^(0x[0-9A-F]{8}) {2}\s+\S/m.exec((await ok(c, 'vb_decompile', { procedure: mid.address, addresses: true })).split('\n').slice(2).join('\n'))?.[1];
  if (lineAddr) {
    await ok(c, 'vb_set_comment', { address: lineAddr, comment: 'smoke-test note' });
    assert.match(await ok(c, 'vb_decompile', { procedure: mid.address }), /smoke-test note/);
  }
  await c.close();
  c = await connect();
  await ok(c, 'vb_open_file', { path: SAMPLE });
  const pi = await json<{ name: string }>(c, 'vb_get_procedure_info', { procedure: target.address });
  assert.match(pi.name, /McpSmokeRenamed$/, 'rename should survive a restart');
  if (lineAddr) {
    assert.match(await ok(c, 'vb_decompile', { procedure: mid.address }), /smoke-test note/, 'comment should survive a restart');
    await ok(c, 'vb_set_comment', { address: lineAddr, comment: '' });
    assert.doesNotMatch(await ok(c, 'vb_decompile', { procedure: mid.address }), /smoke-test note/);
  }
  step('rename and comment: validation, effect, persistence across restart');

  // --- export
  assert.match(await ok(c, 'vb_export_project', { output_dir: outDir }), /Exported \d+ files/);
  const written = readdirSync(outDir);
  assert.ok(written.some(f => f.endsWith('.vbp')), 'export should contain a .vbp');
  await fails(c, 'vb_export_project', { output_dir: outDir }, /not empty/);
  step(`export wrote ${written.length} entries`);

  // --- other inputs
  if (process.env.VB_BAD) {
    await fails(c, 'vb_open_file', { path: process.env.VB_BAD }, /Visual Basic 5\/6/);
    assert.match(await ok(c, 'vb_get_overview'), /Compiled as/, 'a failed open must keep the current file');
    step('non-VB file rejected, current file kept');
  }
  if (process.env.VB_TLB) {
    assert.match(await ok(c, 'vb_load_type_library', { path: process.env.VB_TLB }), /Loaded type library/);
    await fails(c, 'vb_load_type_library', { path: SAMPLE }, /type library/);
    step('type library loaded');
  }
  if (process.env.VB_PCODE) {
    const pc = await json<{ file_id: string; compiled_as: string }>(c, 'vb_open_file', { path: process.env.VB_PCODE });
    assert.equal(pc.compiled_as, 'P-Code');
    const procs = await json<Page & { procedures: ProcRow[] }>(c, 'vb_list_procedures', { sort: 'size', limit: 3 });
    assert.ok(procs.total > 0);
    assert.match(await ok(c, 'vb_decompile', { procedure: procs.procedures[0].address }), /\b(Sub|Function|Property)\b/);
    assert.match(await ok(c, 'vb_disassemble', { target: procs.procedures[0].address }), /P-Code/);
    await ok(c, 'vb_get_cfg', { procedure: procs.procedures[0].address });
    // both files stay addressable
    assert.match(await ok(c, 'vb_get_overview', { file: ov.file_id }), new RegExp(ov.sha256));
    await ok(c, 'vb_close_file', { file: pc.file_id });
    assert.match(await ok(c, 'vb_get_overview'), new RegExp(ov.sha256), 'closing should fall back to the other file');
    step('P-Code binary; two files open at once');
  }
  await fails(c, 'vb_close_file', { file: 'nope' }, /No open file/);
  await c.close();

  // --- path policy
  c = await connect(['--allow', outDir]);
  await fails(c, 'vb_open_file', { path: SAMPLE }, /outside the directories/);
  await c.close();
  step('--allow restricts readable paths');

  // --- export file names come from the analysed binary: they must never leave the output folder
  for (const evil of ['../../evil.bas', '..\\..\\evil.bas', 'C:\\evil.frm', '/etc/passwd', 'a/../../b', '..', 'resources/x/../../../z.ico', '']) {
    const dest = path.resolve(outDir, safeRelPath(evil));
    assert.ok(dest.startsWith(outDir + path.sep), `${JSON.stringify(evil)} escapes the output folder as ${dest}`);
  }
  assert.equal(safeRelPath('CON.frm'), '_CON.frm');
  step('hostile export file names stay inside the output folder');

  // --- Streamable HTTP
  const port = 39000 + Math.floor(Math.random() * 900);
  const http = spawn(process.execPath, [SERVER, '--no-persist', '--http', String(port)], { env: { ...getDefaultEnvironment(), VBLENS_MCP_TOKEN: 'smoke-token' }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP server did not start')), 15_000);
      http.stderr.on('data', (d: Buffer) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
      http.on('exit', code => { clearTimeout(timer); reject(new Error(`HTTP server exited with ${code}`)); });
    });
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const anon = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(anon.status, 401, 'requests without the token must be rejected');
    const hc = new Client({ name: 'smoke-http', version: '1.0.0' });
    await hc.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer smoke-token' } } }));
    assert.equal((await hc.listTools()).tools.length, tools.length);
    await ok(hc, 'vb_open_file', { path: SAMPLE });
    assert.match(await ok(hc, 'vb_list_objects'), /objects/, 'state must persist between HTTP requests');
    await hc.close();
    step('Streamable HTTP with bearer token');
  } finally {
    http.kill();
  }

  console.error(`\nSmoke test passed: ${calls} tool calls, longest reply ${maxLen} characters.`);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
}
