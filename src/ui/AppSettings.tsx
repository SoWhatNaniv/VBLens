// AI agent (MCP) settings of the desktop app: the switch, the connection command and the token.

import { useEffect, useState } from 'react';
import { I } from './icons';
import { closeSettings, live, setAppState, useLiveState, useSettingsRequest, type AppState } from './live';
import { useRestoreFocus } from './Overlays';
import { copyText } from './util';

function useCopy(): [string | undefined, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string>();
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(undefined), 1600); return () => clearTimeout(t); }, [copied]);
  return [copied, (key, text) => { void copyText(text).then(ok => ok && setCopied(key)); }];
}

function AgentSection({ app }: { app: AppState | undefined }) {
  const [copied, copy] = useCopy();
  const [busy, setBusy] = useState(false);
  const [showTok, setShowTok] = useState(false);
  const [err, setErr] = useState<string>();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 5000); return () => clearInterval(t); }, []);
  if (!app) return <div className="muted">Connecting…</div>;
  const m = app.mcp;
  const set = async (on: boolean) => {
    setBusy(true); setErr(undefined);
    try { setAppState(await live.call(undefined, 'setMcp', [on]) as AppState); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const newToken = async () => {
    if (!confirm('Make a new token? Agents set up with the current one will need the new connection command.')) return;
    setAppState(await live.call(undefined, 'newMcpToken', []) as AppState);
  };
  const cmd = m.url && m.token ? `claude mcp add --transport http vblens ${m.url} --header "Authorization: Bearer ${m.token}"` : '';
  const json = m.url && m.token ? JSON.stringify({ mcpServers: { vblens: { url: m.url, headers: { Authorization: `Bearer ${m.token}` } } } }, null, 2) : '';
  const recent = m.lastAgentAt && Date.now() - m.lastAgentAt < 60_000;
  const port = m.url ? Number(new URL(m.url).port) : m.preferredPort;
  return (
    <div className="agent">
      <p className="muted" style={{ marginTop: 0 }}>Let AI agents such as Claude Code use VBLens: they open files, read the decompiled code, rename things and show you what they found, live in this window.</p>
      <label className="switchrow">
        <span>
          <b>Allow AI agents (MCP)</b>
          <span className="muted">{!m.on ? 'Off — agents cannot connect.' : recent ? 'An agent is connected.' : 'On — waiting for an agent to connect.'}</span>
        </span>
        <button role="switch" aria-checked={m.on} className={'switch' + (m.on ? ' on' : '')} disabled={busy} onClick={() => set(!m.on)} data-testid="mcp-switch"><span /></button>
      </label>
      {err && <div className="field-err">{err}</div>}
      {m.on && cmd && (
        <>
          {port !== m.preferredPort && <div className="lic-reason warnbox">Port {m.preferredPort} was in use, so VBLens is on port {port} this time. Agents set up with port {m.preferredPort} need the command below again.</div>}
          <div className="agent-h">Claude Code — run once in a terminal:</div>
          <div className="codebox" data-testid="mcp-command"><code>{showTok ? cmd : cmd.replace(m.token!, '•'.repeat(12))}</code>
            <button className="btn sm" onClick={() => copy('cmd', cmd)}>{copied === 'cmd' ? <><I.check size={13} />Copied</> : <><I.copy size={13} />Copy</>}</button></div>
          <div className="agent-h">Cursor, VS Code and other MCP clients (JSON config):</div>
          <div className="codebox"><code>{showTok ? json : json.replace(m.token!, '•'.repeat(12))}</code>
            <button className="btn sm" onClick={() => copy('json', json)}>{copied === 'json' ? <><I.check size={13} />Copied</> : <><I.copy size={13} />Copy</>}</button></div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="faint" style={{ fontSize: 11.5 }}>Only programs on this computer can connect, and they need the token.</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm ghost" onClick={() => setShowTok(v => !v)}>{showTok ? 'Hide token' : 'Show token'}</button>
              <button className="btn sm ghost" onClick={newToken}>New token</button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** The AI agent settings dialog, opened from anywhere through openSettings(). */
export function AppSettingsHost() {
  const req = useSettingsRequest();
  if (!req) return null;
  return <AppSettingsDialog />;
}

function AppSettingsDialog() {
  useRestoreFocus();
  const st = useLiveState();
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeSettings(); } };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, []);
  return (
    <div className="overlay" onMouseDown={closeSettings}>
      <div className="dialog wide settings" role="dialog" aria-label="AI agent settings" onMouseDown={e => e.stopPropagation()} data-testid="settings">
        <div className="set-head">
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><I.robot size={16} />AI agent (MCP)</h3>
          <button className="btn sm icon ghost" onClick={closeSettings} title="Close (Esc)"><I.x size={14} /></button>
        </div>
        <AgentSection app={st.app} />
      </div>
    </div>
  );
}
