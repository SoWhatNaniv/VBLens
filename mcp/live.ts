// Live link between this server and the VBLens app.
//
// The server hosts the app (the same single-file build as dist/index.html) and the app,
// when loaded from here, uses this server's sessions instead of its own Web Worker:
//
//   GET  /                 the app, with a per-process token injected
//   POST /live/rpc         {file, method, args} -> result      (session queries and edits)
//   POST /live/open        raw file bytes -> {file, overview, tree}   (a file dropped in the app)
//   POST /live/typelib     raw .ocx/.tlb bytes -> {name, classes, types}
//   POST /live/view        what the user is looking at (reported by the app)
//   GET  /live/events      server-sent events: files, activity, show, changed, closed
//
// Everything under /live needs the token, which only the served page knows. Host and
// Origin headers are checked so other web pages and DNS rebinding cannot reach it.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  Loaded, ToolError, applyComment, applyRename, events, findLoaded, hex8, listLoaded, openUpload, resetAnnotations, viewedFiles,
} from './state';
import { vbIdentifierError } from '../src/core/vbident';
import { getSettings, saveSettings } from './settings';
import { randomBytes as rnd } from 'node:crypto';

declare const __VBLENS_APP_HTML__: string | undefined;

/** The app's HTML: embedded in the bundle, or read from dist/ when run from source. */
function appHtml(): string | undefined {
  if (typeof __VBLENS_APP_HTML__ === 'string') return __VBLENS_APP_HTML__;
  for (const rel of ['../dist/index.html', '../../dist/index.html']) {
    try { return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'); } catch { /* try next */ }
  }
  return undefined;
}

/** Session methods the app may call. Edits go through dedicated handlers below. */
const QUERIES = new Set([
  'overview', 'tree', 'decompile', 'objectSource', 'declaresFor', 'disasm', 'graph', 'hexDump', 'hexRange', 'funcInfo',
  'xrefsTo', 'xrefsToMany', 'strings', 'imports', 'symbols', 'declares', 'components', 'form', 'resolve', 'search',
  'grepCode', 'deepCallers', 'exportZip',
]);

const MAX_RPC_BODY = 32 * 1024 * 1024;
const MAX_FILE_BODY = 512 * 1024 * 1024;

export interface UserView {
  file: string;
  tab: string;
  kind: string;
  title?: string;
  view?: string;
  va?: number;
  cursor?: number;
  obj?: number;
  control?: string;
  selection?: string;
  at: number;
  client: string;
}

interface Client { id: string; res: ServerResponse; ping: NodeJS.Timeout }

// ---- JSON with binary ------------------------------------------------------------------

function encode(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $b64: Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('base64') } : x));
}

function decode(text: string): unknown {
  return JSON.parse(text, (_k, x) => (x && typeof x === 'object' && typeof x.$b64 === 'string' && Object.keys(x).length === 1 ? new Uint8Array(Buffer.from(x.$b64, 'base64')) : x));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) { reject(new HttpError(413, `Request larger than ${limit / 1048576} MB`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

class HttpError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

function send(res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

// ---- the hub ----------------------------------------------------------------------------

export interface LiveOptions {
  /** Host names (without port) the Host header may carry; empty = do not check. */
  allowedHosts: string[];
  /** When set, the page itself requires ?token=<this> (remote HTTP mode). */
  pageToken?: string;
  /** Engine of the desktop app: the app manages the AI agent switch. */
  desktop?: boolean;
}

export class LiveHub {
  readonly token = randomBytes(24).toString('hex');
  /** Changes when the server restarts, so the app can tell its files are gone. */
  readonly instance = randomBytes(6).toString('hex');
  url?: string;
  lastView?: UserView;
  lastAgentAt = 0;
  private clients = new Map<string, Client>();
  private html?: string;

  constructor(private opts: LiveOptions) {
    events.on('files', () => this.broadcast('files', { files: this.fileList() }));
    events.on('closed', (id: string) => this.broadcast('closed', { file: id }));
    events.on('changed', (e: { file: string; what: string; va?: number; name?: string; by: string }) => {
      this.broadcast('changed', { ...e, label: e.va !== undefined ? hex8(e.va) : undefined });
    });
    events.on('activity', (e: Record<string, unknown>) => this.broadcast('activity', e));
  }

  /** AI agent switch and connection details, for the app's settings dialog. */
  appState() {
    const s = getSettings();
    return {
      desktop: !!this.opts.desktop,
      mcp: {
        on: s.mcp.enabled, active: s.mcp.enabled,
        url: this.url ? this.url + 'mcp' : null, token: this.opts.desktop ? s.mcp.token : null,
        lastAgentAt: this.lastAgentAt || null, preferredPort: s.port ?? 3920,
      },
    };
  }

  broadcastAppState(): void { this.broadcast('appstate', this.appState()); }

  /** An agent made a request: tell the app when one shows up after being quiet. */
  noteAgent(): void {
    const quiet = Date.now() - this.lastAgentAt > 30_000;
    this.lastAgentAt = Date.now();
    if (quiet) this.broadcastAppState();
  }

  get connected(): number { return this.clients.size; }

  fileList() {
    return listLoaded().map(l => ({ file: l.id, name: l.path.startsWith('app:') ? l.path.slice(4) : l.path.split(/[\\/]/).pop(), path: l.path.startsWith('app:') ? null : l.path, origin: l.origin, compile: l.session.project.isPCode ? 'P-Code' : 'Native code', procedures: l.session.an.funcs.length }));
  }

  /** Ask every connected app to show something. Returns how many apps received it. */
  show(e: Record<string, unknown>): number {
    return this.broadcast('show', e);
  }

  private broadcast(event: string, data: unknown): number {
    const msg = `event: ${event}\ndata: ${encode(data)}\n\n`;
    for (const c of this.clients.values()) c.res.write(msg);
    return this.clients.size;
  }

  // ---- request routing ----

  /** Handles app and /live requests; returns false for anything else (e.g. /mcp). */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p !== '/' && p !== '/index.html' && !p.startsWith('/live/') && p !== '/favicon.ico') return false;
    void this.route(req, res, url).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 400;
      if (!(e instanceof HttpError) && !(e instanceof ToolError)) console.error('[vblens-mcp] app request failed:', e);
      if (!res.headersSent) send(res, status, JSON.stringify({ error: (e as Error).message ?? String(e) }));
      else res.end();
    });
    return true;
  }

  private checkHost(req: IncomingMessage): void {
    const hosts = this.opts.allowedHosts;
    if (!hosts.length) return;
    const name = (h: string) => { try { return new URL('http://' + h).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } };
    const ok = (h: string) => hosts.includes(name(h));
    if (!ok(req.headers.host ?? '')) throw new HttpError(403, 'Host not allowed');
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host = '';
      try { host = new URL(origin).host; } catch { /* malformed */ }
      if (!host || !ok(host)) throw new HttpError(403, 'Origin not allowed');
    }
  }

  private checkToken(given: string | null | undefined): void {
    const a = Buffer.from(given ?? '');
    const b = Buffer.from(this.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Missing or wrong app token: reload the page');
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    this.checkHost(req);
    const p = url.pathname;
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (p === '/' || p === '/index.html') return this.page(req, res, url);
    if (p === '/live/events') { this.checkToken(url.searchParams.get('t')); return this.events(req, res, url); }
    this.checkToken(req.headers['x-vblens-token'] as string | undefined);
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const client = String(req.headers['x-vblens-client'] ?? '');
    if (p === '/live/rpc') {
      const body = decode((await readBody(req, MAX_RPC_BODY)).toString('utf8')) as { file?: string; method: string; args?: unknown[] };
      const result = this.rpc(body.file, body.method, body.args ?? [], client);
      send(res, 200, encode({ result }));
      return;
    }
    if (p === '/live/open') {
      const name = decodeURIComponent(url.searchParams.get('name') ?? 'file');
      const bytes = new Uint8Array(await readBody(req, MAX_FILE_BODY));
      const { loaded, reused } = openUpload(bytes, name);
      events.emit('activity', { file: loaded.id, tool: 'app_open', by: 'app', label: `The user opened ${loaded.id} in the app` });
      send(res, 200, encode({ result: { ...this.attach(loaded), reused } }));
      return;
    }
    if (p === '/live/typelib') {
      const file = url.searchParams.get('file');
      const bytes = new Uint8Array(await readBody(req, MAX_RPC_BODY));
      const l = file ? findLoaded(file) : undefined;
      let r: { name: string; classes: number; types: number };
      if (l) { r = l.session.loadTypeLib(bytes); events.emit('changed', { file: l.id, what: 'typelib', by: 'app:' + client }); }
      else {
        const { loadTypeLibFromFile } = await import('../src/core/typelib/msft');
        const { registerTypeLib } = await import('../src/core/data/vbclasses');
        const tl = loadTypeLibFromFile(bytes);
        r = { name: tl.name, classes: registerTypeLib(tl).length, types: tl.types.length };
      }
      send(res, 200, encode({ result: r }));
      return;
    }
    if (p === '/live/view') {
      const v = decode((await readBody(req, 64 * 1024)).toString('utf8')) as Partial<UserView>;
      if (typeof v.file === 'string' && findLoaded(v.file)) {
        this.lastView = {
          file: v.file, tab: String(v.tab ?? ''), kind: String(v.kind ?? ''), title: v.title ? String(v.title).slice(0, 300) : undefined,
          view: v.view ? String(v.view) : undefined, va: num(v.va), cursor: num(v.cursor), obj: num(v.obj),
          control: v.control ? String(v.control).slice(0, 200) : undefined, selection: v.selection ? String(v.selection).slice(0, 4000) : undefined,
          at: Date.now(), client,
        };
        this.updateViewed();
      }
      send(res, 200, '{"result":true}');
      return;
    }
    throw new HttpError(404, 'Not found');
  }

  private page(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.opts.pageToken) {
      const a = Buffer.from(url.searchParams.get('token') ?? '');
      const b = Buffer.from(this.opts.pageToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        send(res, 401, '<!doctype html><meta charset="utf-8"><title>VBLens</title><p style="font:15px system-ui;padding:40px">Open this page with <code>?token=&lt;VBLENS_MCP_TOKEN&gt;</code> appended to the address.</p>', 'text/html; charset=utf-8');
        return;
      }
    }
    this.html ??= appHtml();
    if (!this.html) { send(res, 500, 'The app build was not found. Run "npm run build" and then "npm run build:mcp".', 'text/plain; charset=utf-8'); return; }
    const cfg = `<script>window.__VBLENS_LIVE__=${JSON.stringify({ token: this.token, instance: this.instance, desktop: !!this.opts.desktop })};</script>`;
    const html = this.html.replace(/<head>/i, m => m + cfg);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer',
    });
    res.end(html);
    void req;
  }

  private events(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const id = (url.searchParams.get('c') ?? '').slice(0, 64) || randomBytes(6).toString('hex');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 1500\nevent: hello\ndata: ${encode({ instance: this.instance, files: this.fileList(), app: this.appState() })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    this.clients.get(id)?.res.end();
    this.clients.set(id, { id, res, ping });
    const gone = () => {
      clearInterval(ping);
      if (this.clients.get(id)?.res === res) this.clients.delete(id);
      if (this.lastView?.client === id) this.lastView = undefined;
      this.updateViewed();
    };
    req.on('close', gone);
    res.on('error', gone);
  }

  private updateViewed(): void {
    viewedFiles.clear();
    if (this.lastView && this.clients.has(this.lastView.client)) viewedFiles.add(this.lastView.file);
  }

  private attach(l: Loaded) {
    return { file: l.id, name: l.path.startsWith('app:') ? l.path.slice(4) : l.path.split(/[\\/]/).pop(), origin: l.origin, overview: l.session.overview(), tree: l.session.tree() };
  }

  private rpc(file: string | undefined, method: string, args: unknown[], client: string): unknown {
    if (method === 'liveFiles') return this.fileList();
    // ---- AI agent settings (not tied to a file)
    if (method === 'appState') return this.appState();
    if (method === 'setMcp') {
      const on = args[0] === true;
      saveSettings({ mcp: { ...getSettings().mcp, enabled: on } });
      this.broadcastAppState();
      return this.appState();
    }
    if (method === 'newMcpToken') {
      saveSettings({ mcp: { ...getSettings().mcp, token: rnd(24).toString('hex') } });
      this.broadcastAppState();
      return this.appState();
    }
    const l = file ? findLoaded(file) : undefined;
    if (method === 'liveAttach') {
      const t = findLoaded(String(args[0]));
      if (!t) throw new ToolError(`${String(args[0])} is no longer open on the server.`);
      return this.attach(t);
    }
    if (!l) throw new HttpError(410, `This file is no longer open on the MCP server${file ? ` (${file})` : ''}. Open it again.`);
    if (method === 'annotations') return { renames: [...l.renames], comments: [...l.comments] };
    if (method === 'rename') {
      const [va, name] = args as [number, string];
      const bad = vbIdentifierError(String(name));
      if (bad) throw new ToolError(bad);
      applyRename(l, Number(va), String(name), 'app:' + client);
      return true;
    }
    if (method === 'setComment') { applyComment(l, Number(args[0]), String(args[1] ?? ''), 'app:' + client); return true; }
    if (method === 'resetAnnotations') { resetAnnotations(l, 'app:' + client); return { overview: l.session.overview(), tree: l.session.tree() }; }
    if (!QUERIES.has(method)) throw new ToolError(`Unknown method ${method}`);
    const fn = (l.session as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    return fn.apply(l.session, args);
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v >>> 0 : undefined;
}
