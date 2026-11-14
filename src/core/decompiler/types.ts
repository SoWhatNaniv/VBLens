// Type recovery for local variables of decompiled procedures.
//
// The compiler keeps no declarations, but the code around each variable shows its type:
// the value assigned to it (a string function, a concatenation, a comparison, CLng(...),
// Set ... = New Class), how it is used (a For counter, compared with a string literal,
// indexed like an array) and the runtime helpers that move it (__vbaStrMove, __vbaVarMove).
// Each piece of evidence has a weight; the strongest type wins and conflicting strong
// evidence falls back to Variant.

import { type E, type Stmt, unref } from './ir';
import type { Line } from './native';

export type VBType = 'String' | 'Long' | 'Integer' | 'Byte' | 'Boolean' | 'Single' | 'Double' | 'Currency' | 'Date' | 'Variant' | 'Object' | string;

const STRING_FN = /^(Left|Right|Mid|Trim|LTrim|RTrim|LCase|UCase|Chr|ChrW|ChrB|Space|String|Hex|Oct|Str|Format|Environ|Command|Dir|CurDir|Input|InputB|StrConv|StrReverse|Replace|Join|MonthName|WeekdayName|Error|LeftB|RightB|MidB)\$$/;
const FN_TYPES: Record<string, VBType> = {
  CStr: 'String', StrReverse: 'String', Replace: 'String', Join: 'String', StrConv: 'String', Space: 'String', String: 'String',
  CLng: 'Long', Len: 'Long', LenB: 'Long', InStr: 'Long', InStrRev: 'Long', InStrB: 'Long', UBound: 'Long', LBound: 'Long', LOF: 'Long', Loc: 'Long', Seek: 'Long',
  StrComp: 'Long', VarType: 'Integer', FreeFile: 'Integer', Asc: 'Integer', AscW: 'Integer', AscB: 'Integer', CInt: 'Integer', DoEvents: 'Integer',
  Weekday: 'Integer', Day: 'Integer', Month: 'Integer', Year: 'Integer', Hour: 'Integer', Minute: 'Integer', Second: 'Integer', Sgn: 'Integer', Fix: 'Long', Int: 'Long',
  CByte: 'Byte', CBool: 'Boolean', IsNumeric: 'Boolean', IsArray: 'Boolean', IsDate: 'Boolean', IsEmpty: 'Boolean', IsNull: 'Boolean', IsObject: 'Boolean', IsMissing: 'Boolean', EOF: 'Boolean',
  CSng: 'Single', Rnd: 'Single', Timer: 'Single', CDbl: 'Double', Val: 'Double', Sqr: 'Double', Exp: 'Double', Log: 'Double', Atn: 'Double', Sin: 'Double', Cos: 'Double', Tan: 'Double', Shell: 'Double',
  CCur: 'Currency', CDate: 'Date', Now: 'Date', Date: 'Date', Time: 'Date', DateAdd: 'Date', DateSerial: 'Date', TimeSerial: 'Date', DateValue: 'Date', TimeValue: 'Date', FileDateTime: 'Date',
  CVar: 'Variant', IIf: 'Variant', Array: 'Variant', Choose: 'Variant', Switch: 'Variant', CVErr: 'Variant',
  CreateObject: 'Object', GetObject: 'Object', FileLen: 'Long', GetAttr: 'Integer', DateDiff: 'Long', Partition: 'String', TypeName: 'String',
};
/** Members whose type is the same on every control that has them. */
const MEMBER_TYPES: Record<string, VBType> = {
  Text: 'String', Caption: 'String', Tag: 'String', FileName: 'String', FileTitle: 'String', Filter: 'String', DialogTitle: 'String', InitDir: 'String',
  SelText: 'String', ToolTipText: 'String', Path: 'String', Pattern: 'String', DataField: 'String', LinkTopic: 'String', LinkItem: 'String',
  RemoteHost: 'String', RemoteHostIP: 'String', LocalIP: 'String', LocalHostName: 'String', URL: 'String', TextRTF: 'String', Title: 'String', EXEName: 'String',
  hWnd: 'Long', hDC: 'Long', ListIndex: 'Integer', ListCount: 'Integer', NewIndex: 'Integer', TopIndex: 'Integer', SelStart: 'Long', SelLength: 'Long', MaxLength: 'Long',
  RemotePort: 'Long', LocalPort: 'Long', BytesReceived: 'Long', ForeColor: 'Long', BackColor: 'Long', Color: 'Long', Flags: 'Long', MousePointer: 'Integer',
  Left: 'Single', Top: 'Single', Width: 'Single', Height: 'Single', ScaleWidth: 'Single', ScaleHeight: 'Single', Interval: 'Long', TabIndex: 'Integer',
  Enabled: 'Boolean', Visible: 'Boolean', Locked: 'Boolean', Checked: 'Boolean', Cancel: 'Boolean', Default: 'Boolean', MultiLine: 'Boolean',
  Count: 'Long', Index: 'Integer', Number: 'Long', Description: 'String', Source: 'String', LastDllError: 'Long', PrevInstance: 'Boolean', ThreadID: 'Long', hInstance: 'Long',
};
/** Win32 APIs that take a structure (UDT) by reference: argument index -> type name. */
export const API_STRUCTS: Record<string, Record<number, string>> = {
  CreateProcess: { 8: 'STARTUPINFO', 9: 'PROCESS_INFORMATION' }, CreateProcessAsUser: { 9: 'STARTUPINFO', 10: 'PROCESS_INFORMATION' },
  GetThreadContext: { 1: 'CONTEXT' }, SetThreadContext: { 1: 'CONTEXT' }, Wow64GetThreadContext: { 1: 'WOW64_CONTEXT' }, Wow64SetThreadContext: { 1: 'WOW64_CONTEXT' },
  Process32First: { 1: 'PROCESSENTRY32' }, Process32Next: { 1: 'PROCESSENTRY32' }, Module32First: { 1: 'MODULEENTRY32' }, Module32Next: { 1: 'MODULEENTRY32' },
  Thread32First: { 1: 'THREADENTRY32' }, Thread32Next: { 1: 'THREADENTRY32' },
  VirtualQuery: { 1: 'MEMORY_BASIC_INFORMATION' }, VirtualQueryEx: { 2: 'MEMORY_BASIC_INFORMATION' },
  NtQueryInformationProcess: { 2: 'PROCESS_BASIC_INFORMATION' }, ZwQueryInformationProcess: { 2: 'PROCESS_BASIC_INFORMATION' },
  GetWindowRect: { 1: 'RECT' }, GetClientRect: { 1: 'RECT' }, SetRect: { 0: 'RECT' }, InvalidateRect: { 1: 'RECT' }, DrawText: { 3: 'RECT' }, FillRect: { 1: 'RECT' },
  GetCursorPos: { 0: 'POINTAPI' }, SetCursorPos: {}, ClientToScreen: { 1: 'POINTAPI' }, ScreenToClient: { 1: 'POINTAPI' },
  GetVersionEx: { 0: 'OSVERSIONINFO' }, GetSystemInfo: { 0: 'SYSTEM_INFO' }, GetNativeSystemInfo: { 0: 'SYSTEM_INFO' }, GlobalMemoryStatus: { 0: 'MEMORYSTATUS' }, GlobalMemoryStatusEx: { 0: 'MEMORYSTATUSEX' },
  GetSystemTime: { 0: 'SYSTEMTIME' }, GetLocalTime: { 0: 'SYSTEMTIME' }, SetSystemTime: { 0: 'SYSTEMTIME' }, FileTimeToSystemTime: { 0: 'FILETIME', 1: 'SYSTEMTIME' }, SystemTimeToFileTime: { 0: 'SYSTEMTIME', 1: 'FILETIME' },
  FileTimeToLocalFileTime: { 0: 'FILETIME', 1: 'FILETIME' }, GetFileTime: { 1: 'FILETIME', 2: 'FILETIME', 3: 'FILETIME' }, SetFileTime: { 1: 'FILETIME', 2: 'FILETIME', 3: 'FILETIME' },
  FindFirstFile: { 1: 'WIN32_FIND_DATA' }, FindNextFile: { 1: 'WIN32_FIND_DATA' }, GetFileInformationByHandle: { 1: 'BY_HANDLE_FILE_INFORMATION' },
  SHBrowseForFolder: { 0: 'BROWSEINFO' }, GetOpenFileName: { 0: 'OPENFILENAME' }, GetSaveFileName: { 0: 'OPENFILENAME' }, ChooseColor: { 0: 'CHOOSECOLOR_TYPE' }, ChooseFont: { 0: 'CHOOSEFONT_TYPE' },
  Shell_NotifyIcon: { 1: 'NOTIFYICONDATA' }, SHFileOperation: { 0: 'SHFILEOPSTRUCT' }, ShellExecuteEx: { 0: 'SHELLEXECUTEINFO' }, SHGetFileInfo: { 2: 'SHFILEINFO' },
  GetMessage: { 0: 'MSG' }, PeekMessage: { 0: 'MSG' }, TranslateMessage: { 0: 'MSG' }, DispatchMessage: { 0: 'MSG' },
  GetWindowPlacement: { 1: 'WINDOWPLACEMENT' }, SetWindowPlacement: { 1: 'WINDOWPLACEMENT' }, CreatePipe: { 2: 'SECURITY_ATTRIBUTES' },
  CreateFontIndirect: { 0: 'LOGFONT' }, GetTextMetrics: { 1: 'TEXTMETRIC' }, InitCommonControlsEx: { 0: 'INITCOMMONCONTROLSEX_TYPE' },
  WSAStartup: { 1: 'WSADATA' }, InternetCrackUrl: { 3: 'URL_COMPONENTS' }, LookupPrivilegeValue: { 2: 'LUID' }, AdjustTokenPrivileges: { 2: 'TOKEN_PRIVILEGES' },
  GetStartupInfo: { 0: 'STARTUPINFO' }, NtUnmapViewOfSection: {}, ZwUnmapViewOfSection: {},
};
/** The structure type an API call expects at an argument position. */
export function apiStruct(fn: string, idx: number): string | undefined {
  const base = API_STRUCTS[fn] ? fn : fn.replace(/[AW]$/, '');
  return API_STRUCTS[base]?.[idx];
}

const CMP = new Set(['=', '<>', '<', '>', '<=', '>=', 'Like', 'Is']);
const NUM: Record<string, number> = { Byte: 1, Boolean: 1, Integer: 2, Long: 3, Currency: 4, Single: 5, Double: 6 };

/** The VB type of an expression, when it can be told from the expression alone. */
export function exprType(e: E, varType: (n: string) => VBType | undefined): VBType | undefined {
  const x = unref(e);
  switch (x.k) {
    case 's': return 'String';
    case 'f': return 'Double';
    case 'c': return x.t === 'bool' ? 'Boolean' : undefined;
    case 'new': return x.cls || 'Object';
    case 'v': return varType(x.n);
    case 'u': return x.op === 'Not' ? exprType(x.e, varType) : x.op === 'neg' ? exprType(x.e, varType) : undefined;
    case 'b': {
      if (x.op === '&') return 'String';
      if (CMP.has(x.op)) return 'Boolean';
      if (x.op === '/' || x.op === '^') return 'Double';
      if (x.op === '\\' || x.op === 'Mod') return 'Long';
      const l = exprType(x.l, varType), r = exprType(x.r, varType);
      if ((x.op === 'And' || x.op === 'Or' || x.op === 'Xor') && l === 'Boolean' && r === 'Boolean') return 'Boolean';
      if (l && r && NUM[l] && NUM[r]) return NUM[l] >= NUM[r] ? l : r;
      // x - 1, n * 2: an integer constant takes the type of the other side
      const lc = unref(x.l), rc = unref(x.r);
      if (l && NUM[l] && rc.k === 'c' && rc.t !== 'bool') return l === 'Boolean' || l === 'Byte' ? 'Integer' : l;
      if (r && NUM[r] && lc.k === 'c' && lc.t !== 'bool') return r === 'Boolean' || r === 'Byte' ? 'Integer' : r;
      return undefined;
    }
    case 'call': {
      const f = x.f.replace(/^VBA\./, '');
      if (STRING_FN.test(f)) return 'String';
      if (FN_TYPES[f]) return FN_TYPES[f];
      if (x.bool) return 'Boolean';
      return undefined;
    }
    case 'mc': return x.kind === 'get' || x.kind === undefined ? MEMBER_TYPES[x.n] : undefined;
    default: return undefined;
  }
}

interface Evidence { types: Map<VBType, number>; array?: boolean; udt?: boolean; struct?: string }
type Assign = Extract<Stmt, { k: 'assign' }>;

/** Walk an expression as it is printed: inlined definitions are part of it, others are their variable. */
function walkShown(e: E, fn: (x: E) => void) {
  if (e.k === 'ref') { const d = e.def as Assign; if (d.inline) walkShown(d.src, fn); else fn(d.dst); return; }
  fn(e);
  switch (e.k) {
    case 'a': walkShown(e.e, fn); break;
    case 'm': walkShown(e.base, fn); break;
    case 'b': walkShown(e.l, fn); walkShown(e.r, fn); break;
    case 'u': walkShown(e.e, fn); break;
    case 'call': e.args.forEach(a => walkShown(a, fn)); break;
    case 'mc': walkShown(e.o, fn); e.args.forEach(a => walkShown(a, fn)); break;
  }
}
/** The variable an expression prints as, if it is a plain variable. */
function asVar(e: E): string | undefined {
  let x = e;
  for (let g = 0; g < 32 && x.k === 'ref'; g++) { const d = x.def as Assign; if (!d.inline) return d.dst.k === 'v' ? d.dst.n : undefined; x = d.src; }
  return x.k === 'v' ? x.n : undefined;
}

/**
 * Infer the types of the local variables of one procedure from its statements and
 * conditions. `classOf` names the class of an object expression (a control on a form, a
 * project class) when the decompiler knows it.
 */
export function inferLocalTypes(stmts: Stmt[], conds: E[], isLocal: (n: string) => boolean, classOf: (e: E) => string | undefined): Map<string, { type: VBType; array: boolean; struct?: string }> {
  const ev = new Map<string, Evidence>();
  const add = (n: string, t: VBType | undefined, w: number) => {
    if (!t || !isLocal(n)) return;
    let e = ev.get(n);
    if (!e) ev.set(n, e = { types: new Map() });
    e.types.set(t, (e.types.get(t) ?? 0) + w);
  };
  const struct = (n: string, t: string) => { if (!isLocal(n)) return; let e = ev.get(n); if (!e) ev.set(n, e = { types: new Map() }); e.struct = t; };
  const mark = (n: string, k: 'array' | 'udt') => { if (!isLocal(n)) return; let e = ev.get(n); if (!e) ev.set(n, e = { types: new Map() }); e[k] = true; };
  let resolved = new Map<string, VBType>();
  const varType = (n: string) => resolved.get(n);
  const visitUses = (root: E) => walkShown(root, x => {
    if (x.k === 'b' && CMP.has(x.op) && x.op !== 'Is') {
      const l = asVar(x.l), r = asVar(x.r);
      if (l) add(l, exprType(x.r, varType) === 'String' ? 'String' : undefined, 2);
      if (r) add(r, exprType(x.l, varType) === 'String' ? 'String' : undefined, 2);
    }
    if (x.k === 'b' && x.op === '&') for (const s of [x.l, x.r]) { const v = asVar(s); if (v) add(v, 'String', 1); }
    if (x.k === 'mc' && x.n === 'Value') { const v = asVar(x.o); if (v) add(v, 'Variant', 3); }
    // CStr(v), CLng(v), Trim(v), Mid(v, ...): the conversions and the Variant versions of the
    // string functions are what the compiler uses for Variant arguments
    if (x.k === 'call' && /^(CStr|CLng|CInt|CDbl|CSng|CBool|CByte|CCur|CDate|Trim|LTrim|RTrim|Left|Right|Mid|LCase|UCase|IsNull|IsEmpty|IsMissing|IsObject|IsNumeric|IsDate|IsArray|VarType)$/.test(x.f) && x.args[0]) { const v = asVar(x.args[0]); if (v) add(v, 'Variant', 2); }
    // compared with a number: a number
    if (x.k === 'b' && CMP.has(x.op) && x.op !== 'Is') {
      const l = asVar(x.l), r = asVar(x.r), lt = exprType(x.l, varType), rt = exprType(x.r, varType);
      const isNum = (e: E, t: VBType | undefined) => (t && NUM[t]) || (unref(e).k === 'c' && (unref(e) as { t?: string }).t !== 'bool');
      if (l && isNum(x.r, rt)) add(l, rt && NUM[rt] && rt !== 'Boolean' ? rt : 'Long', 1);
      if (r && isNum(x.l, lt)) add(r, lt && NUM[lt] && lt !== 'Boolean' ? lt : 'Long', 1);
    }
    if (x.k === 'mc' && /^field_/.test(x.n)) { const v = asVar(x.o); if (v) mark(v, 'udt'); }
    // structures passed to Win32 APIs (CreateProcess, GetThreadContext, Process32First...)
    if (x.k === 'call') x.args.forEach((a, i) => { const t = apiStruct(x.f, i); const u = unref(a); const v = asVar(u.k === 'a' ? u.e : a); if (t && v) struct(v, t); });
    if (x.k === 'call' && /^(UBound|LBound)$/.test(x.f)) { const v = asVar(x.args[0] ?? { k: 'missing' }); if (v) mark(v, 'array'); }
  });
  // two rounds so variables copied from other variables pick up their type
  for (let round = 0; round < 2; round++) {
    ev.clear();
    for (const st of stmts) {
      if (st.k === 'assign') {
        if (st.inline) continue;
        const d = st.dst;
        if (d.k === 'v') {
          const src = unref(st.src);
          if (st.vt) add(d.n, st.vt, 5);
          if (st.set && st.vt === 'Variant') { /* Set into a Variant */ }
          else if (st.set) add(d.n, classOf(st.src) ?? exprType(st.src, varType) ?? 'Object', 4);
          else if (src.k === 'c' && src.t !== 'bool') add(d.n, 'Long', 1);
          else {
            const t = exprType(st.src, varType);
            add(d.n, t, 3);
            // a late-bound property (unknown member) comes back as a Variant
            if (!t && src.k === 'mc' && (src.kind === 'get' || src.kind === undefined) && /^(DispID_|Method_)|^Item$/.test(src.n)) add(d.n, 'Variant', 1);
          }
        }
        visitUses(st.src);
        if (st.dst.k !== 'v') visitUses(st.dst);
        // a variable copied somewhere takes the type of the destination
        const sv = asVar(st.src);
        if (sv && !st.set) {
          const dt = st.dst.k === 'v' ? varType(st.dst.n) : st.dst.k === 'mc' ? (MEMBER_TYPES[st.dst.n] ?? (/^(DispID_|Method_)/.test(st.dst.n) ? 'Variant' : undefined)) : undefined;
          add(sv, dt, 1);
        }
      } else if (st.k === 'expr') visitUses(st.e);
      else if (st.k === 'text') {
        // ReDim x(...) / Erase x / Open ... As #x
        for (const m of st.t.matchAll(/\b(?:ReDim(?: Preserve)?|Erase) (var_[0-9A-F]+)\b/g)) mark(m[1], 'array');
      }
    }
    for (const c of conds) visitUses(c);
    resolved = new Map();
    for (const [n, e] of ev) {
      const sorted = [...e.types].sort((a, b) => b[1] - a[1]);
      if (!sorted.length) continue;
      let t = sorted[0][0];
      // numeric types mix freely; anything else in conflict means Variant
      const strong = sorted.filter(([, w]) => w >= 3).map(([t]) => t);
      if (strong.length > 1 && !strong.every(s => NUM[s])) t = strong.includes('Variant') || !strong.every(s => s === strong[0]) ? 'Variant' : t;
      else if (strong.length > 1) t = strong.reduce((a, b) => NUM[a] >= NUM[b] ? a : b);
      resolved.set(n, t);
    }
  }
  const out = new Map<string, { type: VBType; array: boolean; struct?: string }>();
  for (const [n, e] of ev) {
    // a structure argument: the variable is the structure's first member, keep it unless
    // stronger evidence says the slot also holds something else
    const strong = [...e.types].some(([, w]) => w >= 3);
    out.set(n, { type: e.struct && !strong ? e.struct : resolved.get(n) ?? 'Variant', array: !!e.array, struct: e.struct });
  }
  return out;
}

const IDENT = /\b[A-Za-z_]\w*\b/g;

/**
 * Add Dim lines for the local variables that appear in the code, and give For counters
 * short names (i, j, k...) when those names are free.
 */
export function declareLocals(lines: Line[], types: Map<string, { type: VBType; array: boolean; struct?: string }>, localRe: RegExp): Line[] {
  const used = new Set<string>();
  for (const l of lines) for (const m of l.text.matchAll(IDENT)) used.add(m[0]);
  // loop counters
  const rename = new Map<string, string>();
  const short = ['i', 'j', 'k', 'l', 'm', 'n'];
  for (const l of lines) {
    const m = /^For (\w+) = /.exec(l.text);
    if (!m || !localRe.test(m[1]) || rename.has(m[1])) continue;
    const free = short.find(s => !used.has(s) && ![...rename.values()].includes(s));
    if (!free) break;
    rename.set(m[1], free);
  }
  const apply = (t: string) => {
    if (!rename.size) return t;
    // keep string literals untouched
    return t.split(/("(?:[^"]|"")*")/).map((p, i) => i % 2 ? p : p.replace(/\bvar_[0-9A-F]+\b/g, v => rename.get(v) ?? v)).join('');
  };
  const out = lines.map(l => rename.size ? { ...l, text: apply(l.text) } : l);
  // declarations, in order of first appearance
  const seen: string[] = [];
  for (const l of lines) for (const m of l.text.split(/"(?:[^"]|"")*"/).join(' ').matchAll(/\bvar_[0-9A-F]+\b/g)) if (!seen.includes(m[0])) seen.push(m[0]);
  if (!seen.length) return out;
  const arrays = new Set<string>();
  for (const l of lines) for (const m of l.text.matchAll(/\b(?:ReDim(?: Preserve)? |Erase |[LU]Bound\()(var_[0-9A-F]+)\b/g)) arrays.add(m[1]);
  const decl: Line[] = seen.map(n => {
    const t0 = types.get(n);
    const t = t0 ? { ...t0, array: t0.array || arrays.has(n) } : arrays.has(n) ? { type: 'Variant', array: true } : undefined;
    const name = rename.get(n) ?? n;
    const ty = t?.type ?? (rename.has(n) ? 'Long' : 'Variant');
    const note = t?.struct && t.struct !== ty ? `  ' also used as a ${t.struct} structure` : '';
    return { text: `Dim ${name}${t?.array ? '()' : ''} As ${ty}${note}`, indent: 1, kind: 'decl' as const };
  });
  return [...decl, { text: '', indent: 1 }, ...out];
}
