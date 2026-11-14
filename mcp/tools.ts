// Tool definitions. Every tool works on a file opened with vb_open_file and
// returns compact text by default (or JSON with response_format="json").

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { unzipSync } from 'fflate';
import * as z from 'zod/v4';
import type { CodeDoc, DisasmRow, FormControlView } from '../src/core/session';
import type { Func } from '../src/core/analysis/analysis';
import { vbIdentifierError } from '../src/core/vbident';
import {
  CHARACTER_LIMIT, Loaded, ToolError, ToolReply, applyComment, applyRename, checkWritableDir, closeFile, currentFileId, events,
  getLoaded, hex8, listLoaded, loadTypeLibFile, oneLine, openFile, pageData, pageFooter, paginate, parseAddress, reply,
  requireAddress, resolveObject, resolveProc, viewedFiles,
} from './state';
import { registerAppTools, type AppLink } from './apptools';

/** Tells a connected app what the agent is looking at (it may follow along). */
function activity(l: Loaded, tool: string, e: { va?: number; obj?: number; control?: string; view?: string; label: string }): void {
  events.emit('activity', { file: l.id, tool, by: 'agent', ...e });
}

const FileArg = z.string().max(300).optional()
  .describe('Id of an open file (from vb_open_file or vb_list_files). Omit to use the most recently opened file.');
const FormatArg = z.enum(['text', 'json']).default('text')
  .describe("'text' for a compact readable listing, 'json' for structured data");
const ProcArg = z.string().min(1).max(300)
  .describe('Procedure as "Object.Name" (e.g. "frmMain.Form_Load"), a bare name when unambiguous, or any address inside it (e.g. "0x00401A30")');
const AddrArg = z.string().min(1).max(20).describe('Virtual address in hex, e.g. "0x00401000"');
const offsetArg = (what: string) => z.number().int().min(0).default(0).describe(`Number of ${what} to skip, for pagination`);
const limitArg = (def: number, max: number, what: string) => z.number().int().min(1).max(max).default(def).describe(`Maximum number of ${what} to return`);

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Runs a handler; failures come back as tool errors the model can act on. */
function guard<A>(what: string, fn: (args: A) => ToolReply): (args: A) => Promise<ToolReply> {
  return async (args: A) => {
    try {
      return fn(args);
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `Internal error while ${what}: ${(e as Error).message ?? String(e)}. The file may be damaged or use something the decompiler does not handle; other tools and procedures still work.`;
      if (!(e instanceof ToolError)) console.error(`[vblens-mcp] ${what}:`, e);
      return { isError: true, content: [{ type: 'text', text: msg }] };
    }
  };
}

// ---- rendering -------------------------------------------------------------------------

function codeLines(doc: CodeDoc, addresses: boolean): string[] {
  const pad = ' '.repeat(12);
  const out: string[] = [];
  const push = (text: string, va?: number) => out.push(addresses ? (va !== undefined ? hex8(va) + '  ' : pad) + text : text);
  if (doc.header) push(doc.header, doc.va);
  for (const l of doc.lines) push(l.kind === 'label' ? l.text : '    '.repeat(Math.max(0, l.indent)) + l.text, l.va);
  if (doc.footer) push(doc.footer);
  return out;
}

function asmLine(r: DisasmRow, bytes: boolean): string {
  const ins = r.toks.map(t => t.t).join('');
  return `${hex8(r.va)}  ${bytes ? r.bytes.padEnd(30) + ' ' : ''}${ins}${r.comment ? `  ; ${oneLine(r.comment, 100)}` : ''}`;
}

function asmLines(rows: DisasmRow[], bytes: boolean): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.label) out.push(`${r.label}:`);
    else if (r.blockStart) out.push('');
    out.push(asmLine(r, bytes));
  }
  return out;
}

/** A window of text lines that fits the character limit; says how to get the rest. */
function linesReply(title: string, lines: string[], offset: number, limit: number, notes: string[] = []): ToolReply {
  if (offset >= lines.length && lines.length) throw new ToolError(`offset ${offset} is past the end (${lines.length} lines).`);
  let n = Math.min(limit, lines.length - offset);
  for (;;) {
    const body = lines.slice(offset, offset + n);
    const next = offset + body.length;
    const foot = next < lines.length
      ? `Lines ${offset + 1}-${next} of ${lines.length}. More: call again with offset=${next}.`
      : offset > 0 ? `Lines ${offset + 1}-${next} of ${lines.length} (end).` : '';
    const text = [title, ...notes, '', ...body, ...(foot ? ['', foot] : [])].join('\n');
    if (text.length <= CHARACTER_LIMIT || n <= 1) return { content: [{ type: 'text', text }] };
    n = Math.ceil(n / 2);
  }
}

function procLabel(l: Loaded, f: Func): string {
  return `${f.fullName} (${hex8(f.va)})`;
}

function overview(l: Loaded): { text: string; data: Record<string, unknown> } {
  const ov = l.session.overview();
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  const data = {
    file_id: l.id, path: l.path, size: l.size, sha256: l.sha256,
    project_name: ov.projectName, exe_name: ov.exeName, description: ov.description,
    compiled_as: ov.compile, vb_version: ov.vbVersion, runtime_build: ov.runtimeBuild, lcid: ov.lcid,
    pe_timestamp: ov.timestamp ? new Date(ov.timestamp * 1000).toISOString() : null,
    image_base: hex8(ov.imageBase), entry_point: hex8(ov.entryPoint), sub_main: ov.subMain ? hex8(ov.subMain) : null,
    objects: ov.objects, procedures: ov.functions, procedure_kinds: ov.funcKinds, controls: ov.controls,
    strings: ov.strings, api_declares: ov.declares, code_bytes: ov.totalCode,
    sections: ov.sections.map(s => ({ name: s.name, address: hex8(s.va), virtual_size: s.vsize, raw_size: s.rawSize, executable: s.exec })),
    activex_references: ov.components.map(c => ({ name: c.name, file: c.file, prog_id: c.progId, guid: c.guid })),
    api_libraries: ov.apiLibs.map(([lib, n]) => ({ lib, declares: n })),
    top_runtime_functions: ov.topRuntime.map(([name, uses]) => ({ name, uses })),
    largest_procedures: ov.largest.map(p => ({ name: p.name, address: hex8(p.va), size: p.size })),
    warnings: ov.warnings,
    saved_renames: l.renames.size, saved_comments: l.comments.size, type_libraries: l.typeLibs,
  };
  const lines = [
    `# ${path.basename(l.path)}  (file id: ${l.id})`,
    `Path: ${l.path}`,
    `Size: ${l.size} bytes   SHA-256: ${l.sha256}`,
    `Project: ${oneLine(ov.projectName || '(unnamed)')}${ov.description ? ` — ${oneLine(ov.description)}` : ''}${ov.exeName ? `   Exe name: ${oneLine(ov.exeName)}` : ''}`,
    `Compiled as: ${ov.compile} (VB${ov.vbVersion}, runtime build ${ov.runtimeBuild}, LCID ${ov.lcid})`,
    `PE timestamp: ${data.pe_timestamp ?? 'none'}`,
    `Image base ${data.image_base}, entry point ${data.entry_point}${data.sub_main ? `, Sub Main at ${data.sub_main}` : ', starts from a form (no Sub Main)'}`,
    `Objects: ${kv(ov.objects)}`,
    `Procedures: ${ov.functions} (${kv(ov.funcKinds)}), ${ov.totalCode} code bytes`,
    `Controls: ${ov.controls}   Strings: ${ov.strings}   API declares: ${ov.declares}`,
    `Sections: ${ov.sections.map(s => `${s.name} ${hex8(s.va)} +${s.vsize.toString(16)}h${s.exec ? ' x' : ''}`).join(', ')}`,
  ];
  if (ov.components.length) lines.push(`ActiveX references (${ov.components.length}): ${ov.components.slice(0, 24).map(c => oneLine(`${c.name} (${c.file})`, 60)).join(', ')}${ov.components.length > 24 ? `, … (response_format="json" lists all)` : ''}`);
  if (ov.apiLibs.length) lines.push(`API libraries declared: ${ov.apiLibs.map(([lib, n]) => `${oneLine(lib, 40)} (${n})`).join(', ')}`);
  if (ov.topRuntime.length) lines.push(`Most used runtime functions: ${ov.topRuntime.slice(0, 10).map(([n, c]) => `${n} ×${c}`).join(', ')}`);
  if (ov.largest.length) lines.push(`Largest procedures: ${ov.largest.slice(0, 6).map(p => `${p.name} (${hex8(p.va)}, ${p.size} bytes)`).join(', ')}`);
  if (l.renames.size || l.comments.size) lines.push(`Saved annotations applied: ${l.renames.size} renames, ${l.comments.size} comments`);
  if (l.typeLibs.length) lines.push(`Type libraries loaded: ${l.typeLibs.join(', ')}`);
  if (ov.warnings.length) lines.push(`Warnings: ${ov.warnings.slice(0, 8).map(w => oneLine(w, 120)).join(' | ')}`);
  return { text: lines.join('\n'), data };
}

/** Names in a zip come from the analysed binary: keep them inside the output folder and legal on Windows. */
export function safeRelPath(name: string): string {
  const parts = name.split(/[\\/]+/).map(seg => {
    let s = seg.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_').replace(/[. ]+$/, '');
    if (!s) s = '_';
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
    return s.slice(0, 120);
  });
  return parts.join(path.sep);
}

// ---- registration ----------------------------------------------------------------------

export function registerTools(server: McpServer, app?: AppLink): void {
  registerAppTools(server, app, guard);
  // ---------- files ----------
  server.registerTool('vb_open_file', {
    title: 'Open a VB5/VB6 binary',
    description: `Load and analyse a Visual Basic 5/6 executable (.exe, .dll, .ocx; native code or P-Code) from a path on the machine this server runs on. The file is only read and parsed, never executed.

Returns a file id and an overview (project name, compile type, object and procedure counts, sections, declared API libraries). Every other vb_* tool then works on this file. Analysis takes a few seconds for multi-megabyte binaries. Opening the same unchanged path again is instant and re-selects it.

Typical next steps: vb_list_objects, vb_list_api_declares, vb_list_strings, then vb_decompile on interesting procedures.`,
    inputSchema: z.strictObject({
      path: z.string().min(1).max(2000).describe('Absolute path of the file, e.g. "C:\\\\samples\\\\app.exe" or "/home/user/app.exe"'),
      type_libraries: z.array(z.string().min(1).max(2000)).max(16).optional()
        .describe('Optional paths of ActiveX .ocx/.tlb/.dll files used to name third-party control events, properties and methods. The controls shipped with VB5/VB6 (MSCOMCTL, COMCTL32, MSCOMCT2, COMCT332, COMDLG32, MSWINSCK, MSINET, RICHTX32, MSCOMM32, MSFLXGRD, MSHFLXGD, TABCTL32, MCI32, MSMAPI32, MSMASK32, SYSINFO, PICCLP32, MSCHRT20, data controls) are built in'),
      reload: z.boolean().default(false).describe('Analyse again even if this path is already open'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('opening the file', ({ path: p, type_libraries, reload, response_format }) => {
    const { loaded, reused } = openFile(p, { reload, typeLibs: type_libraries });
    activity(loaded, 'open', { label: `Opened ${loaded.id}` });
    const o = overview(loaded);
    const head = reused ? 'Already open; selected as the current file.' : `Analysed in ${(loaded.analysisMs / 1000).toFixed(1)} s.`;
    return reply(response_format, `${head}\n\n${o.text}`, { reused, analysis_ms: loaded.analysisMs, ...o.data });
  }));

  server.registerTool('vb_list_files', {
    title: 'List open files',
    description: 'List the binaries currently open in this server with their ids, and which one is the default for calls that omit `file`.',
    inputSchema: z.strictObject({ response_format: FormatArg }),
    annotations: READ,
  }, guard('listing files', ({ response_format }) => {
    const all = listLoaded();
    const cur = currentFileId();
    const where = (l: Loaded) => (l.path.startsWith('app:') ? `dropped into the app by the user as ${l.path.slice(4)}` : l.path);
    const data = { current: cur ?? null, files: all.map(l => ({ file_id: l.id, path: l.path.startsWith('app:') ? null : l.path, opened_by: l.origin === 'app' ? 'user (app)' : 'agent', shown_in_app: viewedFiles.has(l.id), size: l.size, sha256: l.sha256, compiled_as: l.session.project.isPCode ? 'P-Code' : 'Native code', procedures: l.session.an.funcs.length })) };
    const text = all.length
      ? all.map(l => `${l.id === cur ? '* ' : '  '}${l.id}  ${where(l)}  (${l.session.project.isPCode ? 'P-Code' : 'native'}, ${l.session.an.funcs.length} procedures)${viewedFiles.has(l.id) ? '  [on the user\'s screen]' : ''}`).join('\n') + '\n\n* = used when `file` is omitted'
      : 'No file is open. Call vb_open_file first, or ask the user to drop one into the app.';
    return reply(response_format, text, data);
  }));

  server.registerTool('vb_close_file', {
    title: 'Close a file',
    description: 'Unload an open binary and free its memory. Saved renames and comments are kept and re-applied the next time the same file is opened.',
    inputSchema: z.strictObject({ file: z.string().min(1).max(300).describe('Id of the file to close (from vb_list_files)') }),
    annotations: EDIT,
  }, guard('closing the file', ({ file }) => {
    const l = closeFile(file);
    const cur = currentFileId();
    return { content: [{ type: 'text', text: `Closed ${l.id}.${cur ? ` Current file is now ${cur}.` : ' No files are open.'}` }] };
  }));

  server.registerTool('vb_get_overview', {
    title: 'Project overview',
    description: 'Summary of an open file: hashes, project name, native/P-Code, PE timestamp, entry point and Sub Main, counts of forms/modules/classes/procedures/controls, sections, ActiveX references, declared API libraries, most used runtime functions, largest procedures and parser warnings.',
    inputSchema: z.strictObject({ file: FileArg, response_format: FormatArg }),
    annotations: READ,
  }, guard('building the overview', ({ file, response_format }) => {
    const o = overview(getLoaded(file));
    return reply(response_format, o.text, o.data);
  }));

  // ---------- structure ----------
  server.registerTool('vb_list_objects', {
    title: 'List forms, modules and classes',
    description: 'List the project objects (forms, MDI forms, modules, classes, user controls, property pages) with their index, kind, number of procedures and number of controls. Use the name with vb_list_procedures, vb_decompile_object and vb_get_form.',
    inputSchema: z.strictObject({
      file: FileArg,
      kind: z.enum(['Form', 'MDIForm', 'Module', 'Class', 'UserControl', 'PropertyPage', 'UserDocument', 'Designer']).optional().describe('Only objects of this kind'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('listing objects', ({ file, kind, response_format }) => {
    const l = getLoaded(file);
    const s = l.session;
    const counts = new Map<number, number>();
    for (const f of s.an.funcs) counts.set(f.obj, (counts.get(f.obj) ?? 0) + 1);
    const rows = s.project.objects.filter(o => !kind || o.kind === kind).map(o => ({
      index: o.index, name: o.name, kind: o.kind as string, procedures: counts.get(o.index) ?? 0,
      controls: Math.max(0, (s.forms.get(o.index)?.controls.length ?? 1) - 1), has_form: s.forms.has(o.index),
    }));
    const loose = counts.get(-1) ?? 0;
    const text = [
      `${rows.length} objects${kind ? ` of kind ${kind}` : ''}:`,
      ...rows.map(r => `${String(r.index).padStart(3)}  ${r.kind.padEnd(12)} ${oneLine(r.name, 60)}  — ${r.procedures} procedures${r.has_form ? `, ${r.controls} controls` : ''}`),
      ...(loose && !kind ? [`     (plus ${loose} procedures not attributed to any object: vb_list_procedures with unattributed=true)`] : []),
    ].join('\n');
    return reply(response_format, text, { count: rows.length, unattributed_procedures: loose, objects: rows });
  }));

  server.registerTool('vb_list_procedures', {
    title: 'List procedures',
    description: 'List procedures (event handlers, methods, module procedures) with address, size and kind. Filter by object, by a name substring, or by kind; sort by address, name or size. Names such as Proc_12_401A30 are generated because VB does not store names of private module procedures.',
    inputSchema: z.strictObject({
      file: FileArg,
      object: z.string().max(300).optional().describe('Only procedures of this form/module/class (name or index from vb_list_objects)'),
      unattributed: z.boolean().default(false).describe('Only procedures that could not be attributed to an object'),
      name_contains: z.string().max(200).optional().describe('Case-insensitive substring of the procedure name, e.g. "_Click" or "Form_Load"'),
      kind: z.enum(['event', 'method', 'proc', 'main', 'unknown']).optional().describe("'event' = control/form event handlers, 'method' = class/form methods, 'proc' = module procedures, 'main' = Sub Main"),
      sort: z.enum(['address', 'name', 'size']).default('address').describe("Order of results; 'size' is largest first"),
      limit: limitArg(100, 500, 'procedures'),
      offset: offsetArg('procedures'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('listing procedures', ({ file, object, unattributed, name_contains, kind, sort, limit, offset, response_format }) => {
    const l = getLoaded(file);
    const s = l.session;
    const obj = object !== undefined && object !== '' ? resolveObject(l, object) : undefined;
    const q = name_contains?.toLowerCase();
    let fs = s.an.funcs.filter(f => (!obj || f.obj === obj.index) && (!unattributed || f.obj < 0) && (!kind || f.kind === kind) && (!q || f.fullName.toLowerCase().includes(q)));
    fs = [...fs].sort(sort === 'name' ? (a, b) => a.fullName.localeCompare(b.fullName) : sort === 'size' ? (a, b) => (b.end - b.va) - (a.end - a.va) : (a, b) => a.va - b.va);
    return paginate(fs, offset, limit, response_format, p => {
      const items = p.items.map(f => ({ address: hex8(f.va), name: f.fullName, kind: f.kind as string, size: f.end - f.va, args: f.argBytes / 4, pcode: s.pcode.has(f.va), ...(f.attributionGuess ? { attribution_guessed: true } : {}) }));
      const text = p.total
        ? [...items.map(i => `${i.address}  ${i.kind.padEnd(7)} ${String(i.size).padStart(6)}  ${i.name}${i.attribution_guessed ? '  (~module guessed)' : ''}`), '', pageFooter(p, 'Procedures')].join('\n')
        : 'No procedures match. Relax the filters, or use vb_search to look across names, controls and strings.';
      return { text, data: pageData(p, 'procedures', items) };
    });
  }));

  // ---------- code ----------
  server.registerTool('vb_decompile', {
    title: 'Decompile a procedure',
    description: `Decompile one procedure to Visual Basic source. Works for native code and P-Code.

The output is a reconstruction: locals are named var_XX, unnamed procedures Proc_N_ADDR, and unknown ActiveX members Method_XX/DispID_XX (vb_load_type_library can name those). Set addresses=true to prefix each statement with its code address, which is what vb_set_comment and vb_disassemble take. Long procedures are paginated by line.`,
    inputSchema: z.strictObject({
      file: FileArg,
      procedure: ProcArg,
      addresses: z.boolean().default(false).describe('Prefix each line with the address of the code it came from'),
      limit: limitArg(400, 2000, 'lines'),
      offset: offsetArg('lines'),
    }),
    annotations: READ,
  }, guard('decompiling', ({ file, procedure, addresses, limit, offset }) => {
    const l = getLoaded(file);
    const f = resolveProc(l, procedure);
    const doc = l.session.decompile(f.va);
    if (offset === 0) activity(l, 'decompile', { va: f.va, view: 'code', label: `Reading ${f.fullName}` });
    const notes = doc.errors.length ? [`' Decompiler notes: ${doc.errors.slice(0, 5).map(e => oneLine(e, 140)).join(' | ')}`] : [];
    return linesReply(`' ${procLabel(l, f)} — ${f.end - f.va} bytes, ${l.session.pcode.has(f.va) ? 'P-Code' : 'native'}`, codeLines(doc, addresses), offset, limit, notes);
  }));

  server.registerTool('vb_decompile_object', {
    title: 'Decompile a whole form, module or class',
    description: 'Decompile every procedure of one object into a single source listing (what its .frm/.bas/.cls code section would look like). Use it to read a small module end to end; for large objects prefer vb_list_procedures plus vb_decompile, or vb_search_code. Paginated by line. The first call on a big object can take several seconds.',
    inputSchema: z.strictObject({
      file: FileArg,
      object: z.string().min(1).max(300).describe('Object name or index from vb_list_objects'),
      addresses: z.boolean().default(false).describe('Prefix each line with the address of the code it came from'),
      limit: limitArg(400, 2000, 'lines'),
      offset: offsetArg('lines'),
    }),
    annotations: READ,
  }, guard('decompiling the object', ({ file, object, addresses, limit, offset }) => {
    const l = getLoaded(file);
    const o = resolveObject(l, object);
    const doc = l.session.objectSource(o.index);
    if (offset === 0) activity(l, 'decompile_object', { obj: o.index, view: 'code', label: `Reading ${o.name}` });
    return linesReply(`' ${o.kind} ${o.name}`, codeLines(doc, addresses), offset, limit);
  }));

  server.registerTool('vb_disassemble', {
    title: 'Disassemble a procedure',
    description: 'Disassembly listing of a procedure: x86 for native code, P-Code opcodes for P-Code binaries, with symbol names and referenced string literals as comments. If the address is not inside a known procedure, up to 200 instructions are decoded linearly from it as x86. Use vb_decompile first; drop to this when the decompiled code looks wrong or incomplete.',
    inputSchema: z.strictObject({
      file: FileArg,
      target: z.string().min(1).max(300).describe('Procedure name, or an address (a procedure is listed from its start; other mapped addresses are decoded linearly)'),
      bytes: z.boolean().default(false).describe('Include the raw instruction bytes'),
      limit: limitArg(250, 2000, 'lines'),
      offset: offsetArg('lines'),
    }),
    annotations: READ,
  }, guard('disassembling', ({ file, target, bytes, limit, offset }) => {
    const l = getLoaded(file);
    let va: number;
    let title: string;
    try {
      const f = resolveProc(l, target);
      va = f.va;
      title = `; ${procLabel(l, f)} — ${l.session.pcode.has(f.va) ? 'P-Code' : 'x86'}`;
    } catch (e) {
      const a = parseAddress(target);
      if (a === undefined) throw e;
      va = requireAddress(l, target);
      title = `; raw x86 from ${hex8(va)} (not inside a known procedure${l.session.project.isPCode ? '; this is a P-Code binary, so this may be data' : ''})`;
    }
    const d = l.session.disasm(va);
    if (!d.rows.length) throw new ToolError(`Nothing could be decoded at ${hex8(va)}.`);
    if (offset === 0) activity(l, 'disassemble', { va, view: 'asm', label: `Disassembling ${title.replace(/^; /, '').replace(/ —.*$/, '')}` });
    return linesReply(title, asmLines(d.rows, bytes), offset, limit);
  }));

  server.registerTool('vb_get_cfg', {
    title: 'Control-flow graph of a procedure',
    description: 'Basic blocks and edges of a procedure (edge kinds: true/false for conditional branches, jump, fall). Set instructions=true to include each block\'s instructions. Useful for understanding loops and branching when the decompiled code contains GoTo. Large graphs are paginated by block.',
    inputSchema: z.strictObject({
      file: FileArg,
      procedure: ProcArg,
      instructions: z.boolean().default(false).describe('Include the instructions of every block'),
      limit: limitArg(150, 1000, 'blocks'),
      offset: offsetArg('blocks'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('building the control-flow graph', ({ file, procedure, instructions, limit, offset, response_format }) => {
    const l = getLoaded(file);
    const f = resolveProc(l, procedure);
    const g = l.session.graph(f.va);
    if (offset === 0) activity(l, 'cfg', { va: f.va, view: 'graph', label: `Graph of ${f.fullName}` });
    const out = new Map<number, { to: number; kind: string }[]>();
    for (const e of g.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push({ to: e.to, kind: e.kind });
    type Block = { address: string; instructions: number; successors: { to: string; kind: string }[]; last?: string; code?: string[] };
    const blocks: Block[] = g.nodes.map(n => ({
      address: hex8(n.id), instructions: n.rows.length,
      successors: (out.get(n.id) ?? []).map(e => ({ to: hex8(e.to), kind: e.kind })),
      ...(instructions ? { code: n.rows.map(r => asmLine(r, false)) } : { last: n.rows.length ? n.rows[n.rows.length - 1].toks.map(t => t.t).join('') : '' }),
    }));
    return paginate(blocks, offset, limit, response_format, p => {
      const text = [
        `${procLabel(l, f)}: ${blocks.length} blocks, ${g.edges.length} edges, entry ${hex8(g.entry)}`,
        ...p.items.flatMap(b => [
          `${b.address}  ${b.instructions} insns${b.last ? `, ends: ${b.last}` : ''}  -> ${b.successors.map(e => `${e.to} (${e.kind})`).join(', ') || 'exit'}`,
          ...(b.code ? [...b.code.map(c => '    ' + c), ''] : []),
        ]),
        ...(p.has_more || p.offset ? ['', pageFooter(p, 'Blocks')] : []),
      ].join('\n');
      return { text, data: { procedure: f.fullName, entry: hex8(g.entry), block_count: blocks.length, edge_count: g.edges.length, ...pageData(p, 'blocks', p.items) } };
    });
  }));

  server.registerTool('vb_get_procedure_info', {
    title: 'Procedure details',
    description: 'Facts about one procedure without its code: address range, kind, owning object, argument count, the control and event it handles, its callers, the procedures / runtime functions / APIs it calls, and the string literals it references. A fast way to triage what a procedure does before decompiling it.',
    inputSchema: z.strictObject({ file: FileArg, procedure: ProcArg, response_format: FormatArg }),
    annotations: READ,
  }, guard('reading procedure details', ({ file, procedure, response_format }) => {
    const l = getLoaded(file);
    const f = resolveProc(l, procedure);
    const i = l.session.funcInfo(f.va)!;
    const callerNames = [...new Set(i.callers.map(c => c.name))];
    const data = {
      name: i.fullName, address: hex8(i.va), end: hex8(i.end), size: i.size, kind: i.kind as string, code: i.pcode ? 'P-Code' : 'native',
      object: i.objName ?? null, object_kind: i.objKind ?? null, args: i.args, control: i.control ?? null, event: i.event ?? null,
      attribution_guessed: i.guess, aliases: i.aliases,
      callers: i.callers.slice(0, 200).map(c => ({ from: hex8(c.from), procedure: c.name, kind: c.kind as string })),
      callees: i.callees.slice(0, 300).map(c => ({ address: hex8(c.va), name: c.name })),
      strings: i.strings.slice(0, 200).map(s => ({ address: hex8(s.va), text: s.text.slice(0, 400) })),
    };
    const text = [
      `${data.name}  ${data.address}-${data.end} (${data.size} bytes, ${data.code})`,
      `Kind: ${data.kind}${data.object ? `, in ${data.object_kind} ${data.object}` : ', not attributed to an object'}${i.guess ? ' (module guessed from layout)' : ''}; ${data.args} argument slot(s)`,
      ...(i.control ? [`Handles: ${i.control}${i.event ? '.' + i.event : ''}`] : []),
      `Callers (${i.callers.length}): ${callerNames.slice(0, 30).join(', ') || 'none found by direct reference (try vb_get_xrefs with deep=true)'}${callerNames.length > 30 ? ', …' : ''}`,
      `Calls (${i.callees.length}): ${i.callees.slice(0, 80).map(c => c.name).join(', ') || 'none'}${i.callees.length > 80 ? ', …' : ''}`,
      `Strings (${i.strings.length}):`,
      ...i.strings.slice(0, 60).map(s => `  ${hex8(s.va)}  ${JSON.stringify(oneLine(s.text, 140))}`),
      ...(i.strings.length > 60 ? [`  … ${i.strings.length - 60} more (response_format="json" returns up to 200)`] : []),
    ].join('\n');
    return reply(response_format, text, data);
  }));

  server.registerTool('vb_get_xrefs', {
    title: 'Cross-references',
    description: `Find where something is used. The target can be a procedure (name or start address), a string or global variable address, an imported runtime function name (e.g. "rtcShell", "__vbaStrCmp"), or a declared API name (e.g. "ShellExecuteA").

Returns the referencing addresses and the procedure each one is in. For procedures, deep=true also searches the decompiled code of the whole project, which finds calls made through vtables or late binding that leave no direct reference (slow on first use).`,
    inputSchema: z.strictObject({
      file: FileArg,
      target: z.string().min(1).max(300).describe('Procedure name, API/import name, or an address such as "0x00403F10"'),
      deep: z.boolean().default(false).describe('For procedures: also find callers by searching all decompiled code'),
      limit: limitArg(100, 500, 'references'),
      offset: offsetArg('references'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('finding cross-references', ({ file, target, deep, limit, offset, response_format }) => {
    const l = getLoaded(file);
    const s = l.session;
    const t = target.trim();
    const tl = t.toLowerCase();
    let what = '';
    let refs: { from: number; kind: string; name: string; text?: string }[] = [];
    const named = s.an.funcs.some(f => f.fullName.toLowerCase() === tl || f.name.toLowerCase() === tl);
    const isAddr = /^0x/i.test(t) || (!named && parseAddress(t) !== undefined);
    const imp = isAddr ? undefined : s.imports().find(i => i.name.toLowerCase() === tl);
    const dec = isAddr ? undefined : s.declares().find(d => d.func.toLowerCase() === tl);
    let proc: Func | undefined;
    if (!isAddr && !imp && !dec) {
      try { proc = resolveProc(l, t); } catch (e) {
        throw new ToolError(`${(e as Error).message} For runtime or API functions pass the exact name from vb_list_imports / vb_list_api_declares.`);
      }
    }
    if (imp) { what = `import ${imp.dll}!${imp.name}`; refs = s.xrefsToMany(imp.refs.length ? imp.refs : [imp.iat]).map(x => ({ ...x, kind: x.kind === 'data' ? 'use' : x.kind })); }
    else if (dec) {
      what = `API declare ${dec.lib}!${dec.func}`;
      if (!dec.stub) throw new ToolError(`${dec.func} is declared but its call stub was not found, so it has no recorded references. Try vb_search_code with "${dec.func}".`);
      refs = s.xrefsTo(dec.stub);
    } else {
      const va = proc ? proc.va : requireAddress(l, t);
      const r = s.resolve(va);
      if (!proc && r.kind === 'func') proc = s.an.funcByVA.get(va);
      what = proc ? `procedure ${procLabel(l, proc)}` : `${r.kind}${r.name ? ` ${JSON.stringify(oneLine(r.name, 60))}` : ''} at ${hex8(va)}`;
      refs = s.xrefsTo(va);
      if (proc && deep) {
        const seen = new Set(refs.map(x => x.name));
        for (const d of s.deepCallers(proc.va)) if (!seen.has(d.name)) refs.push(d);
      }
    }
    return paginate(refs, offset, limit, response_format, p => {
      const items = p.items.map(x => ({ from: hex8(x.from), kind: x.kind, procedure: x.name, ...(x.text ? { line: oneLine(x.text, 160) } : {}) }));
      const hint = proc && !deep ? ' Calls through vtables or late binding are only found with deep=true.' : '';
      const text = p.total
        ? [`References to ${what}:`, ...items.map(i => `${i.from}  ${i.kind.padEnd(4)}  ${i.procedure}${i.line ? `   ${i.line}` : ''}`), '', pageFooter(p, 'References') + hint].join('\n')
        : `No references to ${what} were found.${hint}`;
      return { text, data: { target: what, ...pageData(p, 'references', items) } };
    });
  }));

  // ---------- data ----------
  server.registerTool('vb_list_strings', {
    title: 'List string literals',
    description: 'String literals referenced by the code (file paths, URLs, registry keys, SQL, messages), with address and reference count. Filter with a substring or a regular expression. Follow up with vb_get_xrefs on a string\'s address to see which procedures use it.',
    inputSchema: z.strictObject({
      file: FileArg,
      contains: z.string().max(200).optional().describe('Case-insensitive substring, e.g. "http" or ".exe"'),
      regex: z.string().max(300).optional().describe('JavaScript regular expression (case-insensitive), e.g. "^[A-Z]:\\\\\\\\|HKEY_"'),
      min_length: z.number().int().min(0).max(1000).default(1).describe('Skip strings shorter than this'),
      limit: limitArg(100, 1000, 'strings'),
      offset: offsetArg('strings'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('listing strings', ({ file, contains, regex, min_length, limit, offset, response_format }) => {
    const l = getLoaded(file);
    let re: RegExp | undefined;
    if (regex) { try { re = new RegExp(regex, 'i'); } catch (e) { throw new ToolError(`Invalid regular expression: ${(e as Error).message}`); } }
    const q = contains?.toLowerCase();
    const all = l.session.strings().filter(s => s.text.length >= min_length && (!q || s.text.toLowerCase().includes(q)) && (!re || re.test(s.text)));
    return paginate(all, offset, limit, response_format, p => {
      const items = p.items.map(s => ({ address: hex8(s.va), refs: s.refs, text: s.text.length > 1000 ? s.text.slice(0, 1000) + '…' : s.text }));
      const text = p.total
        ? [...items.map(i => `${i.address}  ×${String(i.refs).padEnd(3)} ${JSON.stringify(oneLine(i.text, 200))}`), '', pageFooter(p, 'Strings')].join('\n')
        : 'No strings match. Only literals referenced by code are indexed; vb_read_bytes can inspect raw data.';
      return { text, data: pageData(p, 'strings', items) };
    });
  }));

  server.registerTool('vb_list_imports', {
    title: 'List PE imports',
    description: 'Functions imported through the PE import table (for VB this is mostly the MSVBVM runtime: rtc* are VB statements/functions such as rtcShell, rtcCreateObject2, rtcFileCopy; __vba* are compiler helpers), with how often the code uses each. Windows APIs called through Declare statements are NOT here: use vb_list_api_declares.',
    inputSchema: z.strictObject({
      file: FileArg,
      contains: z.string().max(200).optional().describe('Case-insensitive substring of the function or DLL name, e.g. "rtc" or "Shell"'),
      used_only: z.boolean().default(false).describe('Only imports the code actually references'),
      limit: limitArg(200, 1000, 'imports'),
      offset: offsetArg('imports'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('listing imports', ({ file, contains, used_only, limit, offset, response_format }) => {
    const l = getLoaded(file);
    const q = contains?.toLowerCase();
    const all = l.session.imports().filter(i => (!used_only || i.uses > 0) && (!q || i.name.toLowerCase().includes(q) || i.dll.toLowerCase().includes(q)))
      .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
    return paginate(all, offset, limit, response_format, p => {
      const items = p.items.map(i => ({ dll: i.dll, name: i.name || `#${i.ordinal}`, uses: i.uses, iat: hex8(i.iat) }));
      const text = p.total
        ? [...items.map(i => `${i.iat}  ×${String(i.uses).padEnd(5)} ${i.dll}!${i.name}`), '', pageFooter(p, 'Imports') + ' Pass a name to vb_get_xrefs to see its callers.'].join('\n')
        : 'No imports match.';
      return { text, data: pageData(p, 'imports', items) };
    });
  }));

  server.registerTool('vb_list_api_declares', {
    title: 'List declared Windows APIs',
    description: 'Windows API functions the program declares with `Declare Function ... Lib` (kernel32, user32, advapi32, wininet, …), with use counts and the procedures that call each. This is the quickest view of what the program can do at the OS level. Parameter lists are not stored in VB binaries, so only library and function names are known.',
    inputSchema: z.strictObject({
      file: FileArg,
      contains: z.string().max(200).optional().describe('Case-insensitive substring of the function or library name, e.g. "Reg", "wininet"'),
      limit: limitArg(200, 1000, 'declares'),
      offset: offsetArg('declares'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('listing API declares', ({ file, contains, limit, offset, response_format }) => {
    const l = getLoaded(file);
    const s = l.session;
    const q = contains?.toLowerCase();
    const all = s.declares().filter(d => !q || d.func.toLowerCase().includes(q) || (d.lib ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.lib ?? '').localeCompare(b.lib ?? '') || a.func.localeCompare(b.func));
    return paginate(all, offset, limit, response_format, p => {
      const items = p.items.map(d => {
        const callers = d.stub ? [...new Set(s.xrefsTo(d.stub).map(x => x.name))] : [];
        return { lib: d.lib ?? '', name: d.func, uses: d.uses, stub: d.stub ? hex8(d.stub) : null, callers: callers.slice(0, 8), caller_count: callers.length };
      });
      const text = p.total
        ? [...items.map(i => `${oneLine(i.lib, 30)}!${oneLine(i.name, 60)}  ×${i.uses}${i.callers.length ? `  <- ${i.callers.slice(0, 4).join(', ')}${i.caller_count > 4 ? `, +${i.caller_count - 4} more` : ''}` : ''}`), '', pageFooter(p, 'Declares') + ' Pass a function name to vb_get_xrefs for every call site.'].join('\n')
        : 'No API declares match (the program may only use VB runtime functions: see vb_list_imports).';
      return { text, data: pageData(p, 'declares', items) };
    });
  }));

  server.registerTool('vb_get_form', {
    title: 'Form layout and controls',
    description: `Inspect a form (or user control) recovered from the binary.

view="controls": the control tree with class, caption/text, position and the event handlers wired to each control (with addresses for vb_decompile).
view="control": every decoded property of one control (pass its name in \`control\`).
view="frm": the reconstructed .frm definition text, paginated by line.`,
    inputSchema: z.strictObject({
      file: FileArg,
      object: z.string().min(1).max(300).describe('Form name or index from vb_list_objects'),
      view: z.enum(['controls', 'control', 'frm']).default('controls').describe('What to return'),
      control: z.string().max(300).optional().describe('Control name for view="control", e.g. "Command1" or "Text1(2)" for a control-array element'),
      limit: limitArg(400, 2000, 'lines'),
      offset: offsetArg('lines'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('reading the form', ({ file, object, view, control, limit, offset, response_format }) => {
    const l = getLoaded(file);
    const o = resolveObject(l, object);
    const fv = l.session.form(o.index);
    if (!fv || !fv.root) {
      const forms = l.session.project.objects.filter(x => l.session.forms.has(x.index)).map(x => x.name);
      throw new ToolError(`${o.name} is a ${o.kind} with no form layout.${forms.length ? ` Objects with forms: ${forms.slice(0, 30).join(', ')}${forms.length > 30 ? ', …' : ''}.` : ' This file has no forms.'}`);
    }
    activity(l, 'form', { obj: o.index, view: view === 'frm' ? 'frm' : 'designer', control: view === 'control' ? control : undefined, label: `Form ${o.name}${view === 'control' && control ? '.' + control : ''}` });
    if (view === 'frm') return linesReply(`' ${o.name}.frm (reconstructed)`, fv.frm.split(/\r?\n/), offset, limit);
    const label = (c: FormControlView) => (c.index !== undefined ? `${c.name}(${c.index})` : c.name);
    const conv = (c: FormControlView): Record<string, unknown> => ({
      name: label(c), class: c.className, ...(c.caption !== undefined ? { caption: c.caption } : {}), ...(c.text !== undefined ? { text: c.text } : {}),
      ...(c.left !== undefined ? { left: c.left, top: c.top, width: c.width, height: c.height } : {}),
      ...(c.visible === false ? { visible: false } : {}), ...(c.enabled === false ? { enabled: false } : {}),
      ...(c.pictures.length ? { pictures: c.pictures.map(p => `${p.prop} (${p.mime}, ${p.bytes.length} bytes)`) } : {}),
      events: c.events.map(e => ({ event: e.name, handler: hex8(e.va) })),
    });
    if (view === 'control') {
      if (!control) throw new ToolError('view="control" needs the `control` argument (a name from view="controls").');
      const want = control.trim().toLowerCase();
      const hits: FormControlView[] = [];
      const walk = (c: FormControlView) => { if (label(c).toLowerCase() === want || c.name.toLowerCase() === want) hits.push(c); c.children.forEach(walk); };
      walk(fv.root);
      if (!hits.length) throw new ToolError(`No control named "${control}" on ${o.name}. Call vb_get_form with view="controls" for the names.`);
      const data = { form: o.name, controls: hits.map(c => ({ ...conv(c), properties: c.props.map(p => ({ name: p.name, value: p.value.length > 2000 ? p.value.slice(0, 2000) + '…' : p.value })), children: c.children.map(label) })) };
      const text = hits.map(c => [
        `${label(c)} : ${c.className}`,
        ...c.props.map(p => `  ${p.name} = ${oneLine(p.value, 300)}`),
        ...(c.events.length ? ['  Event handlers:', ...c.events.map(e => `    ${e.name} -> ${hex8(e.va)}`)] : []),
        ...(c.children.length ? [`  Contains: ${c.children.map(label).join(', ')}`] : []),
      ].join('\n')).join('\n\n');
      return reply(response_format, text, data);
    }
    const lines: string[] = [];
    const flat: Record<string, unknown>[] = [];
    const walk = (c: FormControlView, depth: number, parent: string | null) => {
      const cap = c.caption ?? c.text;
      const pos = c.left !== undefined && c.top !== undefined ? ` @${c.left},${c.top}${c.width !== undefined && c.height !== undefined ? ` ${c.width}x${c.height}` : ''}` : '';
      const ev = c.events.length ? `  [${c.events.map(e => `${e.name}=${hex8(e.va)}`).join(', ')}]` : '';
      lines.push(`${'  '.repeat(depth)}${label(c)} : ${c.className.replace(/^VB\./, '')}${cap ? ` ${JSON.stringify(oneLine(cap, 60))}` : ''}${pos}${c.visible === false ? ' hidden' : ''}${c.enabled === false ? ' disabled' : ''}${ev}`);
      flat.push({ ...conv(c), parent, depth });
      for (const ch of c.children) walk(ch, depth + 1, label(c));
    };
    walk(fv.root, 0, null);
    if (response_format === 'json') {
      return paginate(flat, offset, limit, 'json', p => ({ text: '', data: { form: o.name, codepage: fv.codepage, errors: fv.errors, ...pageData(p, 'controls', p.items) } }));
    }
    const notes = ['(positions are in twips; events show the handler address)', ...(fv.errors.length ? [`Parser notes: ${fv.errors.slice(0, 4).map(e => oneLine(e, 120)).join(' | ')}`] : [])];
    return linesReply(`${o.kind} ${o.name}: ${flat.length - 1} controls`, lines, offset, limit, notes);
  }));

  // ---------- search ----------
  server.registerTool('vb_search', {
    title: 'Search names, controls and strings',
    description: 'Fuzzy search across object names, procedure names, control names, string literals, API declares and addresses. Use it to locate something by a remembered or guessed name ("login", "Timer1", "0x00401A30"). To search inside decompiled code use vb_search_code.',
    inputSchema: z.strictObject({
      file: FileArg,
      query: z.string().min(1).max(200).describe('Text to look for, e.g. "password", "cmdOK_Click", or an address'),
      limit: limitArg(40, 200, 'results'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('searching', ({ file, query, limit, response_format }) => {
    const l = getLoaded(file);
    const res = l.session.search(query, limit).map(r => ({
      kind: r.kind, label: oneLine(r.label, 160),
      ...(r.va !== undefined ? { address: hex8(r.va) } : {}),
      ...(r.obj !== undefined ? { object: l.session.project.objects[r.obj]?.name } : {}),
      ...(r.detail && !/^[0-9A-F]{5,8}$/.test(r.detail) ? { detail: oneLine(r.detail, 80) } : {}),
    }));
    const text = res.length
      ? res.map(r => `${r.kind.padEnd(8)} ${r.address ?? ' '.repeat(10)}  ${r.kind === 'string' ? JSON.stringify(r.label) : r.label}${r.detail ? `  (${r.detail})` : ''}`).join('\n')
      : `Nothing matches "${query}". Try a shorter fragment, or vb_search_code to search the decompiled source.`;
    return reply(response_format, text, { count: res.length, results: res });
  }));

  server.registerTool('vb_search_code', {
    title: 'Search decompiled code',
    description: 'Search the decompiled source of every procedure (or of one object) for a substring or regular expression, like grep. Returns matching lines with their address and procedure. Good for finding uses of a function, property, literal or pattern, e.g. "Shell", "CreateObject", "\\.Open\\b", "Kill ". The first search decompiles the whole project (several seconds on large binaries); later searches are fast.',
    inputSchema: z.strictObject({
      file: FileArg,
      query: z.string().min(1).max(300).describe('Text to find, or a JavaScript regular expression when regex=true'),
      regex: z.boolean().default(false).describe('Treat query as a regular expression'),
      case_sensitive: z.boolean().default(false).describe('Match case exactly'),
      object: z.string().max(300).optional().describe('Only search this form/module/class'),
      limit: limitArg(100, 500, 'matching lines'),
      offset: offsetArg('matching lines'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('searching code', ({ file, query, regex, case_sensitive, object, limit, offset, response_format }) => {
    const l = getLoaded(file);
    const s = l.session;
    const obj = object ? resolveObject(l, object) : undefined;
    let test: (line: string) => boolean;
    if (regex) {
      let re: RegExp;
      try { re = new RegExp(query, case_sensitive ? '' : 'i'); } catch (e) { throw new ToolError(`Invalid regular expression: ${(e as Error).message}`); }
      test = line => re.test(line);
    } else if (case_sensitive) test = line => line.includes(query);
    else { const q = query.toLowerCase(); test = line => line.toLowerCase().includes(q); }
    const cap = offset + limit;
    const hits: { va: number; f: Func; text: string }[] = [];
    let more = false;
    scan: for (const f of s.an.funcs) {
      if (obj && f.obj !== obj.index) continue;
      let doc: CodeDoc;
      try { doc = s.decompile(f.va); } catch { continue; }
      if (doc.header && test(doc.header)) hits.push({ va: f.va, f, text: doc.header });
      for (const line of doc.lines) {
        if (!test(line.text)) continue;
        if (hits.length >= cap) { more = true; break scan; }
        hits.push({ va: line.va ?? f.va, f, text: line.text.trim() });
      }
    }
    const window = hits.slice(offset, cap);
    return paginate(window, 0, limit, response_format, p => {
      const count = p.items.length;
      const has_more = more || count < window.length;
      const next = offset + count;
      const items = p.items.map(h => ({ address: hex8(h.va), procedure: h.f.fullName, line: h.text.length > 300 ? h.text.slice(0, 300) + '…' : h.text }));
      const data = { offset, count, has_more, ...(has_more ? { next_offset: next } : {}), matches: items };
      const text = count
        ? [...items.map(i => `${i.address}  ${i.procedure}:  ${oneLine(i.line, 220)}`), '', has_more ? `Matches ${offset + 1}-${next}; there are more: call again with offset=${next}.` : `Matches ${offset + 1}-${next} (end).`].join('\n')
        : offset ? 'No more matches.' : `No decompiled line matches ${JSON.stringify(query)}${obj ? ` in ${obj.name}` : ''}. Strings and API names can also be found with vb_list_strings and vb_list_api_declares.`;
      return { text, data };
    });
  }));

  server.registerTool('vb_resolve_address', {
    title: 'Identify an address',
    description: 'Say what is at a virtual address: the start of a procedure, code inside a procedure, a string literal, a global variable, an import, or plain data, plus the section it is in.',
    inputSchema: z.strictObject({ file: FileArg, address: AddrArg, response_format: FormatArg }),
    annotations: READ,
  }, guard('resolving the address', ({ file, address, response_format }) => {
    const l = getLoaded(file);
    const va = requireAddress(l, address);
    const r = l.session.resolve(va);
    const sec = l.session.img.sections.find(x => va >= x.va && va < x.va + Math.max(x.vsize, x.rawSize));
    const data = {
      address: hex8(va), kind: r.kind as string, section: sec?.name ?? null,
      ...(r.name !== undefined ? { name: r.name.slice(0, 1000) } : {}),
      ...(r.func !== undefined ? { procedure_start: hex8(r.func), offset_in_procedure: va - r.func } : {}),
      refs: l.session.xrefsTo(va).length,
    };
    const desc = r.kind === 'func' ? `start of procedure ${r.name}`
      : r.kind === 'code' ? `code in ${r.name} (+0x${(va - r.func!).toString(16)} from ${hex8(r.func!)})`
      : r.kind === 'string' ? `string literal ${JSON.stringify(oneLine(r.name ?? '', 200))}`
      : r.kind === 'import' ? `import ${r.name}`
      : r.kind === 'global' ? `global variable ${r.name}` : 'data (no symbol)';
    return reply(response_format, `${hex8(va)}: ${desc}; section ${sec?.name ?? '?'}; ${data.refs} reference(s)`, data);
  }));

  server.registerTool('vb_read_bytes', {
    title: 'Read raw bytes',
    description: 'Hex dump of up to 4096 bytes at a virtual address, with an ASCII column and a UTF-16 preview. For data the other tools do not decode: embedded buffers, tables, encrypted blobs.',
    inputSchema: z.strictObject({
      file: FileArg,
      address: AddrArg,
      length: z.number().int().min(1).max(4096).default(256).describe('Number of bytes to read'),
      response_format: FormatArg,
    }),
    annotations: READ,
  }, guard('reading bytes', ({ file, address, length, response_format }) => {
    const l = getLoaded(file);
    const va = requireAddress(l, address);
    const b = l.session.hexDump(va, length).bytes;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i += 16) {
      const row = b.subarray(i, i + 16);
      const hx = [...row].map(x => x.toString(16).padStart(2, '0')).join(' ');
      const asc = [...row].map(x => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
      lines.push(`${hex8(va + i)}  ${hx.padEnd(47)}  ${asc}`);
    }
    let utf16 = '';
    for (let i = 0; i + 1 < b.length && utf16.length < 200; i += 2) {
      const c = b[i] | (b[i + 1] << 8);
      if (c === 0) break;
      utf16 += c >= 0x20 && c !== 0x7f && (c < 0xd800 || c > 0xdfff) ? String.fromCharCode(c) : '.';
    }
    const text = [...lines, '', `${b.length} byte(s)${b.length < length ? ' (the section ends here)' : ''}. As UTF-16 up to the first NUL: ${JSON.stringify(utf16)}`].join('\n');
    return reply(response_format, text, { address: hex8(va), length: b.length, hex: Buffer.from(b).toString('hex'), utf16_preview: utf16 });
  }));

  // ---------- annotations ----------
  server.registerTool('vb_rename', {
    title: 'Rename a procedure or global',
    description: 'Give a procedure (or a global variable / code label, by address) a meaningful name, e.g. rename Proc_12_401A30 to DecryptConfig. The new name is used in all later decompilation, search and xref output, and is saved so it is re-applied whenever this same file is opened again. Names must be valid VB identifiers and unique within their object.',
    inputSchema: z.strictObject({
      file: FileArg,
      target: z.string().min(1).max(300).describe('Procedure name, or the address of a procedure start, global variable or code label'),
      new_name: z.string().min(1).max(255).describe('New name: a letter followed by letters, digits or underscores; not a VB keyword'),
    }),
    annotations: EDIT,
  }, guard('renaming', ({ file, target, new_name }) => {
    const l = getLoaded(file);
    const s = l.session;
    const bad = vbIdentifierError(new_name);
    if (bad) throw new ToolError(`"${new_name}" is not a valid name: ${bad}.`);
    let va: number;
    let before: string;
    let kind: string;
    const a = parseAddress(target);
    const byAddr = /^0x/i.test(target.trim()) && a !== undefined;
    let f: Func | undefined;
    if (byAddr) {
      va = requireAddress(l, target);
      f = s.an.funcByVA.get(va);
    } else {
      f = resolveProc(l, target);
      va = f.va;
    }
    if (f && f.va === va) {
      if (s.an.funcs.some(g => g !== f && g.obj === f!.obj && g.name.toLowerCase() === new_name.toLowerCase())) {
        throw new ToolError(`${f.obj >= 0 ? s.project.objects[f.obj].name : 'The unattributed group'} already has a procedure named ${new_name}. Choose another name.`);
      }
      before = f.fullName; kind = 'procedure';
    } else if (s.an.globals.has(va)) { before = s.an.globals.get(va)!; kind = 'global variable'; }
    else if (s.resolve(va).kind === 'code') { before = s.an.labels.get(va) ?? hex8(va); kind = 'code label'; }
    else throw new ToolError(`${hex8(va)} is not a procedure start, a known global variable or code inside a procedure, so it cannot be renamed. vb_resolve_address shows what an address is.`);
    const { saved, fullName: after } = applyRename(l, va, new_name, 'agent');
    return { content: [{ type: 'text', text: `Renamed ${kind} ${before} -> ${after} (${hex8(va)}).${saved ? ' Saved for future sessions.' : ' Not saved to disk (persistence is off); it lasts until the file is closed.'}` }] };
  }));

  server.registerTool('vb_set_comment', {
    title: 'Comment an address',
    description: 'Attach a note to a code address. It appears as a trailing comment on that statement in vb_decompile output and on that instruction in vb_disassemble, and is saved for future sessions. Get statement addresses from vb_decompile with addresses=true. Pass an empty comment to remove it.',
    inputSchema: z.strictObject({
      file: FileArg,
      address: AddrArg,
      comment: z.string().max(500).describe('Comment text on one line; empty string removes the comment'),
    }),
    annotations: EDIT,
  }, guard('setting the comment', ({ file, address, comment }) => {
    const l = getLoaded(file);
    const va = requireAddress(l, address);
    const text = comment.replace(/[\r\n]+/g, ' ').trim();
    const r = l.session.resolve(va);
    const saved = applyComment(l, va, text, 'agent');
    const where = r.func !== undefined ? ` in ${r.name}` : '';
    const warn = r.func === undefined ? ' Note: this address is not inside a procedure, so the comment will not show in decompiled code.' : '';
    return { content: [{ type: 'text', text: `${text ? 'Comment set' : 'Comment removed'} at ${hex8(va)}${where}.${saved ? ' Saved.' : ''}${warn}` }] };
  }));

  server.registerTool('vb_load_type_library', {
    title: 'Load an ActiveX type library',
    description: 'Read the type library of an ActiveX control file (.ocx, .tlb, .dll) so that its controls, events, properties and methods get real names instead of Control_Event12 / Method_XX / DispID_XX. Applies to the open file immediately; pass the libraries to vb_open_file (type_libraries) to have them applied during analysis as well. The library is only parsed, never loaded or executed.',
    inputSchema: z.strictObject({
      file: FileArg,
      path: z.string().min(1).max(2000).describe('Absolute path of the .ocx/.tlb/.dll on the machine this server runs on'),
    }),
    annotations: EDIT,
  }, guard('loading the type library', ({ file, path: p }) => {
    const l = getLoaded(file);
    const r = loadTypeLibFile(p, l);
    return { content: [{ type: 'text', text: `Loaded type library ${oneLine(r.name, 80)}: ${r.classes} control classes, ${r.types} types. Decompile again to see the improved names.` }] };
  }));

  // ---------- export ----------
  server.registerTool('vb_export_project', {
    title: 'Export the decompiled project',
    description: 'Write the whole decompiled project to a folder on disk: a .vbp, one .frm/.bas/.cls/.ctl per object (forms include their control definitions), extracted pictures and icons under resources/, and API_Declares.txt. Use it when the user wants the sources as files, or to grep them with other tools. The output is a reconstruction for reading, not guaranteed to recompile. Decompiles everything, so it can take a while on large binaries.',
    inputSchema: z.strictObject({
      file: FileArg,
      output_dir: z.string().min(1).max(2000).describe('Folder to write into; created if missing. Must be empty unless overwrite=true'),
      overwrite: z.boolean().default(false).describe('Allow writing into a non-empty folder, replacing files with the same names'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, guard('exporting the project', ({ file, output_dir, overwrite }) => {
    const l = getLoaded(file);
    const dir = checkWritableDir(output_dir);
    if (existsSync(dir) && readdirSync(dir).length && !overwrite) {
      throw new ToolError(`${dir} is not empty. Choose a new folder, or pass overwrite=true to write into it (files with the same names are replaced).`);
    }
    const entries = unzipSync(l.session.exportZip());
    mkdirSync(dir, { recursive: true });
    const written: string[] = [];
    const used = new Set<string>();
    let total = 0;
    for (const [name, bytes] of Object.entries(entries)) {
      let rel = safeRelPath(name);
      while (used.has(rel.toLowerCase())) rel = path.join(path.dirname(rel), '_' + path.basename(rel));
      used.add(rel.toLowerCase());
      const dest = path.resolve(dir, rel);
      if (dest !== dir && !dest.startsWith(dir + path.sep)) continue; // never leave the output folder
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      written.push(rel);
      total += bytes.length;
    }
    const src = written.filter(w => !w.startsWith('resources' + path.sep));
    const text = [
      `Exported ${written.length} files (${total} bytes) to ${dir}`,
      `Sources: ${src.slice(0, 60).join(', ')}${src.length > 60 ? `, … (${src.length} total)` : ''}`,
      ...(written.length > src.length ? [`Resources: ${written.length - src.length} pictures/icons under resources${path.sep}`] : []),
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  }));
}
