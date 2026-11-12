import { useEffect, useMemo, useState } from 'react';
import type { FormControlView, FormView } from '../types';
import { I } from '../icons';

// VB system colours (Windows classic scheme)
const SYS: Record<number, string> = {
  0x00: '#d4d0c8', 0x01: '#3a6ea5', 0x02: '#0a246a', 0x03: '#808080', 0x04: '#d4d0c8', 0x05: '#ffffff', 0x06: '#000000', 0x07: '#000000',
  0x08: '#000000', 0x09: '#ffffff', 0x0a: '#d4d0c8', 0x0b: '#d4d0c8', 0x0c: '#808080', 0x0d: '#0a246a', 0x0e: '#ffffff', 0x0f: '#d4d0c8',
  0x10: '#808080', 0x11: '#808080', 0x12: '#000000', 0x13: '#d4d0c8', 0x14: '#ffffff', 0x15: '#404040', 0x16: '#d4d0c8', 0x17: '#000000', 0x18: '#ffffe1',
};
export function vbColor(v: number | undefined, def: string): string {
  if (v === undefined) return def;
  const u = v >>> 0;
  if (u & 0x80000000) return SYS[u & 0xff] ?? def;
  const r = u & 0xff, g = (u >> 8) & 0xff, b = (u >> 16) & 0xff;
  return `rgb(${r},${g},${b})`;
}
const prop = (c: FormControlView, n: string) => c.props.find(p => p.name === n)?.value;
const num = (c: FormControlView, n: string) => { const v = prop(c, n); return v === undefined ? undefined : parseInt(v, 10); };
const short = (cls: string) => cls.replace(/^VB\./, '');
const NONVISUAL = /ImageList|CommonDialog|SysInfo|Winsock|Inet|MAPI|Timer|DataEnvironment|Script|MSComm/i;

function accel(s: string) {
  // "&File" -> F underlined; "&&" -> &
  const out: React.ReactNode[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&' && s[i + 1] === '&') { out.push('&'); i++; continue; }
    if (s[i] === '&' && i + 1 < s.length) { out.push(<u key={i}>{s[i + 1]}</u>); i++; continue; }
    out.push(s[i]);
  }
  return out;
}

export interface DesignerProps {
  form: FormView;
  selected?: string; // control key name or name(index)
  onSelect: (c: FormControlView | undefined) => void;
  onOpenHandler: (va: number) => void;
}

const keyOf = (c: FormControlView) => (c.index !== undefined ? `${c.name}(${c.index})` : c.name);

export function FormDesigner({ form, selected, onSelect, onOpenHandler }: DesignerProps) {
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<string | undefined>();
  const [showHidden, setShowHidden] = useState(true);
  const [showNames, setShowNames] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | undefined>();
  const root = form.root;
  // blob URLs for pictures
  const urls = useMemo(() => {
    const m = new Map<FormControlView, Record<string, string>>();
    const walk = (c: FormControlView) => {
      if (c.pictures.length) {
        const r: Record<string, string> = {};
        for (const p of c.pictures) r[p.prop] = URL.createObjectURL(new Blob([p.bytes as BlobPart], { type: p.mime }));
        m.set(c, r);
      }
      c.children.forEach(walk);
    };
    if (root) walk(root);
    return m;
  }, [root]);
  useEffect(() => () => { for (const r of urls.values()) for (const u of Object.values(r)) URL.revokeObjectURL(u); }, [urls]);
  useEffect(() => {
    if (!openMenu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && (e.target as HTMLElement).closest?.('.win-menu')) return;
      setOpenMenu(undefined);
    };
    window.addEventListener('keydown', close, true);
    window.addEventListener('mousedown', close, true);
    return () => { window.removeEventListener('keydown', close, true); window.removeEventListener('mousedown', close, true); };
  }, [openMenu]);

  if (!root) return <div className="empty">{form.errors.join('; ') || 'No form data'}</div>;
  const menus = root.children.filter(c => short(c.className) === 'Menu');
  const ctrls = root.children.filter(c => short(c.className) !== 'Menu');
  const rtl = root.rtl;
  const scaleOf = (c: FormControlView, inherited: number) => {
    const sm = num(c, 'ScaleMode');
    if (sm === 3) return 1; // pixels
    if (sm === 1) return 1 / 15;
    if (sm === 0 && c.clientWidth) { const sw = num(c, 'ScaleWidth'); if (sw) return (c.clientWidth / 15) / sw; }
    return sm === undefined ? inherited : 1 / 15;
  };
  const rootScale = scaleOf(root, 1 / 15);
  const W = Math.max(120, Math.round((root.clientWidth ?? 4800) / 15));
  const H = Math.max(60, Math.round((root.clientHeight ?? 3600) / 15));
  const tray: FormControlView[] = [];
  const isMDI = short(root.className) === 'MDIForm';
  const isDesignerSurface = /^(UserControl|PropertyPage|UserDocument)$/.test(short(root.className));

  const renderCtl = (c: FormControlView, scale: number, parentW: number): React.ReactNode => {
    const cls = short(c.className);
    const k = keyOf(c);
    const hidden = c.visible === false;
    if (hidden && !showHidden) return null;
    const hasPos = c.left !== undefined && c.top !== undefined;
    if (cls === 'Menu') return null;
    if ((!hasPos || (c.width === undefined && cls !== 'Timer')) && (c.typeCode === 0xff || NONVISUAL.test(cls))) { tray.push(c); return null; }
    if (cls === 'Timer') { tray.push(c); return null; }
    let x = (c.left ?? 0) * scale, y = (c.top ?? 0) * scale;
    let w = (c.width ?? 1200) * scale, h = (c.height ?? 400) * scale;
    const font = c.font ?? root.font;
    const fsize = font ? Math.max(8, Math.round(font.size * 96 / 72)) : 11;
    const style: React.CSSProperties = {
      left: x, top: y, width: w, height: h,
      fontFamily: font ? `'${font.name}', Tahoma, Arial, sans-serif` : undefined,
      fontSize: fsize, fontWeight: font?.bold ? 700 : undefined, fontStyle: font?.italic ? 'italic' : undefined, textDecoration: font?.underline ? 'underline' : undefined,
      color: vbColor(c.foreColor, '#000'), opacity: hidden ? 0.45 : 1,
    };
    if (c.enabled === false) style.color = '#8a8a8a'; // disabled controls render greyed out
    const crtl = c.rtl ?? rtl;
    if (crtl) style.direction = 'rtl';
    const pics = urls.get(c) ?? {};
    let cn = 'ctl';
    let body: React.ReactNode = null;
    const label = c.caption ?? '';
    const align = c.alignment === 1 ? (crtl ? 'left' : 'right') : c.alignment === 2 ? 'center' : crtl ? 'right' : 'left';
    let kids: React.ReactNode = null;
    const inner = (sc: number) => c.children.map(ch => renderCtl(ch, sc, w));
    switch (cls) {
      case 'CommandButton':
        cn += ' button';
        style.background = num(c, 'Style') === 1 ? vbColor(c.backColor, '#d4d0c8') : undefined;
        body = <>{pics.Picture && <img src={pics.Picture} alt="" style={{ maxHeight: '70%', maxWidth: '90%' }} />}<span>{accel(label)}</span></>;
        if (pics.Picture) style.flexDirection = 'column';
        break;
      case 'TextBox': {
        cn += ' text';
        style.background = vbColor(c.backColor, '#fff');
        style.textAlign = align as 'left';
        if (num(c, 'BorderStyle') === 0) style.boxShadow = 'none';
        body = c.text ?? '';
        if (prop(c, 'MultiLine')?.startsWith('-1')) style.whiteSpace = 'pre-wrap';
        break;
      }
      case 'Label':
        cn += ' label';
        style.background = num(c, 'BackStyle') === 0 ? 'transparent' : vbColor(c.backColor, '#d4d0c8');
        style.textAlign = align as 'left';
        if (num(c, 'BorderStyle') === 1) style.boxShadow = 'inset 1px 1px #808080, inset -1px -1px #fff';
        body = accel(label);
        break;
      case 'Frame':
        cn += ' frame';
        style.background = vbColor(c.backColor, '#d4d0c8');
        body = label ? <span className="cap" style={{ [crtl ? 'right' : 'left']: 8, left: crtl ? 'auto' : 8 }}>{accel(label)}</span> : null;
        kids = inner(scale);
        break;
      case 'CheckBox': case 'OptionButton':
        cn += cls === 'CheckBox' ? ' check' : ' option';
        style.background = vbColor(c.backColor, '#d4d0c8');
        body = <><i>{c.value === 1 || c.checked ? (cls === 'CheckBox' ? '✓' : '●') : ''}</i><span style={{ flex: 1, textAlign: align as 'left' }}>{accel(label)}</span></>;
        break;
      case 'ComboBox':
        cn += ' combo';
        style.background = vbColor(c.backColor, '#fff');
        h = Math.max(h, 21); style.height = 21;
        body = c.text ?? c.list?.[0] ?? '';
        break;
      case 'ListBox':
        cn += ' list';
        style.background = vbColor(c.backColor, '#fff');
        body = (c.list ?? []).map((t, i) => <div key={i}>{t}</div>);
        break;
      case 'PictureBox':
        cn += ' pic';
        style.background = vbColor(c.backColor, '#d4d0c8');
        if (num(c, 'BorderStyle') === 0) style.boxShadow = 'none';
        if (num(c, 'Align') === 1) { style.left = 0; style.top = 0; style.width = '100%'; }
        if (num(c, 'Align') === 2) { style.left = 0; style.top = 'auto'; style.bottom = 0; style.width = '100%'; }
        body = pics.Picture ? <img src={pics.Picture} alt="" /> : null;
        kids = inner(scaleOf(c, scale));
        break;
      case 'Image':
        cn += ' img';
        body = pics.Picture ? <img src={pics.Picture} alt="" style={prop(c, 'Stretch')?.startsWith('-1') ? { width: '100%', height: '100%' } : undefined} /> : <div style={{ width: '100%', height: '100%', border: '1px dashed rgba(0,0,0,.25)' }} />;
        break;
      case 'Shape': {
        const shape = num(c, 'Shape') ?? 0;
        const bc = vbColor(num(c, 'BorderColor'), '#000');
        const fill = num(c, 'FillStyle') === 0 ? vbColor(num(c, 'FillColor'), '#000') : num(c, 'BackStyle') === 1 ? vbColor(c.backColor, '#fff') : 'transparent';
        style.border = `${num(c, 'BorderWidth') ?? 1}px solid ${bc}`;
        style.background = fill;
        if (shape === 2 || shape === 3) style.borderRadius = '50%';
        if (shape === 4 || shape === 5) style.borderRadius = 8;
        break;
      }
      case 'Line': {
        const x1 = (c.left ?? 0) * scale, y1 = (c.top ?? 0) * scale, x2 = (c.width ?? 0) * scale, y2 = (c.height ?? 0) * scale;
        x = Math.min(x1, x2); y = Math.min(y1, y2);
        Object.assign(style, { left: x - 2, top: y - 2, width: Math.abs(x2 - x1) + 4, height: Math.abs(y2 - y1) + 4, overflow: 'visible' });
        body = <svg width={Math.abs(x2 - x1) + 4} height={Math.abs(y2 - y1) + 4} style={{ display: 'block' }}><line x1={x1 - x + 2} y1={y1 - y + 2} x2={x2 - x + 2} y2={y2 - y + 2} stroke={vbColor(num(c, 'BorderColor'), '#000')} strokeWidth={num(c, 'BorderWidth') ?? 1} /></svg>;
        break;
      }
      case 'HScrollBar': case 'VScrollBar':
        cn += ' scroll';
        body = <div className={'sb ' + (cls === 'HScrollBar' ? 'h' : 'v')}><b /><b /></div>;
        break;
      default:
        if (c.typeCode === 0xff || cls.includes('.')) {
          cn += ' activex';
          body = <div><b style={{ display: 'block', fontSize: 11 }}>{c.name}</b><span style={{ opacity: 0.75 }}>{c.className}</span></div>;
          style.fontFamily = undefined; style.fontSize = undefined; style.direction = undefined;
          if (num(c, 'Align') === 1) { style.left = 0; style.top = 0; style.width = '100%'; }
          if (c.children.length) { kids = inner(scale); body = <div className="axname">{c.name} <span style={{ opacity: 0.7 }}>{c.className}</span></div>; cn += ' container'; }
        } else { cn += ' label'; body = label || cls; }
    }
    if (k === selected) cn += ' selc';
    else if (k === hover) cn += ' hov';
    void parentW;
    return (
      <div key={k + ':' + c.cId} className={cn} style={style} data-ctl={k}
        title={`${k} — ${c.className}`}
        onMouseOver={e => { e.stopPropagation(); setHover(k); }}
        onMouseOut={e => { e.stopPropagation(); setHover(h => (h === k ? undefined : h)); }}
        onClick={e => { e.stopPropagation(); setOpenMenu(undefined); onSelect(c); }}
        onDoubleClick={e => { e.stopPropagation(); const ev = c.events.find(x => /Click$/.test(x.name)) ?? c.events[0]; if (ev) onOpenHandler(ev.va); }}>
        {body}
        {kids}
        {showNames && <span className="nametag">{k}</span>}
        {c.events.length > 0 && <span className="evdot" title={`${c.events.length} event handler(s)`} />}
      </div>
    );
  };

  const client = ctrls.map(c => renderCtl(c, rootScale, W));
  const formEvents = root.events;
  const title = root.caption ?? form.name;
  const icon = urls.get(root)?.Icon;
  const findMenu = (name: string) => menus.find(m => keyOf(m) === name);
  const menuItems = (m: FormControlView, depth = 0): React.ReactNode => (
    <div className="menu-drop" style={depth ? { left: '100%', top: -4 } : undefined}>
      {m.children.map(it => {
        const cap = it.caption ?? it.name;
        if (cap === '-') return <hr key={keyOf(it)} />;
        const k = keyOf(it);
        return (
          <div key={k} className={'mi' + (k === selected ? ' on' : '') + (it.visible === false ? ' hid' : '') + (it.enabled === false ? ' dis' : '')}
            onClick={e => { e.stopPropagation(); onSelect(it); }}
            onDoubleClick={e => { e.stopPropagation(); if (it.events[0]) onOpenHandler(it.events[0].va); }}>
            <span className="ck">{it.checked ? '✓' : ''}</span>
            <span style={{ flex: 1 }}>{accel(cap)}</span>
            {prop(it, 'Shortcut') && <span className="sc">{prop(it, 'Shortcut')}</span>}
            {it.events.length > 0 && <span className="evdot static" />}
            {it.children.length > 0 && <span>▸</span>}
            {it.children.length > 0 && <div className="sub">{menuItems(it, depth + 1)}</div>}
          </div>
        );
      })}
    </div>
  );
  const borderStyle = num(root, 'BorderStyle');

  return (
    <div className="designer" data-testid="designer" onClick={() => { onSelect(root); setOpenMenu(undefined); }}>
      <div className="designer-legend" onClick={e => e.stopPropagation()}>
        <I.designer size={15} />
        <b style={{ color: 'var(--text)' }}>{form.name}</b>
        <span>{W}×{H}px</span>
        {rtl && <span className="chip amber">RTL</span>}
        <span className="chip cyan">{form.codepage}</span>
        <div className="spacer" />
        <label className="tog"><input type="checkbox" checked={showNames} onChange={e => setShowNames(e.target.checked)} /> Names</label>
        <label className="tog"><input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} /> Hidden controls</label>
        <div className="seg">
          {[0.75, 1, 1.25, 1.5].map(z => <button key={z} className={z === zoom ? 'on' : ''} onClick={() => setZoom(z)}>{Math.round(z * 100)}%</button>)}
        </div>
      </div>
      <div className="stage" style={{ zoom }}>
        <div className={'win' + (selected === keyOf(root) ? ' selw' : '') + (isDesignerSurface ? ' surface' : '')} style={{ direction: rtl ? 'rtl' : undefined }}>
          {borderStyle !== 0 && !isDesignerSurface && (
            <div className="win-title" onClick={e => { e.stopPropagation(); onSelect(root); }} onDoubleClick={() => { const ev = formEvents.find(x => x.name === 'Load') ?? formEvents[0]; if (ev) onOpenHandler(ev.va); }}>
              {icon ? <img src={icon} alt="" /> : <I.form size={14} color="#fff" />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
              <span className="wb" style={{ marginLeft: rtl ? undefined : 'auto', marginRight: rtl ? 'auto' : undefined }}><span>_</span><span>□</span><span>×</span></span>
            </div>
          )}
          {menus.length > 0 && (
            <div className="win-menu" onClick={e => e.stopPropagation()}>
              {menus.filter(m => showHidden || m.visible !== false).map(m => (
                <span key={keyOf(m)} className={(openMenu === keyOf(m) ? 'open ' : '') + (keyOf(m) === selected ? 'on ' : '') + (m.visible === false ? 'hid' : '')}
                  onClick={() => { setOpenMenu(o => (o === keyOf(m) ? undefined : keyOf(m))); onSelect(m); }}>
                  {accel(m.caption ?? m.name)}
                  {openMenu === keyOf(m) && findMenu(keyOf(m))!.children.length > 0 && menuItems(m)}
                </span>
              ))}
            </div>
          )}
          <div className="win-client" style={{ width: W, height: H, background: isMDI ? vbColor(num(root, 'BackColor') ?? root.backColor, '#808080') : vbColor(root.backColor, '#d4d0c8'), fontFamily: root.font ? `'${root.font.name}', Tahoma, sans-serif` : undefined }}>
            {urls.get(root)?.Picture && <img src={urls.get(root)!.Picture} alt="" style={{ position: 'absolute', left: 0, top: 0 }} />}
            {client}
          </div>
        </div>
        {tray.length > 0 && (
          <div className="tray" onClick={e => e.stopPropagation()}>
            <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>Non-visual</span>
            {tray.map(c => (
              <span key={keyOf(c) + c.cId} className={'trayitem' + (keyOf(c) === selected ? ' on' : '')} onClick={() => onSelect(c)} onDoubleClick={() => { if (c.events[0]) onOpenHandler(c.events[0].va); }}>
                {short(c.className) === 'Timer' ? '⏱' : '◆'} {keyOf(c)} <span className="faint">{short(c.className)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function findControl(root: FormControlView | undefined, key: string): FormControlView | undefined {
  if (!root) return undefined;
  if (keyOf(root) === key) return root;
  for (const c of root.children) { const r = findControl(c, key); if (r) return r; }
  return undefined;
}
export { keyOf as controlKey };
