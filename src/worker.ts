/// <reference lib="webworker" />
// Analysis worker: owns the Session and answers RPC requests from the UI.
import { Session } from './core/session';
import { loadTypeLibFromFile } from './core/typelib/msft';
import { registerTypeLib } from './core/data/vbclasses';

let session: Session | undefined;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

type Req = { id: number; method: string; args: unknown[] };

ctx.onmessage = (ev: MessageEvent<Req>) => {
  const { id, method, args } = ev.data;
  const progress = (msg: string, pct: number) => ctx.postMessage({ id, progress: { msg, pct } });
  try {
    let result: unknown;
    if (method === 'open') {
      const [bytes, name, libs] = args as [Uint8Array, string, Uint8Array[] | undefined];
      // remembered type libraries name ActiveX controls/members during analysis
      for (const l of libs ?? []) { try { registerTypeLib(loadTypeLibFromFile(l)); } catch { /* skip bad file */ } }
      // keep the current session until the new file has been analysed successfully
      const next = new Session(bytes, name, progress);
      session = next;
      result = { overview: session.overview(), tree: session.tree() };
    } else {
      if (!session) throw new Error('No file loaded');
      const fn = (session as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
      if (typeof fn !== 'function') throw new Error(`Unknown method ${method}`);
      result = method === 'exportZip' ? fn.call(session, progress) : fn.apply(session, args);
    }
    const transfer: Transferable[] = [];
    if (result instanceof Uint8Array) transfer.push(result.buffer);
    ctx.postMessage({ id, result }, transfer);
  } catch (e) {
    ctx.postMessage({ id, error: (e as Error).message ?? String(e) });
  }
};
