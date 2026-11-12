import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { I, Logo } from './icons';
import { isDesktop, isLive, openSettings, useLiveState } from './live';

/** Animated "hex rain" background. */
function HexField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    const cols: { y: number; speed: number; chars: string[] }[] = [];
    const fs = 14;
    const resize = () => {
      c.width = c.clientWidth * devicePixelRatio;
      c.height = c.clientHeight * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      const n = Math.ceil(c.clientWidth / (fs * 1.9));
      cols.length = 0;
      for (let i = 0; i < n; i++) cols.push({ y: Math.random() * c.clientHeight, speed: 0.25 + Math.random() * 0.6, chars: Array.from({ length: 40 }, () => rnd()) });
    };
    const rnd = () => Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0');
    const draw = () => {
      ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
      ctx.font = `${fs}px JetBrains Mono, monospace`;
      cols.forEach((col, i) => {
        col.y += col.speed;
        if (col.y > c.clientHeight + 40 * fs) col.y = -Math.random() * 400;
        const x = i * fs * 1.9;
        for (let k = 0; k < col.chars.length; k++) {
          const y = col.y - k * fs * 1.25;
          if (y < -20 || y > c.clientHeight + 20) continue;
          const a = Math.max(0, 1 - k / col.chars.length) * 0.5;
          const t = i / cols.length;
          ctx.fillStyle = `rgba(${Math.round(139 * (1 - t) + 34 * t)},${Math.round(108 * (1 - t) + 211 * t)},${Math.round(255 * (1 - t) + 238 * t)},${k === 0 ? 0.9 : a * 0.55})`;
          ctx.fillText(col.chars[k], x, y);
        }
        if (Math.random() < 0.02) col.chars[Math.floor(Math.random() * col.chars.length)] = rnd();
      });
      raf = requestAnimationFrame(draw);
    };
    // honour "reduce motion": a single still frame instead of the animation
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const frame = draw;
    resize();
    if (still) { frame(); cancelAnimationFrame(raf); } else frame();
    const onResize = () => { resize(); if (still) { frame(); cancelAnimationFrame(raf); } };
    addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', onResize); };
  }, []);
  return <canvas className="bg" ref={ref} />;
}

/** Live mode: the connection to the MCP server and the files open there. */
function LivePanel({ onAttach }: { onAttach: (file: string) => void }) {
  const st = useLiveState();
  if (isDesktop) {
    const m = st.app?.mcp;
    return (
      <div className="live-panel desk" data-testid="live-panel">
        <div className="lp-head">
          <button className={'chip live' + (m?.active ? ' ready' : '')} onClick={() => openSettings('agent')} data-testid="landing-agent">
            <I.robot size={13} /><span className="lbl">{m?.active ? 'AI agents can connect' : 'AI agent off'}</span>
          </button>
          <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{st.connected ? 'Ready' : 'Starting…'}</span>
        </div>
        {st.files.length > 0 && (
          <>
            <div className="lp-sub">Open files (also visible to your AI agent):</div>
            {st.files.map(f => (
              <button key={f.file} className="lp-file" onClick={() => onAttach(f.file)} data-testid="live-file">
                <I.file size={15} /><span className="mono">{f.name}</span>
                <span className="faint">{f.compile} · {f.procedures} procs · {f.origin === 'agent' ? 'opened by the agent' : 'opened here'}</span>
              </button>
            ))}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="live-panel" data-testid="live-panel">
      <div className="lp-head">
        <span className={'live-dot' + (st.connected ? ' on' : '')} />
        {st.connected ? <>Connected to the VBLens MCP server</> : <>Connecting to the VBLens MCP server…</>}
      </div>
      {st.files.length ? (
        <>
          <div className="lp-sub">Files open on the server — click one to view it:</div>
          {st.files.map(f => (
            <button key={f.file} className="lp-file" onClick={() => onAttach(f.file)} data-testid="live-file">
              <I.file size={15} /><span className="mono">{f.name}</span>
              <span className="faint">{f.compile} · {f.procedures} procs · {f.origin === 'agent' ? 'opened by the agent' : 'dropped in the app'}</span>
            </button>
          ))}
        </>
      ) : (
        <div className="lp-sub">No files yet. Ask your AI agent to open one — it will appear here — or drop a file below.</div>
      )}
    </div>
  );
}

export function Landing({ onFile, error, onAttach }: { onFile: (f: File) => void; error?: string; onAttach?: (file: string) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const fit = useRef<HTMLDivElement>(null);
  // the start page always fits the window: shrink it instead of scrolling
  useLayoutEffect(() => {
    const p = page.current, f = fit.current;
    if (!p || !f) return;
    const apply = () => {
      const s = Math.max(0.35, Math.min(1, (p.clientHeight - 16) / f.offsetHeight, (p.clientWidth - 16) / f.offsetWidth));
      f.style.setProperty('--fit', String(Math.floor(s * 1000) / 1000));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(p); ro.observe(f);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); };
    addEventListener('dragover', prevent);
    addEventListener('drop', prevent);
    return () => { removeEventListener('dragover', prevent); removeEventListener('drop', prevent); };
  }, []);
  return (
    <div className="landing" ref={page}>
      <HexField />
      <div className="glow" />
      <div className="glow b" />
      <div className="fit" ref={fit} data-testid="landing-fit">
      <div className="hero">
        <div className="logo-row"><Logo size={54} /></div>
        <h1>VB<span className="grad-text">Lens</span></h1>
        <div className="tag">
          A disassembler and decompiler for Visual Basic 5/6 executables.
          Native code and P-Code, forms, controls and events — reconstructed {isDesktop ? 'on your computer' : 'right in your browser'}.
        </div>
        {isLive && onAttach && <LivePanel onAttach={onAttach} />}
        <div
          className={'dropzone' + (over ? ' over' : '')}
          onClick={() => input.current?.click()}
          onDragEnter={e => { e.preventDefault(); setOver(true); }}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
          data-testid="dropzone"
        >
          <div className="dz-icon"><I.upload size={30} color="#b7a5ff" /></div>
          <div className="big">Drop a VB5/VB6 .exe, .dll or .ocx here</div>
          <div className="small">{isDesktop ? 'or click to browse — the file is only read, never run' : isLive ? 'or click to browse — it is analysed by the MCP server, so your agent sees it too' : 'or click to browse — the file never leaves your machine'}</div>
          <input ref={input} type="file" accept=".exe,.dll,.ocx,.scr,.bin,*/*" hidden data-testid="file-input"
            onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
        </div>
        {error && <div className="err-banner" style={{ marginTop: 18 }}>{error}</div>}
        <div className="features">
          <div className="feature"><I.cpu color="#b7a5ff" /><b>Native → VB</b><span>Symbolic execution of x86 rebuilds statements, If/Loop/For blocks and runtime calls.</span></div>
          <div className="feature"><I.designer color="#6fe3f5" /><b>Form designer</b><span>Forms, controls, menus and embedded pictures rendered as they looked.</span></div>
          <div className="feature"><I.graph color="#6fe8b2" /><b>Graph & xrefs</b><span>Control-flow graphs, cross references, strings, imports and API declares.</span></div>
          <div className="feature"><I.download color="#f7c873" /><b>Export project</b><span>Save a .vbp with .frm/.bas/.cls sources and extracted resources.</span></div>
        </div>
      </div>
      <div className="foot">{isDesktop ? 'Runs entirely on this computer' : isLive ? 'Live with your AI agent through the VBLens MCP server' : 'Free & open source · runs in your browser'} · keyboard first: <kbd>Ctrl</kbd> <kbd>K</kbd></div>
      </div>
    </div>
  );
}
