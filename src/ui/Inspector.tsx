import { Fragment, useEffect, useState } from 'react';
import { rpc } from './rpc';
import type { FormControlView, FuncInfo, Overview } from './types';
import { I, iconFor } from './icons';

const hx = (v: number) => v.toString(16).toUpperCase().padStart(8, '0');

export function ProcInspector({ info, onNavigate, onRename, cursor }: { info?: FuncInfo; onNavigate: (va: number, newTab?: boolean) => void; onRename: () => void; cursor?: number }) {
  if (!info) return <div className="insp"><div className="muted" style={{ padding: 10 }}>Loading…</div></div>;
  return (
    <div className="insp" data-testid="inspector">
      <div className="card">
        <h4>{iconFor(info.kind === 'event' ? 'event' : 'proc', 13)} Procedure <span className="spacer" />
          <button className="btn sm ghost" onClick={onRename} title="Rename (N)"><I.tag size={13} /> Rename</button>
        </h4>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, marginBottom: 10, wordBreak: 'break-all', color: '#fff' }}>{info.fullName}</div>
        <div className="kv">
          <span className="k">Address</span><span className="v">{hx(info.va)} – {hx(info.end)}</span>
          <span className="k">Size</span><span className="v">{info.size.toLocaleString()} bytes</span>
          <span className="k">Kind</span><span className="v">{info.kind}{info.pcode ? ' · P-Code' : ''}</span>
          {info.objName && <><span className="k">Object</span><span className="v">{info.objName} <span className="muted">({info.objKind})</span></span></>}
          {info.control && <><span className="k">Control</span><span className="v">{info.control}</span></>}
          {info.event && <><span className="k">Event</span><span className="v">{info.event}</span></>}
          {info.vtable !== undefined && <><span className="k">VTable slot</span><span className="v">+0x{info.vtable.toString(16).toUpperCase()}</span></>}
          <span className="k">Arguments</span><span className="v">{info.args}</span>
          {cursor !== undefined && <><span className="k">Cursor</span><span className="v">{hx(cursor)}</span></>}
          {info.guess && <><span className="k">Attribution</span><span className="v" style={{ color: 'var(--warn)' }}>heuristic</span></>}
        </div>
        {info.aliases?.length > 0 && <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Also known as: {info.aliases.join(', ')}</div>}
      </div>
      <XList title="Called by" icon={<I.back size={13} />} items={info.callers.map(c => ({ va: c.from, label: c.name, sub: c.kind }))} onNavigate={onNavigate} empty={info.kind === 'event' ? 'Event handler — called by the VB runtime' : 'No direct calls (may be called through a vtable or late-bound)'} />
      {info.kind !== 'event' && <DeepCallers va={info.va} onNavigate={onNavigate} />}
      <XList title="Calls" icon={<I.fwd size={13} />} items={info.callees.map(c => ({ va: c.va, label: c.name }))} onNavigate={onNavigate} empty="No calls" />
      <XList title="Strings" icon={<I.str size={13} />} items={info.strings.map(s => ({ va: s.va, label: JSON.stringify(s.text) }))} onNavigate={onNavigate} empty="No string literals" str />
    </div>
  );
}

function DeepCallers({ va, onNavigate }: { va: number; onNavigate: (va: number, n?: boolean) => void }) {
  const [st, setSt] = useState<{ va: number; items?: { from: number; name: string; text: string }[]; busy?: boolean }>({ va });
  useEffect(() => setSt({ va }), [va]);
  if (st.va !== va) return null;
  if (!st.items) return (
    <div className="card" style={{ paddingTop: 10, paddingBottom: 10 }}>
      <button className="btn sm" disabled={st.busy} onClick={() => { setSt({ va, busy: true }); rpc.call<{ from: number; name: string; text: string }[]>('deepCallers', [va]).then(items => setSt(s => (s.va === va ? { va, items } : s))); }}>
        {st.busy ? <><span className="spinner sm" />Decompiling project…</> : <><I.search size={13} />Find callers in decompiled code</>}
      </button>
    </div>
  );
  return <XList title="Referenced in code" icon={<I.code size={13} />} items={st.items.map(c => ({ va: c.from, label: c.name, sub: c.text.length > 40 ? c.text.slice(0, 40) + '…' : c.text }))} onNavigate={onNavigate} empty="No references found in decompiled code" />;
}

function XList({ title, icon, items, onNavigate, empty, str }: { title: string; icon: React.ReactNode; items: { va: number; label: string; sub?: string }[]; onNavigate: (va: number, n?: boolean) => void; empty: string; str?: boolean }) {
  return (
    <div className="card">
      <h4>{icon} {title} <span className="faint" style={{ marginLeft: 'auto', letterSpacing: 0 }}>{items.length}</span></h4>
      {items.length === 0 ? <div className="faint" style={{ fontSize: 12 }}>{empty}</div> : (
        <div className="xlist">
          {items.map((x, i) => (
            <div key={i} className="xitem" onClick={e => onNavigate(x.va, e.ctrlKey || e.metaKey)} title={x.label}>
              <span className="a">{x.va.toString(16).toUpperCase()}</span>
              <span className="n" style={str ? { color: 'var(--s-str)', fontFamily: 'var(--mono)', fontSize: 11.5 } : undefined}>{x.label}</span>
              {x.sub && <span className="faint" style={{ marginLeft: 'auto', fontSize: 10.5 }}>{x.sub}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ControlInspector({ c, onNavigate, formName }: { c: FormControlView; onNavigate: (va: number) => void; formName: string }) {
  const name = c.index !== undefined ? `${c.name}(${c.index})` : c.name;
  return (
    <div className="insp" data-testid="inspector">
      <div className="card">
        <h4>{iconFor('control', 13)} Control</h4>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: '#fff' }}>{name}</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{c.className} · {formName}</div>
      </div>
      <div className="card">
        <h4><I.event size={13} /> Event handlers <span className="faint" style={{ marginLeft: 'auto' }}>{c.events.length}</span></h4>
        {c.events.length === 0 ? <div className="faint" style={{ fontSize: 12 }}>No code handles this control's events</div> : (
          <div className="xlist">
            {c.events.map(e => (
              <div key={e.va} className="xitem" onClick={() => onNavigate(e.va)}>
                <I.event size={13} /><span className="n">{name.replace(/\(\d+\)$/, '')}_{e.name}</span><span className="a" style={{ marginLeft: 'auto' }}>{e.va.toString(16).toUpperCase()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <h4><I.text size={13} /> Properties <span className="faint" style={{ marginLeft: 'auto' }}>{c.props.length}</span></h4>
        <table className="props"><tbody>
          {c.props.map((p, i) => <tr key={i}><td>{p.name}</td><td dir="auto">{p.value}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}

export function FileInspector({ ov }: { ov: Overview }) {
  return (
    <div className="insp" data-testid="inspector">
      <div className="card">
        <h4><I.file size={13} /> File</h4>
        <div className="kv">
          <span className="k">Name</span><span className="v">{ov.fileName}</span>
          <span className="k">Size</span><span className="v">{ov.fileSize.toLocaleString()} bytes</span>
          <span className="k">Hash</span><span className="v">{ov.hash}</span>
          <span className="k">Project</span><span className="v">{ov.projectName}</span>
          <span className="k">Compiled to</span><span className="v">{ov.compile}</span>
        </div>
      </div>
      <div className="card">
        <h4><I.bolt size={13} /> Shortcuts</h4>
        <div className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
          {[['Ctrl+K / Ctrl+P', 'Command palette'], ['G', 'Go to address/name'], ['N', 'Rename'], [';', 'Comment'], ['X', 'Cross references'], ['Tab', 'Code ⇄ Disassembly'], ['Space', 'Graph view'], ['Alt+← / →', 'Back / forward'], ['Ctrl+F', 'Find in view'], ['Ctrl+Shift+F', 'Search all code'], ['Alt+W', 'Close tab']].map(([k, v]) => (
            <Fragment key={k}><span className="k"><kbd>{k}</kbd></span><span className="v" style={{ fontFamily: 'var(--sans)' }}>{v}</span></Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
