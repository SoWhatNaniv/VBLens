// Promise-based RPC to the analysis engine: the in-page Web Worker, or (live mode) the
// VBLens MCP server that served this page, whose sessions are shared with an AI agent.
import AnalysisWorker from '../worker?worker&inline';
import { isLive, live, LiveError } from './live';
import { loadTypeLibs } from './tlbstore';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; progress?: (msg: string, pct: number) => void };

class Rpc {
  private w!: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private crashListeners = new Set<(msg: string) => void>();
  crashed: string | undefined;
  constructor() { this.start(); }
  private start() {
    this.crashed = undefined;
    this.w = new AnalysisWorker();
    this.w.onmessage = (ev: MessageEvent) => {
      const { id, result, error, progress } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (progress) { p.progress?.(progress.msg, progress.pct); return; }
      this.pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(result);
    };
    this.w.onerror = (e) => { e.preventDefault?.(); this.fail(e.message || 'The analysis engine crashed'); };
    this.w.onmessageerror = () => this.fail('The analysis engine sent an unreadable message');
  }
  /** The worker died (crash, out of memory, terminated): fail everything in flight. */
  private fail(msg: string) {
    if (this.crashed) return;
    this.crashed = msg;
    for (const p of this.pending.values()) p.reject(new Error(msg));
    this.pending.clear();
    try { this.w.terminate(); } catch { /* already gone */ }
    for (const l of this.crashListeners) l(msg);
  }
  onCrash(l: (msg: string) => void) { this.crashListeners.add(l); return () => { this.crashListeners.delete(l); }; }
  /** Start a fresh worker (the previous session is lost). */
  restart() { try { this.w.terminate(); } catch { /* ignore */ } this.pending.clear(); this.start(); }
  /** Test hook: simulate the worker dying. */
  simulateCrash() { this.fail('The analysis engine stopped (simulated)'); }
  call<T = any>(method: string, args: unknown[] = [], progress?: (msg: string, pct: number) => void, transfer: Transferable[] = []): Promise<T> {
    if (this.crashed) return Promise.reject(new Error(this.crashed));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      try { this.w.postMessage({ id, method, args }, transfer); } catch (e) { this.pending.delete(id); reject(e as Error); }
    });
  }
}

/** Same interface as Rpc, backed by the MCP server. */
class LiveRpc {
  crashed: string | undefined;
  /** Server-side id of the file this window shows. */
  file: string | undefined;
  private libsSent = false;
  onCrash(_l: (msg: string) => void) { return () => undefined; }
  restart() { /* nothing to restart: the server owns the sessions */ }
  simulateCrash() { /* not applicable */ }
  async call<T = any>(method: string, args: unknown[] = [], progress?: (msg: string, pct: number) => void): Promise<T> {
    if (method === 'open') {
      const [bytes, name] = args as [Uint8Array, string];
      if (!this.libsSent) {
        // type libraries remembered in this browser help name ActiveX members during analysis
        this.libsSent = true;
        for (const l of await loadTypeLibs()) { try { await live.typeLib(l.bytes); } catch { /* skip */ } }
      }
      progress?.('Uploading to the MCP server and analysing', 0.3);
      const r = await live.open(bytes, name) as { file: string };
      this.file = r.file;
      return r as T;
    }
    if (method === 'liveAttach') {
      const r = await live.call(undefined, 'liveAttach', args) as { file: string };
      this.file = r.file;
      return r as T;
    }
    if (method === 'loadTypeLib') return live.typeLib(args[0] as Uint8Array, this.file) as Promise<T>;
    progress?.('Working on the MCP server', 0.5);
    return live.call(this.file, method, args) as Promise<T>;
  }
}

export const rpc: Rpc | LiveRpc = isLive ? new LiveRpc() : new Rpc();
export const liveRpc = isLive ? (rpc as LiveRpc) : undefined;
export { LiveError };
(window as unknown as { __vblens?: unknown }).__vblens = { simulateCrash: () => rpc.simulateCrash() };

// --- cached query hook -------------------------------------------------------
import { useEffect, useState } from 'react';

const cache = new Map<string, unknown>();
let generation = 0;
/** Drop all cached results (after renames / type library loads). */
export function invalidateCache() { cache.clear(); generation++; }

export function useRpc<T>(method: string | undefined, args: unknown[], gen = 0): { data?: T; error?: string; loading: boolean } {
  const key = method ? method + ':' + JSON.stringify(args) + ':' + gen : '';
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>(() => ({ key, data: cache.get(key) as T | undefined }));
  useEffect(() => {
    if (!method) return;
    if (cache.has(key)) { setState({ key, data: cache.get(key) as T }); return; }
    let live = true;
    setState(s => ({ key, data: s.key === key ? s.data : undefined }));
    rpc.call<T>(method, args).then(d => { cache.set(key, d); if (live) setState({ key, data: d }); }, e => { if (live) setState({ key, error: (e as Error).message }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = state.key === key;
  return { data: fresh ? state.data : (cache.get(key) as T | undefined), error: fresh ? state.error : undefined, loading: !!method && !(fresh && (state.data !== undefined || state.error)) && !cache.has(key) };
}
export const rpcGeneration = () => generation;
