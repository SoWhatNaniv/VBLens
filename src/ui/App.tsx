import { useCallback, useEffect, useRef, useState } from 'react';
import { Landing } from './Landing';
import { Workspace } from './Workspace';
import { loadTypeLibs } from './tlbstore';
import { rpc, invalidateCache, liveRpc } from './rpc';
import { connectLive, getLiveState, isLive, onLive, userBusy, type LiveTarget } from './live';
import { AppSettingsHost } from './AppSettings';
import type { Overview, TreeNode } from './types';

export interface Loaded { overview: Overview; tree: TreeNode[]; fileName: string; bytes: Uint8Array; fileId?: string; epoch?: number }

/** Replays renames/comments this browser saved for a file (standalone mode, or onto the server). */
async function replayLocal(hash: string, server?: { renames: [number, string][]; comments: [number, string][] }): Promise<boolean> {
  let changed = false;
  try {
    const saved = JSON.parse(localStorage.getItem('vblens:' + hash) ?? '{}') as { renames?: [number, string][]; comments?: [number, string][] };
    // live mode: the server's annotations win; only fill in what it does not have yet
    const hasR = new Set((server?.renames ?? []).map(x => x[0])), hasC = new Set((server?.comments ?? []).map(x => x[0]));
    for (const [va, n] of saved.renames ?? []) if (!hasR.has(va)) { await rpc.call('rename', [va, n]); changed = true; }
    for (const [va, c] of saved.comments ?? []) if (!hasC.has(va)) await rpc.call('setComment', [va, c]);
  } catch { /* ignore */ }
  return changed;
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [progress, setProgress] = useState<{ msg: string; pct: number } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [crash, setCrash] = useState<string | undefined>();
  const busy = useRef(false);
  useEffect(() => rpc.onCrash(m => setCrash(m)), []);

  const open = useCallback(async (file: File) => {
    if (busy.current) return; // one file at a time
    busy.current = true;
    if (rpc.crashed) { rpc.restart(); setCrash(undefined); }
    setError(undefined);
    if (!file.size) { setError(`${file.name} is empty or is a folder`); busy.current = false; return; }
    if (file.size > 1024 * 1024 * 1024) { setError(`${file.name} is larger than 1 GB — VB executables are far smaller; is this the right file?`); busy.current = false; return; }
    setProgress({ msg: 'Reading file', pct: 0 });
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const copy = buf.slice();
      const libs = isLive ? [] : (await loadTypeLibs()).map(l => l.bytes);
      const r = await rpc.call<{ overview: Overview; tree: TreeNode[]; file?: string }>('open', [buf, file.name, libs], (msg, pct) => setProgress({ msg, pct }), [buf.buffer]);
      invalidateCache(); // results cached for the previous file are no longer valid
      const server = isLive ? await rpc.call<{ renames: [number, string][]; comments: [number, string][] }>('annotations') : undefined;
      if (await replayLocal(r.overview.hash, server)) r.tree = await rpc.call('tree');
      setLoaded({ overview: r.overview, tree: r.tree, fileName: file.name, bytes: copy, fileId: r.file, epoch: Date.now() });
      document.title = `${file.name} — VBLens`;
    } catch (e) {
      setError(`Could not open ${file.name}: ${(e as Error).message}`);
    } finally {
      setProgress(undefined);
      busy.current = false;
    }
  }, []);

  // ---------- live mode: follow the agent across files ----------
  const [pendingShow, setPendingShow] = useState<LiveTarget | undefined>();
  const [stale, setStale] = useState(false);
  const loadedRef = useRef(loaded); loadedRef.current = loaded;
  /** Show a file that is open on the MCP server (opened by the agent or another window). */
  const attach = useCallback(async (fileId: string, show?: LiveTarget) => {
    if (busy.current) return;
    if (loadedRef.current?.fileId === fileId) { if (show) setPendingShow({ ...show }); return; }
    busy.current = true;
    setError(undefined);
    try {
      const r = await rpc.call<{ file: string; name: string; overview: Overview; tree: TreeNode[] }>('liveAttach', [fileId]);
      invalidateCache();
      setPendingShow(show);
      setLoaded({ overview: r.overview, tree: r.tree, fileName: r.name, bytes: new Uint8Array(0), fileId: r.file, epoch: Date.now() });
      document.title = `${r.name} — VBLens`;
    } catch (e) {
      setError(`Could not show ${fileId}: ${(e as Error).message}`);
    } finally { busy.current = false; }
  }, []);
  useEffect(() => {
    if (!isLive) return;
    connectLive();
    return onLive(ev => {
      const cur = loadedRef.current?.fileId;
      if (ev.type === 'restarted') { setStale(true); return; }
      if (ev.type === 'closed' && ev.data.file === cur) {
        setLoaded(undefined); setError(`${loadedRef.current?.fileName ?? 'The file'} was closed on the MCP server.`); return;
      }
      if (ev.type === 'show' && ev.data.file !== cur) { attach(ev.data.file, ev.data); return; }
      if (ev.type === 'activity' && ev.data.by === 'agent' && ev.data.file !== cur) {
        // the agent moved to another file: follow it, unless the user is busy with this one
        const follow = getLiveState().follow;
        if (!cur || (follow && !userBusy())) attach(ev.data.file, ev.data.tool === 'open' ? undefined : ev.data);
      }
    });
  }, [attach]);
  const reopen = useCallback(() => {
    if (!loaded) return;
    rpc.restart(); setCrash(undefined);
    const f = new File([loaded.bytes as BlobPart], loaded.fileName);
    setLoaded(undefined);
    open(f);
  }, [loaded, open]);

  return (
    <>
      {loaded ? <Workspace key={loaded.overview.hash + loaded.fileName + (loaded.epoch ?? '')} data={loaded} onOpen={open} onSwitch={attach}
          initialShow={pendingShow} onShown={() => setPendingShow(undefined)}
          onClose={() => { setLoaded(undefined); if (liveRpc) liveRpc.file = undefined; document.title = 'VBLens'; }} />
        : <Landing onFile={open} error={error} onAttach={attach} />}
      <AppSettingsHost />
      {stale && (
        <div className="crashbar" data-testid="live-stale">
          <span><b>The VBLens MCP server restarted.</b> This page is no longer connected to it.</span>
          <button className="btn sm primary" onClick={() => location.reload()}>Reload page</button>
        </div>
      )}
      {loaded && error && !progress && (
        <div className="crashbar" data-testid="open-error"><span>{error}</span><button className="btn sm" onClick={() => setError(undefined)}>Dismiss</button></div>
      )}
      {crash && !progress && (
        <div className="crashbar" data-testid="crashbar">
          <span><b>The analysis engine stopped.</b> {crash}. Renames and comments are saved.</span>
          {loaded && <button className="btn sm primary" onClick={reopen}>Reload {loaded.fileName}</button>}
        </div>
      )}
      {progress && (
        <div className="loading">
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="spinner" />
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>Analyzing executable…</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>Parsing structures, disassembling and naming procedures</div>
              </div>
            </div>
            <div className="progress"><div style={{ width: `${Math.round(progress.pct * 100)}%` }} /></div>
            <div className="stage">{progress.msg} · {Math.round(progress.pct * 100)}%</div>
          </div>
        </div>
      )}
    </>
  );
}
