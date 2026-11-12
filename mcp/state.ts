// Server state shared by every tool: the loaded binaries, saved renames/comments,
// path policy, and helpers that turn agent input (names, hex addresses) into
// things the analysis core understands.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Session } from '../src/core/session';
import type { Func } from '../src/core/analysis/analysis';
import type { VBObject } from '../src/core/vb/structures';
import { loadTypeLibFromFile } from '../src/core/typelib/msft';
import { registerTypeLib } from '../src/core/data/vbclasses';

export const CHARACTER_LIMIT = 25_000;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_OPEN_FILES = 8;

/** An error whose message is written for the calling model: what went wrong and what to do next. */
export class ToolError extends Error {}

export interface Config {
  /** When non-empty, files may only be opened from (and exported to) these directories. */
  allowDirs: string[];
  /** Directory for saved renames/comments; undefined disables saving. */
  stateDir?: string;
}

export const config: Config = {
  allowDirs: [],
  stateDir: path.join(homedir(), '.vblens'),
};

export interface Loaded {
  id: string;
  /** Absolute path, or "app:<name>" for a file the user dropped into the app. */
  path: string;
  /** Who opened it first. */
  origin: 'agent' | 'app';
  size: number;
  sha256: string;
  session: Session;
  renames: Map<number, string>;
  comments: Map<number, string>;
  typeLibs: string[];
  analysisMs: number;
}

const files = new Map<string, Loaded>();
let currentId: string | undefined;

/**
 * Changes other parts of the server (the live app link) react to:
 *  files    — the set of open files changed
 *  changed  — {file, what: 'rename'|'comment'|'typelib'|'reset', va?, name?, by}
 *  activity — {file, tool, va?, obj?, control?, view?, label}
 */
export const events = new EventEmitter();
events.setMaxListeners(50);

/** Files the app currently shows; the agent may not close those. */
export const viewedFiles = new Set<string>();

export const hex8 = (va: number) => '0x' + (va >>> 0).toString(16).toUpperCase().padStart(8, '0');

// ---- paths ------------------------------------------------------------------------

function inside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolves a path the caller wants to read and applies the --allow policy. */
export function checkReadable(p: string): string {
  const abs = path.resolve(p);
  if (!existsSync(abs)) throw new ToolError(`File not found: ${abs}. Pass an absolute path to a file on the machine this server runs on.`);
  const real = realpathSync(abs);
  checkAllowed(real);
  const st = statSync(real);
  if (st.isDirectory()) throw new ToolError(`${real} is a folder. Pass the path of a single .exe, .dll or .ocx file.`);
  if (st.size === 0) throw new ToolError(`${real} is empty.`);
  if (st.size > MAX_FILE_BYTES) throw new ToolError(`${real} is ${(st.size / 1048576).toFixed(0)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB.`);
  return real;
}

export function checkAllowed(real: string): void {
  if (!config.allowDirs.length) return;
  if (!config.allowDirs.some(d => inside(d, real))) {
    throw new ToolError(`${real} is outside the directories this server may use (${config.allowDirs.join(', ')}). Restart the server with another --allow directory to change that.`);
  }
}

/** Resolves a directory the caller wants to write into (it may not exist yet). */
export function checkWritableDir(p: string): string {
  const abs = path.resolve(p);
  // resolve symlinks on the deepest existing ancestor so the policy check can't be bypassed
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  const real = path.join(realpathSync(probe), ...tail);
  checkAllowed(real);
  return real;
}

// ---- saved renames / comments -------------------------------------------------------

function annotationPath(sha256: string): string | undefined {
  return config.stateDir ? path.join(config.stateDir, 'annotations', sha256.slice(0, 32) + '.json') : undefined;
}

function loadAnnotations(l: Loaded): void {
  const p = annotationPath(l.sha256);
  if (!p || !existsSync(p)) return;
  try {
    const saved = JSON.parse(readFileSync(p, 'utf8')) as { renames?: [number, string][]; comments?: [number, string][] };
    for (const [va, name] of saved.renames ?? []) if (typeof va === 'number' && typeof name === 'string') { l.session.rename(va, name); l.renames.set(va, name); }
    for (const [va, text] of saved.comments ?? []) if (typeof va === 'number' && typeof text === 'string') { l.session.setComment(va, text); l.comments.set(va, text); }
  } catch (e) {
    console.error(`[vblens-mcp] ignoring unreadable annotations ${p}: ${(e as Error).message}`);
  }
}

/** Writes renames/comments next to the server state; returns false when saving is off or failed. */
export function saveAnnotations(l: Loaded): boolean {
  const p = annotationPath(l.sha256);
  if (!p) return false;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    // same shape the browser app keeps in localStorage
    writeFileSync(p, JSON.stringify({ file: path.basename(l.path), sha256: l.sha256, renames: [...l.renames], comments: [...l.comments] }, null, 1));
    return true;
  } catch (e) {
    console.error(`[vblens-mcp] could not save annotations: ${(e as Error).message}`);
    return false;
  }
}

// ---- loaded files -------------------------------------------------------------------

export function listLoaded(): Loaded[] { return [...files.values()]; }
export function currentFileId(): string | undefined { return currentId; }

function newId(p: string): string {
  const base = path.basename(p).replace(/[^\w.\-]+/g, '_') || 'file';
  if (!files.has(base)) return base;
  for (let n = 2; ; n++) if (!files.has(`${base}#${n}`)) return `${base}#${n}`;
}

export function loadTypeLibFile(p: string, into?: Loaded): { name: string; classes: number; types: number } {
  const real = checkReadable(p);
  const bytes = new Uint8Array(readFileSync(real));
  let res: { name: string; classes: number; types: number };
  try {
    if (into) res = into.session.loadTypeLib(bytes);
    else { const tl = loadTypeLibFromFile(bytes); res = { name: tl.name, classes: registerTypeLib(tl).length, types: tl.types.length }; }
  } catch (e) {
    throw new ToolError(`${real} has no readable type library (${(e as Error).message}). Pass the .ocx/.tlb/.dll that defines the ActiveX control, e.g. MSCOMCTL.OCX.`);
  }
  if (into && !into.typeLibs.includes(real)) into.typeLibs.push(real);
  if (into) events.emit('changed', { file: into.id, what: 'typelib', by: 'agent' });
  return res;
}

function analyse(bytes: Uint8Array, name: string, where: string): Session {
  try {
    return new Session(bytes, name);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    throw new ToolError(`Could not analyse ${where}: ${msg} This server handles Visual Basic 5/6 binaries (native code or P-Code) only: VB.NET, packed files and other compilers are not supported.`);
  }
}

function register(bytes: Uint8Array, sha256: string, filePath: string, origin: Loaded['origin'], name: string, typeLibs: string[]): Loaded {
  if (files.size >= MAX_OPEN_FILES) {
    throw new ToolError(`${MAX_OPEN_FILES} files are already open (${[...files.keys()].join(', ')}). Close one with vb_close_file first.`);
  }
  const t0 = Date.now();
  const session = analyse(bytes, name, origin === 'app' ? name : filePath);
  const loaded: Loaded = {
    id: newId(name), path: filePath, origin, size: bytes.length, sha256, session,
    renames: new Map(), comments: new Map(), typeLibs, analysisMs: Date.now() - t0,
  };
  loadAnnotations(loaded);
  files.set(loaded.id, loaded);
  return loaded;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function openFile(p: string, opts: { reload?: boolean; typeLibs?: string[]; origin?: Loaded['origin'] } = {}): { loaded: Loaded; reused: boolean } {
  const real = checkReadable(p);
  const bytes = new Uint8Array(readFileSync(real));
  const sha256 = sha(bytes);
  // the same bytes already open (from this path, or dropped into the app): share that session
  const existing = [...files.values()].find(f => f.path === real && f.sha256 === sha256) ?? [...files.values()].find(f => f.sha256 === sha256);
  // type libraries name ActiveX controls and their members during analysis
  for (const t of opts.typeLibs ?? []) loadTypeLibFile(t, existing);
  if (existing && !opts.reload) {
    if (existing.path.startsWith('app:')) existing.path = real; // now we know where it lives
    currentId = existing.id;
    if (opts.typeLibs?.length) events.emit('changed', { file: existing.id, what: 'typelib', by: 'agent' });
    return { loaded: existing, reused: true };
  }
  if (existing) {
    // re-analyse in place: keeps the id (and the app's view of it)
    const t0 = Date.now();
    existing.session = analyse(bytes, path.basename(real), real);
    existing.analysisMs = Date.now() - t0;
    existing.renames.clear(); existing.comments.clear();
    loadAnnotations(existing);
    currentId = existing.id;
    events.emit('changed', { file: existing.id, what: 'reset', by: 'agent' });
    return { loaded: existing, reused: false };
  }
  const stale = [...files.values()].find(f => f.path === real);
  if (stale) closeFile(stale.id, true); // the file changed on disk since it was opened
  const loaded = register(bytes, sha256, real, opts.origin ?? 'agent', path.basename(real), (opts.typeLibs ?? []).map(t => path.resolve(t)));
  currentId = loaded.id;
  events.emit('files');
  return { loaded, reused: false };
}

/** A file the user dropped into the app (no path on this machine). */
export function openUpload(bytes: Uint8Array, name: string): { loaded: Loaded; reused: boolean } {
  if (!bytes.length) throw new ToolError(`${name} is empty.`);
  if (bytes.length > MAX_FILE_BYTES) throw new ToolError(`${name} is larger than ${MAX_FILE_BYTES / 1048576} MB.`);
  const sha256 = sha(bytes);
  const existing = [...files.values()].find(f => f.sha256 === sha256);
  if (existing) { currentId = existing.id; return { loaded: existing, reused: true }; }
  const safe = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '') || 'file';
  const loaded = register(bytes, sha256, 'app:' + safe, 'app', safe, []);
  currentId = loaded.id;
  events.emit('files');
  return { loaded, reused: false };
}

export function closeFile(id: string, force = false): Loaded {
  const l = getLoaded(id);
  if (!force && viewedFiles.has(l.id)) {
    throw new ToolError(`The user has ${l.id} open in the VBLens app, so it stays loaded. Open another file instead, or ask the user to close it there.`);
  }
  files.delete(l.id);
  if (currentId === l.id) currentId = [...files.keys()].pop();
  events.emit('files');
  events.emit('closed', l.id);
  return l;
}

export function findLoaded(id: string): Loaded | undefined { return files.get(id); }

// ---- edits shared by the tools and the app ---------------------------------------------

export function applyRename(l: Loaded, va: number, name: string, by: string): { saved: boolean; fullName: string } {
  l.session.rename(va, name);
  l.renames.set(va, name);
  const saved = saveAnnotations(l);
  const f = l.session.an.funcByVA.get(va);
  const fullName = f ? f.fullName : name;
  events.emit('changed', { file: l.id, what: 'rename', va, name: fullName, by });
  return { saved, fullName };
}

export function applyComment(l: Loaded, va: number, text: string, by: string): boolean {
  const t = text.replace(/[\r\n]+/g, ' ').trim();
  l.session.setComment(va, t);
  if (t) l.comments.set(va, t); else l.comments.delete(va);
  const saved = saveAnnotations(l);
  events.emit('changed', { file: l.id, what: 'comment', va, name: t, by });
  return saved;
}

/** Forget every rename and comment of a file and re-analyse it from its bytes. */
export function resetAnnotations(l: Loaded, by: string): void {
  const p = annotationPath(l.sha256);
  if (p) rmSync(p, { force: true });
  l.renames.clear(); l.comments.clear();
  l.session = new Session(l.session.img.bytes, l.session.name);
  events.emit('changed', { file: l.id, what: 'reset', by });
}

/** The file a tool call refers to: an explicit id, or the most recently opened one. */
export function getLoaded(id?: string): Loaded {
  if (!files.size) throw new ToolError('No file is open. Call vb_open_file with the path of a VB5/VB6 .exe, .dll or .ocx first.');
  if (id === undefined || id === '') return files.get(currentId!)!;
  const direct = files.get(id);
  if (direct) return direct;
  const lower = id.toLowerCase();
  const fuzzy = [...files.values()].filter(f => f.id.toLowerCase() === lower || path.basename(f.path).toLowerCase() === lower || f.path.toLowerCase() === lower);
  if (fuzzy.length === 1) return fuzzy[0];
  throw new ToolError(`No open file with id "${id}". Open files: ${[...files.keys()].join(', ')}.`);
}

// ---- resolving names and addresses -----------------------------------------------------

/** "0x401000", "401000h" or bare hex ("00401000"). Decimal is not accepted: addresses in results are always hex. */
export function parseAddress(s: string): number | undefined {
  const t = s.trim();
  const m = /^0x([0-9a-f]{1,8})$/i.exec(t) ?? /^([0-9a-f]{1,8})h$/i.exec(t) ?? /^([0-9a-f]{5,8})$/i.exec(t);
  return m ? parseInt(m[1], 16) >>> 0 : undefined;
}

export function requireAddress(l: Loaded, s: string): number {
  const va = parseAddress(s);
  if (va === undefined) throw new ToolError(`"${s}" is not an address. Use hex such as 0x00401000 (addresses in results are virtual addresses in that form).`);
  if (!l.session.img.isMapped(va)) {
    const secs = l.session.img.sections.map(x => `${x.name} ${hex8(x.va)}-${hex8(x.va + Math.max(x.vsize, x.rawSize))}`).join(', ');
    throw new ToolError(`${hex8(va)} is not inside the file's mapped sections (${secs}).`);
  }
  return va;
}

const lc = (s: string) => s.toLowerCase();

/** A procedure by "Object.Name", bare name, or any address inside it. */
export function resolveProc(l: Loaded, target: string): Func {
  const an = l.session.an;
  const t = target.trim();
  const tl = lc(t);
  const explicitAddr = /^0x/i.test(t);
  if (!explicitAddr) {
    const full = an.funcs.filter(f => lc(f.fullName) === tl);
    if (full.length === 1) return full[0];
    const short = an.funcs.filter(f => lc(f.name) === tl || f.aliases.some(a => lc(a) === tl));
    if (short.length === 1) return short[0];
    const many = full.length > 1 ? full : short;
    if (many.length > 1) {
      throw new ToolError(`"${t}" matches ${many.length} procedures: ${many.slice(0, 12).map(f => `${f.fullName} (${hex8(f.va)})`).join(', ')}${many.length > 12 ? ', …' : ''}. Pass Object.Name or the address instead.`);
    }
  }
  const va = parseAddress(t);
  if (va !== undefined) {
    const r = l.session.resolve(va);
    if (r.func !== undefined) return an.funcByVA.get(r.func)!;
    throw new ToolError(`${hex8(va)} is not inside a known procedure${r.kind !== 'none' ? ` (it is ${r.kind}${r.name ? ` ${JSON.stringify(r.name.slice(0, 60))}` : ''})` : ''}. Use vb_list_procedures or vb_search to find procedure addresses, or vb_disassemble with raw=true for arbitrary code.`);
  }
  const near = l.session.search(t, 40).filter(r => (r.kind === 'proc' || r.kind === 'event') && r.va !== undefined).slice(0, 6);
  throw new ToolError(`No procedure named "${t}".${near.length ? ` Closest: ${near.map(r => `${r.label} (${hex8(r.va!)})`).join(', ')}.` : ''} Use vb_list_procedures or vb_search to find names.`);
}

/** A form/module/class by name or by its index in vb_list_objects. */
export function resolveObject(l: Loaded, object: string): VBObject {
  const objs = l.session.project.objects;
  const t = object.trim();
  const byName = objs.filter(o => lc(o.name) === lc(t));
  if (byName.length === 1) return byName[0];
  if (/^\d+$/.test(t) && objs[Number(t)]) return objs[Number(t)];
  const near = objs.filter(o => lc(o.name).includes(lc(t))).slice(0, 8);
  throw new ToolError(`No object named "${t}".${near.length ? ` Similar: ${near.map(o => o.name).join(', ')}.` : ''} vb_list_objects lists every form, module and class.`);
}

// ---- output helpers -----------------------------------------------------------------------

export type Fmt = 'text' | 'json';
export interface ToolReply {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
}

export function reply(fmt: Fmt, text: string, data: Record<string, unknown>): ToolReply {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data };
  return { content: [{ type: 'text', text }] };
}

export interface Page<T> { total: number; offset: number; count: number; items: T[]; has_more: boolean; next_offset?: number }

/**
 * One page of `all`, shrunk (never cut mid-item) until the rendered text fits the
 * character limit, so next_offset always points at the first item left out.
 */
export function paginate<T>(all: T[], offset: number, limit: number, fmt: Fmt, render: (page: Page<T>) => { text: string; data: Record<string, unknown> }): ToolReply {
  let n = Math.min(limit, Math.max(0, all.length - offset));
  for (;;) {
    const items = all.slice(offset, offset + n);
    const next = offset + items.length;
    const page: Page<T> = { total: all.length, offset, count: items.length, items, has_more: next < all.length, ...(next < all.length ? { next_offset: next } : {}) };
    const r = render(page);
    const out = reply(fmt, r.text, r.data);
    if (out.content[0].text.length <= CHARACTER_LIMIT || n <= 1) return out;
    n = Math.ceil(n / 2);
  }
}

export function pageFooter(p: Page<unknown>, what: string): string {
  if (!p.total) return '';
  const range = `${what} ${p.offset + 1}-${p.offset + p.count} of ${p.total}.`;
  return p.has_more ? `${range} More: call again with offset=${p.next_offset}.` : range;
}

export function pageData<T>(p: Page<T>, key: string, items: unknown[]): Record<string, unknown> {
  return { total: p.total, offset: p.offset, count: p.count, has_more: p.has_more, ...(p.has_more ? { next_offset: p.next_offset } : {}), [key]: items };
}

/** Keeps one line of untrusted binary text on one line and bounded. */
export function oneLine(s: string, max = 160): string {
  const t = s.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, m => (/[\r\n\u2028\u2029]/.test(m) ? '\\n' : ' '));
  return t.length > max ? t.slice(0, max) + '\u2026' : t;
}
