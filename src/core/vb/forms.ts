// Decoder for the binary form/designer property streams VB compiles into the
// executable (the equivalent of .frm + .frx). Rebuilds a control tree with
// typed properties, a textual .frm and embedded pictures.

import type { Image } from '../pe/pe';
import type { VBObject, VBProject } from './structures';
import { VB_CLASSES_BY_NAME } from '../data/vbclasses';

export interface FormPicture { prop: string; mime: string; bytes: Uint8Array; offset: number }
export interface FormFont { name: string; size: number; bold: boolean; italic: boolean; underline: boolean; strike: boolean; charset: number; weight: number }

export interface FormControl {
  name: string;
  typeCode: number;
  className: string; // VB.TextBox, VSFlex7LCtl.VSFlexGrid, ...
  cId: number;
  arrayIndex?: number;
  props: { name: string; value: string; raw?: number | string | boolean }[];
  left?: number; top?: number; width?: number; height?: number;
  clientLeft?: number; clientTop?: number; clientWidth?: number; clientHeight?: number;
  caption?: string; text?: string; backColor?: number; foreColor?: number; visible?: boolean; enabled?: boolean;
  font?: FormFont;
  pictures: FormPicture[];
  children: FormControl[];
  offset: number;
  partial?: boolean; // stopped decoding (unknown property)
  borderStyle?: number;
  alignment?: number;
  style?: number;
  value?: number;
  shortcut?: number;
  checked?: boolean;
}

export interface ParsedForm {
  root?: FormControl;
  controls: FormControl[];
  byId: Map<number, FormControl>;
  frm: string;
  errors: string[];
  codepage: string;
}

const TYPE_NAMES: Record<number, string> = {
  0: 'PictureBox', 1: 'Label', 2: 'TextBox', 3: 'Frame', 4: 'CommandButton', 5: 'CheckBox', 6: 'OptionButton', 7: 'ComboBox',
  8: 'ListBox', 9: 'HScrollBar', 10: 'VScrollBar', 11: 'Timer', 13: 'Form', 16: 'DriveListBox', 17: 'DirListBox', 18: 'FileListBox',
  19: 'Menu', 20: 'MDIForm', 22: 'Shape', 23: 'Line', 24: 'Image', 37: 'Data', 38: 'OLE', 40: 'UserControl', 41: 'PropertyPage', 42: 'UserDocument',
};

// Integer properties stored as 2 bytes; other Integer-typed (enumerated) properties take 1 byte.
const INT16_PROPS = new Set(['TabIndex', 'Index', 'LinkTimeout', 'DrawWidth', 'BorderWidth', 'Max', 'Min', 'SmallChange', 'LargeChange', 'Value', 'Columns', 'ItemData', 'DataChanged', 'Interval', 'Shortcut']);

const CHARSET_CP: Record<number, string> = {
  0: 'windows-1252', 177: 'windows-1255', 178: 'windows-1256', 204: 'windows-1251', 161: 'windows-1253', 162: 'windows-1254', 238: 'windows-1250',
  186: 'windows-1257', 128: 'shift_jis', 134: 'gbk', 129: 'euc-kr', 136: 'big5', 222: 'windows-874', 163: 'windows-1258',
};
const LCID_CP: Record<number, string> = {
  1037: 'windows-1255', 1025: 'windows-1256', 1049: 'windows-1251', 1058: 'windows-1251', 1032: 'windows-1253', 1055: 'windows-1254',
  1029: 'windows-1250', 1045: 'windows-1250', 1038: 'windows-1250', 1041: 'shift_jis', 2052: 'gbk', 1042: 'euc-kr', 1028: 'big5', 1054: 'windows-874',
};

export function codepageForCharset(cs: number) { return CHARSET_CP[cs]; }

/** Guess the ANSI code page used for strings in a form stream (from embedded font charsets). */
function guessCodepage(b: Uint8Array, lcid: number): string {
  // Font blocks: 01 <charset u16> <flags u8> <weight u16> <size u32> <len u8> <name>
  const counts = new Map<number, number>();
  for (let i = 0; i + 12 < b.length; i++) {
    if (b[i] !== 0x01) continue;
    const cs = b[i + 1] | (b[i + 2] << 8);
    const weight = b[i + 4] | (b[i + 5] << 8);
    const nl = b[i + 10];
    if (weight !== 400 && weight !== 700) continue;
    if (!CHARSET_CP[cs] || nl < 3 || nl > 32) continue;
    let ok = true;
    for (let k = 0; k < nl; k++) { const c = b[i + 11 + k]; if (c < 0x20 || c > 0x7e) { ok = false; break; } }
    if (ok) counts.set(cs, (counts.get(cs) ?? 0) + 1);
  }
  let best = -1, n = 0;
  for (const [cs, c] of counts) if (cs !== 0 && c > n) { best = cs; n = c; }
  if (best >= 0) return CHARSET_CP[best];
  return LCID_CP[lcid] ?? 'windows-1252';
}

function sniffMime(d: Uint8Array): string {
  if (d[0] === 0x42 && d[1] === 0x4d) return 'image/bmp';
  if (d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg';
  if (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46) return 'image/gif';
  if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
  if (d[0] === 0 && d[1] === 0 && (d[2] === 1 || d[2] === 2) && d[3] === 0) return d[2] === 1 ? 'image/x-icon' : 'image/x-cursor';
  if (d[0] === 0xd7 && d[1] === 0xcd) return 'image/wmf';
  if (d[0] === 1 && d[1] === 0 && d[2] === 0 && d[3] === 0 && d[40] === 0x20 && d[41] === 0x45) return 'image/emf';
  return 'application/octet-stream';
}

class Reader {
  constructor(public b: Uint8Array, public p: number, public dec: TextDecoder) {}
  u8() { if (this.p >= this.b.length) throw new Error('eof'); return this.b[this.p++]; }
  u16() { return this.u8() | (this.u8() << 8); }
  i16() { return (this.u16() << 16) >> 16; }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  i32() { return this.u32() | 0; }
  f32() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true); this.p += 4; return v; }
  bytes(n: number) { if (this.p + n > this.b.length) throw new Error('eof'); const r = this.b.subarray(this.p, this.p + n); this.p += n; return r; }
  str() {
    const n = this.u16();
    // some strings are stored as UTF-16 with a character count (no NUL terminator)
    if (n >= 2) {
      const k = Math.min(n, 12);
      let wide = true;
      for (let i = 0; i < k && wide; i++) if (this.b[this.p + i * 2 + 1] !== 0 || this.b[this.p + i * 2] === 0) wide = false;
      if (wide) {
        let t = '';
        for (let i = 0; i < n; i++) t += String.fromCharCode(this.b[this.p + i * 2] | (this.b[this.p + i * 2 + 1] << 8));
        this.p += n * 2;
        return t;
      }
    }
    const s = this.dec.decode(this.bytes(n)); if (this.b[this.p] === 0) this.p++; return s;
  }
}

const vbStr = (s: string) => '"' + s.replace(/"/g, '""').replace(/\r\n/g, '" & vbCrLf & "') + '"';
const hexColor = (v: number) => '&H' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0') + '&';

export function parseForm(img: Image, project: VBProject, obj: VBObject, codepage?: string): ParsedForm {
  const out: ParsedForm = { controls: [], byId: new Map(), frm: '', errors: [], codepage: 'windows-1252' };
  if (!obj.formDataVA) { out.errors.push('No form data'); return out; }
  const b = img.slice(obj.formDataVA, obj.formDataSize || 0x100000);
  const cp = codepage ?? guessCodepage(b, project.lcid);
  out.codepage = cp;
  let dec: TextDecoder;
  try { dec = new TextDecoder(cp); } catch { dec = new TextDecoder('windows-1252'); }
  // Locate the first control header: <len16> 00 <flags> <id> <nameLen16> <name> 00 <type>
  const nm = obj.name;
  let start = -1;
  for (let i = 0x30; i + nm.length + 8 < b.length && i < 0x400; i++) {
    if (b[i] === (nm.length & 0xff) && b[i + 1] === nm.length >> 8) {
      let ok = true;
      for (let k = 0; k < nm.length; k++) if (b[i + 2 + k] !== nm.charCodeAt(k)) { ok = false; break; }
      if (ok && b[i + 2 + nm.length] === 0) { start = i - 5; break; }
    }
  }
  if (start < 0) { out.errors.push('Could not locate the form header'); return out; }
  const r = new Reader(b, start, dec);
  const parseControl = (): FormControl => {
    const hdr = r.p;
    const len = r.u16() | (r.u8() << 16);
    const flags = r.u8();
    const cId = r.u8();
    let arrayIndex: number | undefined;
    if (flags & 0x80) arrayIndex = r.u16();
    const nameLen = r.u16();
    const name = String.fromCharCode(...r.bytes(nameLen));
    r.u8();
    const typeCode = r.u8();
    let className = TYPE_NAMES[typeCode] ? 'VB.' + TYPE_NAMES[typeCode] : `Type${typeCode}`;
    let progId = '';
    if (typeCode === 0xff) { progId = String.fromCharCode(...r.bytes(r.u16())); r.u8(); className = progId; }
    const c: FormControl = { name, typeCode, className, cId, arrayIndex, props: [], pictures: [], children: [], offset: hdr };

    const end = hdr + len; // separator is expected at end-1 .. end+1
    if (typeCode === 0xff) {
      // ActiveX: a short extender block precedes the opaque property bag
      // ("-LB" magic). 01 u16 = Index-ish, 03 = Left/Top/Width/Height (i16),
      // 07 u8 = flags, 0F u16 = TabIndex.
      try {
        for (let guard = 0; guard < 8 && r.p < end; guard++) {
          const op = b[r.p];
          if (op === 0x2d && b[r.p + 1] === 0x4c && b[r.p + 2] === 0x42) break;
          r.p++;
          if (op === 0x03) {
            const first = r.i16();
            if (first === -32768) { c.left = r.i32(); c.top = r.i32(); c.width = r.i32(); c.height = r.i32(); }
            else { c.left = first; c.top = r.i16(); c.width = r.i16(); c.height = r.i16(); }
            c.props.push({ name: 'Height', value: String(c.height) }, { name: 'Left', value: String(c.left) }, { name: 'Top', value: String(c.top) }, { name: 'Width', value: String(c.width) });
          } else if (op === 0x01) r.u16();
          else if (op === 0x0f) c.props.push({ name: 'TabIndex', value: String(r.u16()) });
          else if (op === 0x07) r.u8();
          else break;
        }
      } catch { /* opaque */ }
      r.p = findSeparator(b, end);
      return c;
    }
    try {
      decodeProps(r, c, end);
    } catch (e) {
      c.partial = true;
      out.errors.push(`${name}: ${(e as Error).message}`);
    }
    r.p = findSeparator(b, Math.max(r.p, end - 2));
    return c;
  };
  // Tree walk. Separators: FF01 children follow, FF03 next sibling, FF02 end of
  // a child list (followed by a raw parent-level code), FF04 end of form,
  // 05 menus follow. Inside menus: FF02 next item (one level deeper when the
  // previous item carried the "indent" flag), FF03 up one level + raw code.
  const stack: FormControl[] = [];
  let root: FormControl | undefined;
  let current: FormControl | undefined;
  try {
    root = parseControl();
    out.controls.push(root);
    current = root;
    let guard = 0;
    let code = -1;
    let inMenu = false;
    const readCode = () => {
      if (r.p + 1 >= b.length) return 0x04;
      if (b[r.p] !== 0xff) { out.errors.push(`Unexpected byte at +${r.p.toString(16)}`); return -2; }
      const c = b[r.p + 1];
      r.p += 2;
      return c;
    };
    const addChild = (parent: FormControl) => {
      const c = parseControl();
      parent.children.push(c);
      out.controls.push(c);
      return c;
    };
    while (guard++ < 20000) {
      if (code < 0) code = readCode();
      if (code === -2 || code === 0x04) break;
      if (inMenu) {
        if (code === 0x02) {
          // next menu item: child of current if current is flagged as having children
          if ((current as FormControl & { _indent?: boolean })._indent) stack.push(current!);
          const parent = stack[stack.length - 1] ?? root!;
          current = addChild(parent);
          code = -1;
          continue;
        }
        if (code === 0x03) {
          stack.pop();
          (current as FormControl & { _indent?: boolean })._indent = false;
          code = b[r.p++];
          // raw follow-up code: 02 => next item at this level, 03 => up again
          if (code === 0x02) {
            const parent = stack[stack.length - 1] ?? root!;
            current = addChild(parent);
            code = -1;
          }
          continue;
        }
        out.errors.push(`Unknown menu separator ${code}`);
        break;
      }
      if (code === 0x05) {
        inMenu = true;
        stack.length = 0;
        stack.push(root!);
        current = addChild(root!);
        code = -1;
        continue;
      }
      if (code === 0x01) {
        stack.push(current!);
        current = addChild(current!);
      } else if (code === 0x03) {
        const parent = stack[stack.length - 1];
        if (!parent) { out.errors.push('Sibling without parent'); break; }
        current = addChild(parent);
      } else if (code === 0x02) {
        current = stack.pop() ?? root;
        code = b[r.p++];
        continue;
      } else { out.errors.push(`Unknown separator code ${code}`); break; }
      code = -1;
    }
  } catch (e) {
    out.errors.push((e as Error).message);
  }
  out.root = root;
  for (const c of out.controls) if (!out.byId.has(c.cId)) out.byId.set(c.cId, c);
  if (root) out.frm = buildFrm(project, obj, root);
  return out;
}

// Design-time / hidden properties not described by the type library: [name, kind]
const EXTRA: Record<string, Record<number, [string, 'u8' | 'i16' | 'i32' | 'str']>> = {
  Timer: { 7: ['Left', 'i32'], 8: ['Top', 'i32'] },
  TextBox: { 40: ['IMEMode', 'u8'] },
  ComboBox: { 36: ['IMEMode', 'u8'] },
  ListBox: { 37: ['IMEMode', 'u8'] },
  PictureBox: { 56: ['NegotiateMenus', 'u8'] },
  Form: { 61: ['LockControls', 'u8'], 62: ['NegotiateMenus', 'u8'], 98: ['(unknown98)', 'u8'], 99: ['(unknown99)', 'u8'] },
  MDIForm: { 61: ['LockControls', 'u8'], 62: ['NegotiateToolbars', 'u8'], 98: ['(unknown98)', 'u8'], 99: ['(unknown99)', 'u8'] },
  Menu: { 6: ['(separator)', 'u8'], 7: ['(indent)', 'u8'], 8: ['Shortcut', 'i16'] },
  UserControl: { 61: ['LockControls', 'u8'], 92: ['(flag92)', 'u8'] },
};

function findSeparator(b: Uint8Array, near: number): number {
  for (let d = 0; d < 6; d++) {
    for (const p of [near - d, near + d]) {
      if (p >= 0 && p + 1 < b.length && b[p] === 0xff && b[p + 1] >= 1 && b[p + 1] <= 5) return p;
    }
  }
  return Math.max(0, near - 1);
}

const dec = (r: Reader) => r.dec.decode(r.bytes(r.u16()));

function decodeProps(r: Reader, c: FormControl, end: number) {
  const tname = c.className.replace(/^VB\./, '');
  const known = VB_CLASSES_BY_NAME[tname];
  const dispids = known?.dispids ?? {};
  const isForm = c.typeCode === 13 || c.typeCode === 20 || c.typeCode === 40 || c.typeCode === 41 || c.typeCode === 42;
  // opcode of the packed Left/Top/Width/Height block for controls
  let sizeOp = -1, scaleOp = -1;
  for (const [k, v] of Object.entries(dispids)) {
    if (v.name === 'Left') sizeOp = Number(k) - 0x10000;
    if (v.name === 'ScaleMode') scaleOp = Number(k) - 0x10000;
  }
  const extra = EXTRA[tname] ?? {};
  while (r.p < end - 1) {
    if (r.b[r.p] === 0xff && r.b[r.p + 1] >= 1 && r.b[r.p + 1] <= 5 && r.p >= end - 3) return;
    const op = r.u8();
    if (isForm && op === 53) {
      c.clientLeft = r.i32(); c.clientTop = r.i32(); c.clientWidth = r.i32(); c.clientHeight = r.i32();
      c.props.push({ name: 'ClientLeft', value: String(c.clientLeft) }, { name: 'ClientTop', value: String(c.clientTop) },
        { name: 'ClientWidth', value: String(c.clientWidth) }, { name: 'ClientHeight', value: String(c.clientHeight) });
      continue;
    }
    if ((isForm && op === 25) || op === scaleOp) {
      const sm = r.u8(); r.u8();
      if (sm === 0) r.bytes(16);
      const f3 = r.u8(); r.u8();
      c.props.push({ name: 'ScaleMode', value: String(sm) });
      if (f3 & 0x20) c.props.push({ name: 'AutoRedraw', value: '-1  \'True' });
      if (!(f3 & 0x02)) c.props.push({ name: 'FontTransparent', value: '0   \'False' });
      continue;
    }
    if (!isForm && op === sizeOp) {
      const first = r.i16();
      // 0x8000 marks 32-bit coordinates (e.g. controls on hidden SSTab pages sit at Left-75000)
      if (first === -32768) { c.left = r.i32(); c.top = r.i32(); c.width = r.i32(); c.height = r.i32(); }
      else { c.left = first; c.top = r.i16(); c.width = r.i16(); c.height = r.i16(); }
      if (c.typeCode === 23) { // Line: X1,Y1,X2,Y2
        c.props.push({ name: 'X1', value: String(c.left) }, { name: 'Y1', value: String(c.top) }, { name: 'X2', value: String(c.width) }, { name: 'Y2', value: String(c.height) });
      } else {
        c.props.push({ name: 'Height', value: String(c.height) }, { name: 'Left', value: String(c.left) }, { name: 'Top', value: String(c.top) }, { name: 'Width', value: String(c.width) });
      }
      continue;
    }
    const ex = extra[op];
    if (ex) {
      const v = ex[1] === 'u8' ? r.u8() : ex[1] === 'i16' ? r.i16() : ex[1] === 'i32' ? r.i32() : r.str();
      if (ex[0] === 'Shortcut') c.shortcut = Number(v);
      if (tname === 'Menu' && ex[0] === '(indent)') (c as FormControl & { _indent?: boolean })._indent = true;
      if (!ex[0].startsWith('(')) c.props.push({ name: ex[0], value: typeof v === 'string' ? vbStr(v) : String(v), raw: v });
      if (tname === 'Timer' && ex[0] === 'Left') c.left = Number(v);
      if (tname === 'Timer' && ex[0] === 'Top') c.top = Number(v);
      continue;
    }
    const d = dispids[String(0x10000 + op)];
    if (!d) throw new Error(`unknown property code ${op} for ${tname} at +${(r.p - 1).toString(16)}`);
    const name = d.name;
    const ty = d.type;
    if (name === 'List' || name === 'ItemData' || name === 'PropertyPages') {
      const n = r.u16();
      if (n) {
        r.u16();
        const items: string[] = [];
        for (let k = 0; k < n; k++) items.push(dec(r));
        c.props.push({ name, value: items.map(x => (name !== 'ItemData' ? vbStr(x) : x)).join(', ') });
      }
      continue;
    }
    if (ty === 'String') {
      if (name === 'Text' && tname === 'ComboBox' && c.style === 2) continue; // dropdown list: no text stored
      const s = r.str();
      c.props.push({ name, value: vbStr(s), raw: s });
      if (name === 'Caption') c.caption = s;
      if (name === 'Text') c.text = s;
    } else if (ty === 'Long') {
      const v = r.i32();
      const isColor = /Color$/.test(name);
      c.props.push({ name, value: isColor ? hexColor(v) : String(v), raw: v });
      if (name === 'BackColor') c.backColor = v >>> 0;
      if (name === 'ForeColor') c.foreColor = v >>> 0;
    } else if (ty === 'Single' && tname === 'Line') {
      const v = r.i32();
      c.props.push({ name, value: String(v), raw: v });
      if (name === 'X1') c.left = v; else if (name === 'Y1') c.top = v; else if (name === 'X2') c.width = v; else if (name === 'Y2') c.height = v;
    } else if (ty === 'Single') {
      const v = r.f32();
      c.props.push({ name, value: String(v), raw: v });
    } else if (ty === 'Boolean') {
      const v = r.u8() !== 0;
      c.props.push({ name, value: v ? "-1  'True" : "0   'False", raw: v });
      if (name === 'Visible') c.visible = v;
      if (name === 'Enabled') c.enabled = v;
      if (name === 'Checked') c.checked = v;
    } else if (ty === 'Integer') {
      const v = INT16_PROPS.has(name) ? r.i16() : r.u8();
      c.props.push({ name, value: String(v), raw: v });
      if (name === 'BorderStyle') c.borderStyle = v;
      if (name === 'Alignment') c.alignment = v;
      if (name === 'Style') c.style = v;
      if (name === 'Value') c.value = v;
    } else if (/Picture|Imported/.test(ty) && /Picture|Icon|Image|DragIcon|MouseIcon|Palette/.test(name)) {
      const size = r.u32();
      if (size !== 0xffffffff && size > 0) {
        const at = r.p;
        const blob = r.bytes(size);
        // 'lt\0\0' <u32 len> <data>
        let data = blob;
        if (blob[0] === 0x6c && blob[1] === 0x74 && blob.length >= 8) data = blob.subarray(8, 8 + (blob[4] | blob[5] << 8 | blob[6] << 16 | blob[7] << 24));
        c.pictures.push({ prop: name, mime: sniffMime(data), bytes: data, offset: at });
        c.props.push({ name, value: `"(${data.length} bytes)"` });
      }
    } else if (name === 'Font' || /BEF6E003/.test(ty)) {
      r.u8();
      const charset = r.u16();
      const fl = r.u8();
      const weight = r.u16();
      const size = r.u32() / 10000;
      const fname = String.fromCharCode(...r.bytes(r.u8()));
      c.font = { name: fname, size, bold: weight >= 700, italic: !!(fl & 2), underline: !!(fl & 4), strike: !!(fl & 8), charset, weight };
    } else if (name === 'DataFormat' || name === 'DataSource') {
      throw new Error(`${name} block not decoded`);
    } else {
      throw new Error(`unsupported property ${name} (${ty})`);
    }
  }
}

function buildFrm(project: VBProject, obj: VBObject, root: FormControl): string {
  const L: string[] = ['VERSION 5.00'];
  const files = new Map<string, string>();
  for (const comp of project.components) {
    if (comp.guid && comp.file) {
      const lib = comp.libName.split('.')[0];
      if (!files.has(lib)) files.set(lib, `Object = "${comp.guid}#1.0#0"; "${comp.file}"`);
    }
  }
  const used = new Set<string>();
  const walkUsed = (c: FormControl) => { if (c.typeCode === 0xff) used.add(c.className.split('.')[0]); c.children.forEach(walkUsed); };
  walkUsed(root);
  for (const u of used) if (files.has(u)) L.push(files.get(u)!);
  const emit = (c: FormControl, depth: number) => {
    const ind = '   '.repeat(depth);
    L.push(`${ind}Begin ${c.className} ${c.name}`);
    const props = [...c.props];
    if (c.font) {
      L.push(...props.filter(p => p.name < 'Font').map(p => `${ind}   ${p.name.padEnd(16)}=   ${p.value}`));
      L.push(`${ind}   BeginProperty Font`);
      L.push(`${ind}      Name            =   ${vbStr(c.font.name)}`);
      L.push(`${ind}      Size            =   ${c.font.size}`);
      L.push(`${ind}      Charset         =   ${c.font.charset}`);
      L.push(`${ind}      Weight          =   ${c.font.weight}`);
      L.push(`${ind}      Underline       =   ${c.font.underline ? -1 : 0}  'Underline`);
      L.push(`${ind}      Italic          =   ${c.font.italic ? -1 : 0}  'Italic`);
      L.push(`${ind}      Strikethrough   =   ${c.font.strike ? -1 : 0}  'Strikethrough`);
      L.push(`${ind}   EndProperty`);
      L.push(...props.filter(p => p.name >= 'Font').map(p => `${ind}   ${p.name.padEnd(16)}=   ${p.value}`));
    } else {
      L.push(...props.map(p => `${ind}   ${p.name.padEnd(16)}=   ${p.value}`));
    }
    if (c.partial) L.push(`${ind}   ' (some properties could not be decoded)`);
    if (c.typeCode === 0xff) L.push(`${ind}   ' (ActiveX property bag not decoded)`);
    for (const ch of c.children) emit(ch, depth + 1);
    L.push(`${ind}End`);
  };
  emit(root, 0);
  L.push(`Attribute VB_Name = "${obj.name}"`);
  L.push('Attribute VB_GlobalNameSpace = False');
  L.push('Attribute VB_Creatable = False');
  L.push('Attribute VB_PredeclaredId = True');
  L.push('Attribute VB_Exposed = False');
  return L.join('\r\n');
}
