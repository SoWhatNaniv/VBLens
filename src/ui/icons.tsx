// Inline SVG icon set (no external assets so the single-file build works offline).
import type { CSSProperties } from 'react';

type P = { size?: number; color?: string; style?: CSSProperties; className?: string };
const S = ({ size = 16, color = 'currentColor', style, className, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>{children}</svg>
);

export const Logo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" className="logo-mark">
    <defs>
      <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8b6cff" /><stop offset="1" stopColor="#22d3ee" /></linearGradient>
    </defs>
    <rect width="64" height="64" rx="15" fill="#11162a" stroke="url(#lg)" strokeOpacity=".5" />
    <path d="M13 18l10 28 10-28" stroke="url(#lg)" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M39 18v28h6a7 7 0 000-14h-6" stroke="url(#lg)" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const I = {
  chevron: (p: P) => <S {...p}><path d="M9 6l6 6-6 6" /></S>,
  folder: (p: P) => <S {...p} color={p.color ?? '#e9b44c'}><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></S>,
  form: (p: P) => <S {...p} color={p.color ?? '#7cb5ff'}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><circle cx="6.5" cy="6.5" r=".6" fill="currentColor" /></S>,
  module: (p: P) => <S {...p} color={p.color ?? '#3ddc97'}><path d="M4 4h10l6 6v10H4z" /><path d="M14 4v6h6" /><path d="M8 14h8M8 17h5" /></S>,
  cls: (p: P) => <S {...p} color={p.color ?? '#f5b84a'}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></S>,
  uc: (p: P) => <S {...p} color={p.color ?? '#ff7ab8'}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12h8M12 8v8" /></S>,
  proc: (p: P) => <S {...p} color={p.color ?? '#c4a7ff'}><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" /></S>,
  event: (p: P) => <S {...p} color={p.color ?? '#22d3ee'}><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></S>,
  control: (p: P) => <S {...p} color={p.color ?? '#8f9bb3'}><rect x="4" y="7" width="16" height="10" rx="2" /><path d="M8 12h8" /></S>,
  overview: (p: P) => <S {...p} color={p.color ?? '#8b6cff'}><path d="M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z" /></S>,
  api: (p: P) => <S {...p} color={p.color ?? '#ffab70'}><path d="M4 12h4l2-6 4 12 2-6h4" /></S>,
  ref: (p: P) => <S {...p} color={p.color ?? '#4fd6e4'}><path d="M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" /><path d="M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" /></S>,
  str: (p: P) => <S {...p} color={p.color ?? '#a5e07a'}><path d="M7 7h4v4H7c0 3 1 4 3 5M14 7h4v4h-4c0 3 1 4 3 5" /></S>,
  imp: (p: P) => <S {...p} color={p.color ?? '#7ad8ff'}><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></S>,
  hex: (p: P) => <S {...p} color={p.color ?? '#8f9bb3'}><path d="M4 6h16M4 12h16M4 18h16M9 3v18M15 3v18" /></S>,
  search: (p: P) => <S {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></S>,
  x: (p: P) => <S {...p}><path d="M6 6l12 12M18 6L6 18" /></S>,
  check: (p: P) => <S {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></S>,
  upload: (p: P) => <S {...p}><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></S>,
  download: (p: P) => <S {...p}><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 18v1a2 2 0 002 2h12a2 2 0 002-2v-1" /></S>,
  code: (p: P) => <S {...p}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></S>,
  asm: (p: P) => <S {...p}><path d="M4 6h10M4 12h16M4 18h7" /></S>,
  graph: (p: P) => <S {...p}><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-4h12v4" /></S>,
  split: (p: P) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></S>,
  designer: (p: P) => <S {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 8h6M7 12h10M7 16h4" /></S>,
  back: (p: P) => <S {...p}><path d="M15 6l-6 6 6 6" /></S>,
  fwd: (p: P) => <S {...p}><path d="M9 6l6 6-6 6" /></S>,
  panel: (p: P) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></S>,
  zoomIn: (p: P) => <S {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4M8 11h6M11 8v6" /></S>,
  zoomOut: (p: P) => <S {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4M8 11h6" /></S>,
  fit: (p: P) => <S {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></S>,
  copy: (p: P) => <S {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></S>,
  tag: (p: P) => <S {...p}><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="7.5" r="1" /></S>,
  file: (p: P) => <S {...p}><path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5" /></S>,
  lib: (p: P) => <S {...p}><path d="M4 19V5M9 19V5M14 19l3-14 4 1-3 14" /></S>,
  bolt: (p: P) => <S {...p}><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></S>,
  lock: (p: P) => <S {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></S>,
  key: (p: P) => <S {...p}><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3L21 2M16 7l3 3M18 5l2 2" /></S>,
  robot: (p: P) => <S {...p}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4M9 14h.01M15 14h.01M9 17.5h6" /></S>,
  shield: (p: P) => <S {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></S>,
  cpu: (p: P) => <S {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></S>,
  layers: (p: P) => <S {...p}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></S>,
  text: (p: P) => <S {...p}><path d="M4 6h16M4 12h10M4 18h14" /></S>,
};

export function iconFor(kind: string, size = 15) {
  switch (kind) {
    case 'folder': return <I.folder size={size} />;
    case 'form': case 'mdiform': return <I.form size={size} />;
    case 'module': return <I.module size={size} />;
    case 'class': return <I.cls size={size} />;
    case 'usercontrol': case 'propertypage': case 'userdocument': return <I.uc size={size} />;
    case 'proc': return <I.proc size={size} />;
    case 'event': return <I.event size={size} />;
    case 'control': case 'controls': return <I.control size={size} />;
    case 'overview': return <I.overview size={size} />;
    case 'declares': case 'declare': return <I.api size={size} />;
    case 'components': return <I.ref size={size} />;
    case 'strings': case 'string': return <I.str size={size} />;
    case 'imports': return <I.imp size={size} />;
    case 'hex': case 'address': return <I.hex size={size} />;
    default: return <I.file size={size} />;
  }
}
