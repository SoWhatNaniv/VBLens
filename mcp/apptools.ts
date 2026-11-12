// Tools that work with the VBLens app connected to this server: find out what
// the user is looking at, show them something, and open the app.

import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { LiveHub } from './live';
import { Loaded, ToolError, ToolReply, findLoaded, getLoaded, hex8, oneLine, parseAddress, reply, requireAddress, resolveObject, resolveProc } from './state';

export interface AppLink {
  hub: LiveHub;
  /** The browser can be launched only when the app is served on this machine's loopback. */
  local: boolean;
  /** Desktop app: bring its window to the front instead of opening a browser. */
  focus?: () => void;
}

type Guard = <A>(what: string, fn: (args: A) => ToolReply) => (args: A) => Promise<ToolReply>;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const FileArg = z.string().max(300).optional().describe('Id of an open file. Omit to use the file the user is viewing in the app, or else the most recently opened file.');

function noApp(app: AppLink | undefined): string {
  if (!app?.hub.url) return 'The app link is turned off on this server (started with --no-ui).';
  return `No app window is connected. The app is at ${app.hub.url}${app.local ? '' : '?token=<VBLENS_MCP_TOKEN>'} — ${app.local ? "call vb_open_app to open it in the user's browser, or " : ''}give the user that address.`;
}

function openBrowser(url: string): Promise<void> {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', e => reject(e));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** A few decompiled lines around an address, with the line at the address marked. */
function codeAround(l: Loaded, procVa: number, at: number | undefined, radius = 10): string[] {
  const doc = l.session.decompile(procVa);
  const lines = [{ text: doc.header, va: doc.va, indent: 0 }, ...doc.lines, { text: doc.footer ?? '', va: undefined, indent: 0 }];
  let idx = 0;
  if (at !== undefined) {
    let best = -1;
    lines.forEach((ln, i) => { if (ln.va !== undefined && ln.va <= at && (best < 0 || (lines[best].va ?? 0) <= ln.va)) best = i; });
    if (best >= 0) idx = best;
  }
  const from = Math.max(0, idx - radius), to = Math.min(lines.length, idx + radius + 1);
  return lines.slice(from, to).map((ln, k) => `${from + k === idx && at !== undefined ? '>' : ' '} ${ln.va !== undefined ? hex8(ln.va) : ' '.repeat(10)}  ${'    '.repeat(Math.max(0, ln.indent))}${ln.text}`);
}

function asmAround(l: Loaded, procVa: number, at: number | undefined, radius = 12): string[] {
  const rows = l.session.disasm(procVa).rows;
  let idx = Math.max(0, at === undefined ? 0 : rows.findIndex(r => r.va >= at));
  if (idx < 0) idx = 0;
  const from = Math.max(0, idx - radius), to = Math.min(rows.length, idx + radius + 1);
  return rows.slice(from, to).map((r, k) => `${from + k === idx && at !== undefined ? '>' : ' '} ${hex8(r.va)}  ${r.toks.map(t => t.t).join('')}${r.comment ? `  ; ${oneLine(r.comment, 80)}` : ''}`);
}

export function registerAppTools(server: McpServer, app: AppLink | undefined, guard: Guard): void {
  server.registerTool('vb_app_status', {
    title: 'App connection status',
    description: 'Whether the VBLens app (the visual workspace the user looks at) is connected to this server, its address, and which file the user has open there. The app shares this server\'s files: anything you open, rename or comment shows up for the user, and files the user drops into the app appear in vb_list_files.',
    inputSchema: z.strictObject({ response_format: z.enum(['text', 'json']).default('text').describe("'text' or 'json'") }),
    annotations: READ,
  }, guard('reading the app status', ({ response_format }: { response_format: 'text' | 'json' }) => {
    const hub = app?.hub;
    const v = hub?.lastView;
    const data = {
      enabled: !!hub?.url, url: hub?.url ?? null, connected_windows: hub?.connected ?? 0,
      viewing: v ? { file: v.file, tab: v.title ?? v.tab, view: v.view ?? null, cursor: v.cursor !== undefined ? hex8(v.cursor) : null, seconds_ago: Math.round((Date.now() - v.at) / 1000) } : null,
    };
    const text = !hub?.url ? noApp(app)
      : [
        `App address: ${hub.url}${app!.local ? '' : '?token=<VBLENS_MCP_TOKEN>  (reachable from other machines; the user needs the token the server was started with)'}`,
        hub.connected ? `${hub.connected} app window(s) connected.` : `No app window is connected. vb_open_app opens it in the user's browser.`,
        ...(v ? [`The user is viewing ${v.file}: ${v.title ?? v.tab}${v.view ? ` (${v.view})` : ''}${v.cursor !== undefined ? ` at ${hex8(v.cursor)}` : ''}. vb_get_user_view gives the details.`] : hub.connected ? ['No file is open in the app yet.'] : []),
      ].join('\n');
    return reply(response_format, text, data);
  }));

  server.registerTool('vb_open_app', {
    title: 'Open the app in the browser',
    description: 'Open the VBLens app in the user\'s default web browser, connected live to this server. Use it when the user wants to watch or browse the analysis visually. Only works when this server runs on the user\'s own computer; otherwise give them the address from vb_app_status.',
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async () => {
    const hub = app?.hub;
    if (app?.focus) { app.focus(); return { content: [{ type: 'text', text: 'Brought the VBLens window to the front.' }] }; }
    if (!hub?.url) return { isError: true, content: [{ type: 'text', text: noApp(app) }] };
    if (!app!.local) return { isError: true, content: [{ type: 'text', text: `This server is not on the user's computer, so it cannot open their browser. Give the user this address: ${hub.url} (with ?token=<VBLENS_MCP_TOKEN> appended).` }] };
    try {
      await openBrowser(hub.url);
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Could not start a browser (${(e as Error).message}). Give the user this address instead: ${hub.url}` }] };
    }
    return { content: [{ type: 'text', text: `Opened ${hub.url} in the default browser.${hub.connected ? ` ${hub.connected} app window(s) were already connected.` : ''} It shows the files open on this server; vb_show_in_app moves it to what you want the user to see.` }] };
  });

  server.registerTool('vb_get_user_view', {
    title: 'What the user is looking at',
    description: `What the user currently has on screen in the VBLens app: the file, the tab (procedure, form, strings, …), the view (code, disassembly, graph, designer), the cursor address, the code around the cursor and any text they selected.

Use it when the user refers to "this", "here", "the selected code" or "what I'm looking at".`,
    inputSchema: z.strictObject({
      context_lines: z.number().int().min(0).max(60).default(10).describe('Lines of code to include before and after the cursor'),
      response_format: z.enum(['text', 'json']).default('text').describe("'text' or 'json'"),
    }),
    annotations: READ,
  }, guard('reading the user view', ({ context_lines, response_format }: { context_lines: number; response_format: 'text' | 'json' }) => {
    const hub = app?.hub;
    if (!hub?.url || !hub.connected) throw new ToolError(noApp(app));
    const v = hub.lastView;
    if (!v) throw new ToolError('The app is connected but has no file open yet. Open one with vb_open_file (the app follows), or ask the user to drop a file into the app.');
    const l = findLoaded(v.file);
    if (!l) throw new ToolError(`The app shows ${v.file}, which is no longer open on the server.`);
    const s = l.session;
    const lines: string[] = [];
    const data: Record<string, unknown> = { file: l.id, tab: v.title ?? v.tab, kind: v.kind, view: v.view ?? null, seconds_ago: Math.round((Date.now() - v.at) / 1000) };
    let head = `The user is viewing ${l.id}: `;
    if (v.kind === 'proc' && v.va !== undefined) {
      const f = s.an.funcByVA.get(v.va);
      const name = f?.fullName ?? hex8(v.va);
      head += `${name} (${hex8(v.va)}) in ${v.view === 'asm' ? 'disassembly' : v.view === 'graph' ? 'graph' : v.view === 'split' ? 'split code/disassembly' : 'decompiled code'} view`;
      if (v.cursor !== undefined) head += `, cursor at ${hex8(v.cursor)}`;
      Object.assign(data, { procedure: name, address: hex8(v.va), cursor: v.cursor !== undefined ? hex8(v.cursor) : null });
      if (f) {
        const ctx = v.view === 'asm' || v.view === 'graph' ? asmAround(l, f.va, v.cursor, context_lines) : codeAround(l, f.va, v.cursor, context_lines);
        if (ctx.length) { lines.push('', `${v.view === 'asm' || v.view === 'graph' ? 'Disassembly' : 'Code'} around the cursor ('>' marks it):`, ...ctx); data.context = ctx; }
      }
    } else if (v.kind === 'object' && v.obj !== undefined) {
      const o = s.project.objects[v.obj];
      head += `${o?.kind ?? 'object'} ${o?.name ?? v.obj} in ${v.view ?? 'code'} view`;
      if (v.control) head += `, control ${v.control} selected`;
      Object.assign(data, { object: o?.name ?? null, control: v.control ?? null });
      if (v.view !== 'designer' && v.cursor !== undefined) {
        const r = s.resolve(v.cursor);
        if (r.func !== undefined) { const ctx = codeAround(l, r.func, v.cursor, context_lines); lines.push('', `Code around the cursor ('>' marks it):`, ...ctx); data.context = ctx; data.cursor = hex8(v.cursor); }
      }
    } else {
      head += `the ${v.title ?? v.tab} tab`;
      if (v.cursor !== undefined) { head += ` at ${hex8(v.cursor)}`; data.cursor = hex8(v.cursor); }
    }
    if (v.selection) { lines.push('', 'Selected text:', v.selection); data.selection = v.selection; }
    lines.unshift(head + '.');
    return reply(response_format, lines.join('\n'), data);
  }));

  server.registerTool('vb_show_in_app', {
    title: 'Show something to the user in the app',
    description: `Move the user's VBLens app to a procedure, address, form or control, optionally with a short note that appears on screen. Use it to point the user at evidence while explaining ("here is where the password is checked").

Give \`target\` (procedure name or address; an address inside a procedure puts the cursor on that statement) or \`object\` (form/module/class, optionally with \`control\`).`,
    inputSchema: z.strictObject({
      file: FileArg,
      target: z.string().max(300).optional().describe('Procedure ("Form1.Command1_Click") or address ("0x00401A30"); string and data addresses open the strings or hex view'),
      object: z.string().max(300).optional().describe('Form, module or class name (instead of target)'),
      control: z.string().max(300).optional().describe('Control on that form to select in the designer, e.g. "txtPassword"'),
      view: z.enum(['code', 'asm', 'graph', 'designer']).optional().describe('How to show it; default code (designer for forms)'),
      note: z.string().max(400).optional().describe('One or two sentences shown to the user next to it'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard('showing it in the app', (a: { file?: string; target?: string; object?: string; control?: string; view?: 'code' | 'asm' | 'graph' | 'designer'; note?: string }) => {
    const hub = app?.hub;
    if (!hub?.url || !hub.connected) throw new ToolError(noApp(app));
    const l = a.file ? getLoaded(a.file) : (hub.lastView && findLoaded(hub.lastView.file)) || getLoaded();
    const s = l.session;
    const ev: Record<string, unknown> = { file: l.id, note: a.note ? oneLine(a.note, 400) : undefined };
    let what: string;
    if (a.target) {
      const t = a.target.trim();
      let proc;
      try { proc = resolveProc(l, t); } catch (e) { if (parseAddress(t) === undefined) throw e; }
      if (proc) {
        const at = parseAddress(t);
        const focus = /^0x/i.test(t) && at !== undefined && at !== proc.va ? at : undefined;
        Object.assign(ev, { kind: 'proc', va: proc.va, focus, view: a.view && a.view !== 'designer' ? a.view : 'code' });
        what = `${proc.fullName}${focus !== undefined ? ` at ${hex8(focus)}` : ''}`;
      } else {
        const va = requireAddress(l, t);
        const r = s.resolve(va);
        Object.assign(ev, { kind: r.kind === 'string' ? 'string' : 'hex', va });
        what = `${r.kind === 'string' ? 'string' : 'data'} at ${hex8(va)}`;
      }
    } else if (a.object) {
      const o = resolveObject(l, a.object);
      const hasForm = s.forms.has(o.index);
      if (a.control) {
        if (!hasForm) throw new ToolError(`${o.name} has no form, so it has no controls.`);
        const names = s.forms.get(o.index)!.controls.map(c => (c.arrayIndex !== undefined ? `${c.name}(${c.arrayIndex})` : c.name));
        const want = a.control.trim().toLowerCase();
        const hit = names.find(n => n.toLowerCase() === want) ?? names.find(n => n.toLowerCase().replace(/\(\d+\)$/, '') === want);
        if (!hit) throw new ToolError(`No control named "${a.control}" on ${o.name}. vb_get_form lists them.`);
        Object.assign(ev, { kind: 'object', obj: o.index, control: hit, view: 'designer' });
        what = `${o.name}.${hit}`;
      } else {
        const view = a.view === 'designer' && !hasForm ? 'code' : a.view === 'asm' || a.view === 'graph' ? 'code' : a.view ?? (hasForm ? 'designer' : 'code');
        Object.assign(ev, { kind: 'object', obj: o.index, view });
        what = `${o.kind} ${o.name}`;
      }
    } else throw new ToolError('Pass `target` (procedure or address) or `object` (form/module/class).');
    const n = hub.show(ev);
    return { content: [{ type: 'text', text: `Showing ${what} in ${n} app window(s)${a.note ? ' with your note' : ''}.` }] };
  }));
}
