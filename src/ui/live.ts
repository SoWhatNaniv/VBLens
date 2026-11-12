// Live mode: when the app is served by the VBLens MCP server, it uses the server's
// sessions (shared with the AI agent) instead of its own Web Worker, receives what the
// agent does as server-sent events, and reports what the user is looking at.

import { useEffect, useState } from 'react';
import { store } from './util';

interface LiveConfig { token: string; instance: string; desktop?: boolean }
const cfg = (window as unknown as { __VBLENS_LIVE__?: LiveConfig }).__VBLENS_LIVE__;

export const isLive = !!cfg;
/** Running inside the VBLens desktop app (its engine serves this page). */
export const isDesktop = !!cfg?.desktop;

export interface AppState {
  desktop: boolean;
  mcp: { on: boolean; active: boolean; url: string | null; token: string | null; lastAgentAt: number | null; preferredPort: number };
}
export const clientId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export interface ServerFile { file: string; name: string; path: string | null; origin: 'agent' | 'app'; compile: string; procedures: number }

/** Something the agent did or asked to show. */
export interface LiveTarget {
  file: string;
  kind?: 'proc' | 'object' | 'string' | 'hex';
  va?: number;
  focus?: number;
  obj?: number;
  control?: string;
  view?: string;
  note?: string;
}
export interface LiveActivity extends LiveTarget { tool: string; by: string; label: string }
export interface LiveChange { file: string; what: 'rename' | 'comment' | 'typelib' | 'reset'; va?: number; name?: string; by: string }

export type LiveEvent =
  | { type: 'activity'; data: LiveActivity }
  | { type: 'show'; data: LiveTarget }
  | { type: 'changed'; data: LiveChange }
  | { type: 'closed'; data: { file: string } }
  | { type: 'restarted' };

// ---- JSON with binary data ------------------------------------------------------------

function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const encode = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $b64: toB64(x) } : x));
const decode = (t: string) => JSON.parse(t, (_k, x) => (x && typeof x === 'object' && typeof x.$b64 === 'string' && Object.keys(x).length === 1 ? fromB64(x.$b64) : x));

export class LiveError extends Error { constructor(msg: string, readonly status: number) { super(msg); } }

async function post(path: string, body: BodyInit, type: string): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'POST', body, headers: { 'content-type': type, 'x-vblens-token': cfg!.token, 'x-vblens-client': clientId } });
  } catch {
    throw new LiveError('Lost the connection to the VBLens MCP server. Is it still running?', 0);
  }
  const text = await r.text();
  let d: { result?: unknown; error?: string };
  try { d = decode(text); } catch { throw new LiveError(text.slice(0, 200) || `HTTP ${r.status}`, r.status); }
  if (!r.ok || d.error) throw new LiveError(d.error ?? `HTTP ${r.status}`, r.status);
  return d.result;
}

export const live = {
  call: (file: string | undefined, method: string, args: unknown[]) => post('/live/rpc', encode({ file, method, args }), 'text/plain;charset=utf-8'),
  open: (bytes: Uint8Array, name: string) => post('/live/open?name=' + encodeURIComponent(name), bytes as BodyInit, 'application/octet-stream'),
  typeLib: (bytes: Uint8Array, file?: string) => post('/live/typelib' + (file ? '?file=' + encodeURIComponent(file) : ''), bytes as BodyInit, 'application/octet-stream'),
};

// ---- what the user is looking at ----------------------------------------------------------

export interface ViewReport { file: string; tab: string; kind: string; title?: string; view?: string; va?: number; cursor?: number; obj?: number; control?: string; selection?: string }
let lastReport: ViewReport | undefined;
let reportTimer: number | undefined;
export function reportView(v: Partial<ViewReport> & { file: string }, replace = true): void {
  if (!isLive) return;
  lastReport = replace ? (v as ViewReport) : { ...(lastReport ?? (v as ViewReport)), ...v };
  clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => { if (lastReport) post('/live/view', encode(lastReport), 'text/plain;charset=utf-8').catch(() => undefined); }, 80);
}
/** Re-send the last report, e.g. when this window gets focus again. */
export function rereportView(): void { if (lastReport) reportView(lastReport); }

// ---- the user is busy: don't move their view for passive "follow" updates ---------------

let lastInput = 0;
if (isLive) for (const ev of ['keydown', 'mousedown', 'wheel', 'touchstart'] as const) addEventListener(ev, () => { lastInput = Date.now(); }, { capture: true, passive: true });
export const userBusy = () => Date.now() - lastInput < 4000;

// ---- connection state and events ------------------------------------------------------------

export interface LiveState { connected: boolean; files: ServerFile[]; follow: boolean; activity?: { label: string; at: number }; app?: AppState }
let state: LiveState = { connected: false, files: [], follow: store.get('vblens.live.follow', true) };
const stateListeners = new Set<(s: LiveState) => void>();
const eventListeners = new Set<(e: LiveEvent) => void>();
function setState(p: Partial<LiveState>) { state = { ...state, ...p }; for (const l of stateListeners) l(state); }
function emit(e: LiveEvent) { for (const l of eventListeners) l(e); }

export function onLive(fn: (e: LiveEvent) => void): () => void { eventListeners.add(fn); return () => { eventListeners.delete(fn); }; }
export function useLiveState(): LiveState {
  const [s, set] = useState(state);
  useEffect(() => { stateListeners.add(set); set(state); return () => { stateListeners.delete(set); }; }, []);
  return s;
}
export function setFollow(on: boolean) { store.set('vblens.live.follow', on); setState({ follow: on }); }
export const getLiveState = () => state;

let es: EventSource | undefined;
export function connectLive(): void {
  if (!isLive || es) return;
  es = new EventSource(`/live/events?t=${encodeURIComponent(cfg!.token)}&c=${clientId}`);
  const on = <T,>(name: string, fn: (d: T) => void) => es!.addEventListener(name, ev => { try { fn(decode((ev as MessageEvent).data) as T); } catch { /* ignore bad event */ } });
  on<{ instance: string; files: ServerFile[]; app: AppState }>('hello', d => {
    setState({ connected: true, files: d.files, app: d.app });
    if (d.instance !== cfg!.instance) emit({ type: 'restarted' });
    rereportView();
  });
  on<{ files: ServerFile[] }>('files', d => setState({ files: d.files }));
  on<AppState>('appstate', d => setState({ app: d }));
  on<LiveActivity>('activity', d => { if (d.by === 'agent') setState({ activity: { label: d.label, at: Date.now() } }); emit({ type: 'activity', data: d }); });
  on<LiveTarget>('show', d => emit({ type: 'show', data: d }));
  on<LiveChange>('changed', d => { if (d.by !== 'app:' + clientId) emit({ type: 'changed', data: d }); });
  on<{ file: string }>('closed', d => emit({ type: 'closed', data: d }));
  es.onerror = () => {
    setState({ connected: false });
    // the server answered but refused our token: it is a new server process
    if (es!.readyState === EventSource.CLOSED) emit({ type: 'restarted' });
  };
  addEventListener('focus', rereportView);
}

// ---- AI agent settings dialog (opened from anywhere) ------------------------------

export function setAppState(app: AppState) { setState({ app }); }

export interface SettingsRequest { section: 'agent' }
let settingsReq: SettingsRequest | undefined;
const settingsListeners = new Set<(r: SettingsRequest | undefined) => void>();
export function openSettings(section: SettingsRequest['section'] = 'agent') {
  settingsReq = { section };
  for (const l of settingsListeners) l(settingsReq);
}
export function closeSettings() { settingsReq = undefined; for (const l of settingsListeners) l(undefined); }
export function useSettingsRequest(): SettingsRequest | undefined {
  const [r, set] = useState(settingsReq);
  useEffect(() => { settingsListeners.add(set); return () => { settingsListeners.delete(set); }; }, []);
  return r;
}
