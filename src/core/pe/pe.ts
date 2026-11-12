// Minimal, defensive PE32 parser. Works on a raw file buffer and maps virtual
// addresses to file offsets. Everything the rest of the decompiler reads goes
// through the `Image` class so that malformed files fail gracefully.

export interface Section {
  name: string;
  va: number; // absolute virtual address
  vsize: number;
  rawOffset: number;
  rawSize: number;
  characteristics: number;
  executable: boolean;
}

export interface ImportEntry {
  dll: string;
  name: string | null;
  ordinal: number | null;
  iatVA: number; // absolute address of the IAT slot
}

export interface ResourceEntry {
  type: string;
  name: string;
  lang: number;
  rva: number;
  size: number;
}

export class PEError extends Error {}

export class Image {
  readonly bytes: Uint8Array;
  readonly dv: DataView;
  imageBase = 0;
  entryPoint = 0; // absolute VA
  sizeOfImage = 0;
  machine = 0;
  timestamp = 0;
  characteristics = 0;
  subsystem = 0;
  linkerVersion = '';
  sections: Section[] = [];
  imports: ImportEntry[] = [];
  importsByIat = new Map<number, ImportEntry>();
  resources: ResourceEntry[] = [];
  dataDirs: { rva: number; size: number }[] = [];
  isDll = false;

  constructor(buf: ArrayBuffer | Uint8Array) {
    this.bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.parse();
  }

  private parse() {
    const b = this.bytes;
    if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) throw new PEError('Not an MZ executable');
    const peOff = this.dv.getUint32(0x3c, true);
    if (peOff + 0x18 > b.length || this.dv.getUint32(peOff, true) !== 0x4550) throw new PEError('Missing PE signature');
    const fh = peOff + 4;
    this.machine = this.dv.getUint16(fh, true);
    const nsec = this.dv.getUint16(fh + 2, true);
    this.timestamp = this.dv.getUint32(fh + 4, true);
    const optSize = this.dv.getUint16(fh + 16, true);
    this.characteristics = this.dv.getUint16(fh + 18, true);
    this.isDll = (this.characteristics & 0x2000) !== 0;
    const oh = fh + 20;
    const magic = this.dv.getUint16(oh, true);
    if (magic !== 0x10b) throw new PEError(magic === 0x20b ? 'PE32+ (64-bit) images are not VB5/6 executables' : 'Unknown optional header');
    this.linkerVersion = `${b[oh + 2]}.${b[oh + 3]}`;
    const epRva = this.dv.getUint32(oh + 16, true);
    this.imageBase = this.dv.getUint32(oh + 28, true);
    this.sizeOfImage = this.dv.getUint32(oh + 56, true);
    this.subsystem = this.dv.getUint16(oh + 68, true);
    const ndirs = Math.min(16, this.dv.getUint32(oh + 92, true));
    for (let i = 0; i < ndirs; i++) {
      this.dataDirs.push({ rva: this.dv.getUint32(oh + 96 + i * 8, true), size: this.dv.getUint32(oh + 100 + i * 8, true) });
    }
    this.entryPoint = this.imageBase + epRva;
    let so = oh + optSize;
    for (let i = 0; i < nsec; i++, so += 40) {
      if (so + 40 > b.length) break;
      let name = '';
      for (let j = 0; j < 8 && b[so + j]; j++) name += String.fromCharCode(b[so + j]);
      const vsize = this.dv.getUint32(so + 8, true);
      const va = this.dv.getUint32(so + 12, true);
      const rawSize = this.dv.getUint32(so + 16, true);
      const rawOffset = this.dv.getUint32(so + 20, true);
      const ch = this.dv.getUint32(so + 36, true);
      this.sections.push({
        name, va: this.imageBase + va, vsize: vsize || rawSize, rawOffset, rawSize, characteristics: ch,
        executable: (ch & 0x20000020) !== 0,
      });
    }
    try { this.parseImports(); } catch { /* tolerate */ }
    try { this.parseResources(); } catch { /* tolerate */ }
  }

  sectionOf(va: number): Section | undefined {
    for (const s of this.sections) if (va >= s.va && va < s.va + Math.max(s.vsize, s.rawSize)) return s;
    return undefined;
  }

  /** File offset for a VA, or -1 if it isn't backed by file data. */
  offsetOf(va: number): number {
    va >>>= 0;
    const s = this.sectionOf(va);
    if (s) {
      const d = va - s.va;
      if (d >= s.rawSize) return -1;
      const o = s.rawOffset + d;
      return o < this.bytes.length ? o : -1;
    }
    // headers
    const rva = va - this.imageBase;
    if (rva >= 0 && rva < 0x1000 && rva < this.bytes.length) return rva;
    return -1;
  }

  vaOfOffset(off: number): number {
    for (const s of this.sections) if (off >= s.rawOffset && off < s.rawOffset + s.rawSize) return s.va + (off - s.rawOffset);
    return -1;
  }

  isMapped(va: number): boolean { return this.offsetOf(va) >= 0; }
  inImage(va: number): boolean { va >>>= 0; return va >= this.imageBase && va < this.imageBase + this.sizeOfImage; }

  u8(va: number): number { const o = this.offsetOf(va); return o < 0 ? 0 : this.bytes[o]; }
  u16(va: number): number { const o = this.offsetOf(va); return o < 0 || o + 2 > this.bytes.length ? 0 : this.dv.getUint16(o, true); }
  i16(va: number): number { const v = this.u16(va); return v & 0x8000 ? v - 0x10000 : v; }
  u32(va: number): number { const o = this.offsetOf(va); return o < 0 || o + 4 > this.bytes.length ? 0 : this.dv.getUint32(o, true); }
  i32(va: number): number { return this.u32(va) | 0; }
  f32(va: number): number { const o = this.offsetOf(va); return o < 0 ? 0 : this.dv.getFloat32(o, true); }
  f64(va: number): number { const o = this.offsetOf(va); return o < 0 ? 0 : this.dv.getFloat64(o, true); }

  /** Read up to n bytes at va (may be shorter at section end). */
  slice(va: number, n: number): Uint8Array {
    const o = this.offsetOf(va);
    if (o < 0) return new Uint8Array(0);
    const s = this.sectionOf(va);
    let end = o + n;
    if (s) end = Math.min(end, s.rawOffset + s.rawSize);
    return this.bytes.subarray(o, Math.min(end, this.bytes.length));
  }

  cstr(va: number, max = 512): string {
    const o = this.offsetOf(va);
    if (o < 0) return '';
    let s = '';
    for (let i = 0; i < max && o + i < this.bytes.length; i++) {
      const c = this.bytes[o + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** ANSI string decoded with a codepage-aware decoder (Hebrew/Cyrillic/etc forms). */
  ansi(va: number, max = 512, decoder?: TextDecoder): string {
    const o = this.offsetOf(va);
    if (o < 0) return '';
    let e = o;
    while (e < this.bytes.length && e - o < max && this.bytes[e]) e++;
    const sub = this.bytes.subarray(o, e);
    return decoder ? decoder.decode(sub) : String.fromCharCode(...sub);
  }

  wstr(va: number, maxChars = 4096): string {
    const o = this.offsetOf(va);
    if (o < 0) return '';
    let s = '';
    for (let i = 0; i < maxChars && o + i * 2 + 1 < this.bytes.length; i++) {
      const c = this.dv.getUint16(o + i * 2, true);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  guid(va: number): string {
    const o = this.offsetOf(va);
    if (o < 0 || o + 16 > this.bytes.length) return '';
    return guidAt(this.bytes, o);
  }

  rvaToVa(rva: number) { return this.imageBase + rva; }

  private parseImports() {
    const dir = this.dataDirs[1];
    if (!dir || !dir.rva) return;
    let d = this.rvaToVa(dir.rva);
    for (let n = 0; n < 512; n++, d += 20) {
      const oft = this.u32(d), nameRva = this.u32(d + 12), ft = this.u32(d + 16);
      if (!nameRva && !ft) break;
      const dll = this.cstr(this.rvaToVa(nameRva), 256);
      let thunk = this.rvaToVa(oft || ft);
      let iat = this.rvaToVa(ft);
      for (let k = 0; k < 65536; k++, thunk += 4, iat += 4) {
        const v = this.u32(thunk);
        if (!v) break;
        let entry: ImportEntry;
        if (v & 0x80000000) entry = { dll, name: null, ordinal: v & 0xffff, iatVA: iat };
        else entry = { dll, name: this.cstr(this.rvaToVa(v) + 2, 256), ordinal: null, iatVA: iat };
        this.imports.push(entry);
        this.importsByIat.set(iat, entry);
      }
    }
  }

  private parseResources() {
    const dir = this.dataDirs[2];
    if (!dir || !dir.rva) return;
    const base = this.rvaToVa(dir.rva);
    const typeNames: Record<number, string> = {
      1: 'CURSOR', 2: 'BITMAP', 3: 'ICON', 4: 'MENU', 5: 'DIALOG', 6: 'STRING', 7: 'FONTDIR', 8: 'FONT',
      9: 'ACCELERATOR', 10: 'RCDATA', 11: 'MESSAGETABLE', 12: 'GROUP_CURSOR', 14: 'GROUP_ICON', 16: 'VERSION', 24: 'MANIFEST',
    };
    const nameOf = (v: number, isType: boolean) => {
      if (v & 0x80000000) {
        const p = base + (v & 0x7fffffff);
        const len = this.u16(p);
        let s = '';
        for (let i = 0; i < len && i < 256; i++) s += String.fromCharCode(this.u16(p + 2 + i * 2));
        return s;
      }
      return isType ? (typeNames[v] ?? String(v)) : String(v);
    };
    const walk = (dirVa: number, depth: number, path: string[], seen: Set<number>) => {
      if (depth > 3 || seen.has(dirVa)) return;
      seen.add(dirVa);
      const nNamed = this.u16(dirVa + 12), nId = this.u16(dirVa + 14);
      for (let i = 0; i < nNamed + nId && i < 4096; i++) {
        const e = dirVa + 16 + i * 8;
        const nm = this.u32(e), off = this.u32(e + 4);
        const label = depth === 2 ? String(nm & 0xffff) : nameOf(nm, depth === 0);
        if (off & 0x80000000) walk(base + (off & 0x7fffffff), depth + 1, [...path, label], seen);
        else {
          const de = base + off;
          this.resources.push({ type: path[0] ?? '?', name: path[1] ?? label, lang: depth === 2 ? nm & 0xffff : 0, rva: this.u32(de), size: this.u32(de + 4) });
        }
      }
    };
    walk(base, 0, [], new Set());
  }
}

export function guidAt(b: Uint8Array, o: number): string {
  const h = (x: number) => x.toString(16).padStart(2, '0');
  const d1 = (b[o + 3] << 24 | b[o + 2] << 16 | b[o + 1] << 8 | b[o]) >>> 0;
  const d2 = b[o + 5] << 8 | b[o + 4];
  const d3 = b[o + 7] << 8 | b[o + 6];
  let s = '{' + d1.toString(16).padStart(8, '0') + '-' + d2.toString(16).padStart(4, '0') + '-' + d3.toString(16).padStart(4, '0') + '-';
  s += h(b[o + 8]) + h(b[o + 9]) + '-';
  for (let i = 10; i < 16; i++) s += h(b[o + i]);
  return (s + '}').toUpperCase();
}

export const hex = (v: number, pad = 0) => (v >>> 0).toString(16).toUpperCase().padStart(pad, '0');
