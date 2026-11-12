import { useEffect, useMemo, useRef, useState } from 'react';
import { VirtualList, VirtualListHandle } from './VirtualList';
import { rpc } from '../rpc';

const hx8 = (v: number) => v.toString(16).toUpperCase().padStart(8, '0');
const h2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

export interface Section { name: string; va: number; size: number }

export function HexView({ sections, focusVA, onNavigate, onCursor }: { sections: Section[]; focusVA?: number; onNavigate: (va: number) => void; onCursor?: (va: number) => void }) {
  const secOf = (va?: number) => Math.max(0, sections.findIndex(s => va !== undefined && va >= s.va && va < s.va + s.size));
  const [sec, setSec] = useState(() => secOf(focusVA));
  const [bytes, setBytes] = useState<Uint8Array | undefined>();
  const [sel, setSel] = useState<number | undefined>(focusVA);
  const [hover, setHover] = useState<number | undefined>();
  const list = useRef<VirtualListHandle>(null);
  const s = sections[sec];
  useEffect(() => {
    setBytes(undefined);
    if (!s) return;
    rpc.call<{ va: number; bytes: Uint8Array }>('hexDump', [s.va, Math.min(s.size, 32 << 20)]).then(r => setBytes(r.bytes));
  }, [sec]); // eslint-disable-line
  useEffect(() => {
    if (focusVA === undefined) return;
    const i = secOf(focusVA);
    if (i !== sec) setSec(i);
    setSel(focusVA);
    centerNext.current = true;
  }, [focusVA]); // eslint-disable-line
  const centerNext = useRef(true);
  useEffect(() => {
    if (!bytes || sel === undefined || !s) return;
    const c = centerNext.current;
    centerNext.current = false;
    if (sel >= s.va && sel < s.va + bytes.length) setTimeout(() => list.current?.scrollToIndex(Math.floor((sel - s.va) / 16), c), 20);
  }, [bytes, sel === undefined ? -1 : Math.floor(sel / 16)]); // eslint-disable-line
  const rows = bytes ? Math.ceil(bytes.length / 16) : 0;
  const inspect = useMemo(() => {
    if (!bytes || sel === undefined || !s) return undefined;
    const o = sel - s.va;
    if (o < 0 || o >= bytes.length) return undefined;
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const g = (n: number, f: () => number | bigint) => (o + n <= bytes.length ? String(f()) : '—');
    return [
      ['u8 / i8', g(1, () => dv.getUint8(o)) + ' / ' + g(1, () => dv.getInt8(o))],
      ['u16 / i16', g(2, () => dv.getUint16(o, true)) + ' / ' + g(2, () => dv.getInt16(o, true))],
      ['u32', g(4, () => dv.getUint32(o, true)) + (o + 4 <= bytes.length ? ` (0x${hx8(dv.getUint32(o, true))})` : '')],
      ['i32', g(4, () => dv.getInt32(o, true))],
      ['float', g(4, () => +dv.getFloat32(o, true).toPrecision(7))],
      ['double', g(8, () => +dv.getFloat64(o, true).toPrecision(12))],
    ];
  }, [bytes, sel]); // eslint-disable-line
  const ptr = inspect && bytes && sel !== undefined && s && sel - s.va + 4 <= bytes.length ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(sel - s.va, true) : undefined;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }} data-testid="hex">
      <div className="tbl-tools">
        <div className="seg">
          {sections.map((x, i) => <button key={x.name + i} className={i === sec ? 'on' : ''} onClick={() => setSec(i)}>{x.name || `sec${i}`}</button>)}
        </div>
        <span className="muted mono" style={{ fontSize: 11.5 }}>{s ? `${hx8(s.va)} – ${hx8(s.va + s.size)}` : ''}</span>
        <div className="spacer" />
        {sel !== undefined && <span className="mono" style={{ fontSize: 12 }}>sel {hx8(sel)}</span>}
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {!bytes ? <div className="empty"><div className="spinner" /></div> : (
            <VirtualList ref={list} className="code hex" count={rows} rowHeight={20}
              onKeyDown={e => {
                const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 16, ArrowUp: -16, PageDown: 256, PageUp: -256 }[e.key];
                if (!d && e.key !== 'Home' && e.key !== 'End') return;
                e.preventDefault();
                // no selection yet: start at the first byte on screen
                const top = Math.floor((list.current?.el()?.scrollTop ?? 0) / 20) * 16;
                const base = sel ?? s.va + top - (d ?? 0);
                const n = e.key === 'Home' ? s.va : e.key === 'End' ? s.va + bytes.length - 1 : Math.max(s.va, Math.min(s.va + bytes.length - 1, base + d!));
                setSel(n); onCursor?.(n);
              }}
              render={(i, top) => {
                const base = i * 16;
                const cells: React.ReactNode[] = [];
                const asc: React.ReactNode[] = [];
                for (let k = 0; k < 16; k++) {
                  const o = base + k;
                  if (o >= bytes.length) break;
                  const v = bytes[o];
                  const a = s.va + o;
                  const cls = (v === 0 ? 'z ' : '') + (a === sel ? 'hs ' : '') + (a === hover ? 'hh' : '');
                  cells.push(<span key={k} className={cls} onMouseEnter={() => setHover(a)} onClick={() => { setSel(a); onCursor?.(a); }}>{h2(v)}{k === 7 ? '  ' : ' '}</span>);
                  asc.push(<span key={k} className={cls} onMouseEnter={() => setHover(a)} onClick={() => { setSel(a); onCursor?.(a); }}>{v >= 32 && v < 127 ? String.fromCharCode(v) : '·'}</span>);
                }
                return (
                  <div key={i} className="cl" style={{ top }}>
                    <span className="addr" style={{ width: 96 }}>{hx8(s.va + base)}</span>
                    <span className="hx">{cells}</span>
                    <span className="asc">{asc}</span>
                  </div>
                );
              }} />
          )}
        </div>
        {inspect && (
          <div className="hexinsp">
            <h4>Data inspector</h4>
            <table className="props"><tbody>{inspect.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
            {ptr !== undefined && <button className="btn sm" style={{ marginTop: 10 }} onClick={() => onNavigate(ptr)}>Follow pointer {hx8(ptr)}</button>}
          </div>
        )}
      </div>
    </div>
  );
}
