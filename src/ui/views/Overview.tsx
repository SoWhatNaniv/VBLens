import type { Overview as OV } from '../types';
import { I, iconFor } from '../icons';

const hx = (v: number) => v.toString(16).toUpperCase().padStart(8, '0');
const kb = (n: number) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB');
const COLORS: Record<string, string> = { Form: '#7cb5ff', MDIForm: '#4f8cff', Module: '#3ddc97', Class: '#f5b84a', UserControl: '#ff7ab8', PropertyPage: '#c4a7ff', UserDocument: '#22d3ee', Designer: '#ffab70' };

function Donut({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <svg width={140} height={140} viewBox="0 0 140 140">
      <circle cx={70} cy={70} r={R} fill="none" stroke="#1a2130" strokeWidth={18} />
      {parts.map(p => {
        const len = (p.value / total) * C;
        const el = <circle key={p.label} cx={70} cy={70} r={R} fill="none" stroke={p.color} strokeWidth={18} strokeDasharray={`${Math.max(0, len - 2)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 70 70)" />;
        off += len;
        return el;
      })}
      <text x={70} y={68} textAnchor="middle" fill="#fff" fontSize={24} fontWeight={700}>{total}</text>
      <text x={70} y={86} textAnchor="middle" fill="#7f8aa0" fontSize={11}>objects</text>
    </svg>
  );
}

export function OverviewView({ ov, onNavigate, onOpenObjectKind, onOpen }: { ov: OV; onNavigate: (va: number) => void; onOpenObjectKind?: (k: string) => void; onOpen: (kind: string) => void }) {
  const parts = Object.entries(ov.objects).map(([k, v]) => ({ label: k, value: v, color: COLORS[k] ?? '#8f9bb3' }));
  const maxRt = Math.max(1, ...ov.topRuntime.map(r => r[1]));
  const maxLg = Math.max(1, ...ov.largest.map(r => r.size));
  const ts = ov.timestamp ? new Date(ov.timestamp * 1000) : undefined;
  return (
    <div className="ov" data-testid="overview">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div className="dz-icon" style={{ width: 54, height: 54, margin: 0 }}><I.layers size={26} color="#b7a5ff" /></div>
        <div style={{ minWidth: 0 }}>
          <h2>{ov.projectName || ov.fileName}</h2>
          <div className="sub">
            <span className={'chip ' + (ov.compile === 'P-Code' ? 'amber' : 'green')}>{ov.compile}</span>
            <span className="chip cyan">VB{ov.vbVersion ?? '6'}</span>
            {ov.exeName && <span className="chip">{ov.exeName}.exe</span>}
            <span className="mono" style={{ fontSize: 12 }}>{ov.fileName} · {kb(ov.fileSize)}</span>
            {ts && <span style={{ fontSize: 12 }}>· built {ts.toISOString().slice(0, 10)}</span>}
          </div>
          {ov.description && <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>{ov.description}</div>}
        </div>
      </div>

      <div className="stats">
        {[
          ['Procedures', ov.functions, () => undefined],
          ['Forms / objects', Object.values(ov.objects).reduce((a, b) => a + b, 0), () => undefined],
          ['Controls', ov.controls, () => undefined],
          ['Strings', ov.strings, () => onOpen('strings')],
          ['API declares', ov.declares, () => onOpen('declares')],
          ['References', ov.components.length, () => onOpen('components')],
          ['Instructions', ov.instructions.toLocaleString(), () => undefined],
          ['Analysis time', `${(ov.analysisMs / 1000).toFixed(2)} s`, () => undefined],
        ].map(([l, n, f]) => (
          <div key={l as string} className="stat" style={{ cursor: 'pointer' }} onClick={f as () => void}>
            <div className="n">{n as string}</div>
            <div className="l">{l as string}</div>
          </div>
        ))}
      </div>

      <div className="grid3">
        <div className="box">
          <h3><I.layers size={15} /> Project composition</h3>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <Donut parts={parts} />
            <div className="legend">
              {parts.map(p => (
                <div key={p.label} style={{ cursor: 'pointer' }} onClick={() => onOpenObjectKind?.(p.label)}>
                  <span className="dot" style={{ background: p.color }} />{p.label} <span className="muted">· {p.value}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="kv" style={{ marginTop: 14 }}>
            <span className="k">Image base</span><span className="v">{hx(ov.imageBase)}</span>
            <span className="k">Entry point</span><span className="v t-link" onClick={() => onNavigate(ov.entryPoint)}>{hx(ov.entryPoint)}</span>
            <span className="k">VB header</span><span className="v t-link" onClick={() => onOpen('hex:' + ov.headerVA)}>{hx(ov.headerVA)}</span>
            {ov.subMain ? <><span className="k">Sub Main</span><span className="v t-link" onClick={() => onNavigate(ov.subMain!)}>{hx(ov.subMain)}</span></> : null}
            <span className="k">Runtime</span><span className="v">MSVBVM60 {ov.runtimeBuild ? `build ${ov.runtimeBuild}` : ''}</span>
            <span className="k">LCID</span><span className="v">{ov.lcid}</span>
            {ov.projectGuid && <><span className="k">GUID</span><span className="v" title={ov.projectGuid}>{ov.projectGuid}</span></>}
            {ov.pathInformation && <><span className="k">Source path</span><span className="v" title={ov.pathInformation}>{ov.pathInformation}</span></>}
          </div>
        </div>
        <div className="box">
          <h3><I.bolt size={15} /> Most used runtime functions</h3>
          {ov.topRuntime.slice(0, 12).map(([n, c]) => (
            <div key={n} className="bar-row" style={{ gridTemplateColumns: 'minmax(90px, 150px) 1fr 44px' }}>
              <span className="nm" title={n}>{n}</span>
              <div className="bar"><div style={{ width: `${(c / maxRt) * 100}%` }} /></div>
              <span className="ct">{c}</span>
            </div>
          ))}
        </div>
        <div className="box">
          <h3><I.cpu size={15} /> Largest procedures</h3>
          {ov.largest.map(l => (
            <div key={l.va} className="bar-row" style={{ gridTemplateColumns: '1fr 70px 50px', cursor: 'pointer' }} onClick={() => onNavigate(l.va)} title={l.name}>
              <span className="nm">{l.name}</span>
              <div className="bar"><div style={{ width: `${(l.size / maxLg) * 100}%` }} /></div>
              <span className="ct">{kb(l.size)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="box">
          <h3><I.ref size={15} /> Referenced components</h3>
          {ov.components.length === 0 && <div className="muted">No ActiveX references.</div>}
          {ov.components.map((c, i) => (
            <div key={i} className="xitem" style={{ cursor: 'default' }}>
              {iconFor('components')}
              <span className="n"><b>{c.name || c.progId}</b> <span className="muted">{c.file}</span></span>
              <span className="a" style={{ marginLeft: 'auto' }}>{c.progId}</span>
            </div>
          ))}
        </div>
        <div className="box">
          <h3><I.hex size={15} /> Sections</h3>
          <table className="props">
            <tbody>
              {ov.sections.map(s => (
                <tr key={s.name + s.va}><td>{s.name} {s.exec && <span className="chip green" style={{ marginLeft: 6 }}>exec</span>}</td><td>{hx(s.va)} · {kb(s.vsize)}</td></tr>
              ))}
            </tbody>
          </table>
          {ov.apiLibs.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}><I.api size={15} /> Declared DLLs</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {ov.apiLibs.map(([l, n]) => <span key={l} className="chip cyan" style={{ cursor: 'pointer' }} onClick={() => onOpen('declares')}>{l} · {n}</span>)}
              </div>
            </>
          )}
        </div>
      </div>
      {ov.warnings.length > 0 && (
        <div className="box" style={{ marginTop: 14 }}>
          <h3><I.shield size={15} /> Analysis notes</h3>
          {ov.warnings.map((w, i) => <div key={i} className="muted mono" style={{ fontSize: 11.5, padding: '2px 0' }}>{w}</div>)}
        </div>
      )}
    </div>
  );
}
