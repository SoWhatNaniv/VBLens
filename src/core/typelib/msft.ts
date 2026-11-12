// Parser for MSFT-format COM type libraries (.tlb, .olb, or the TYPELIB
// resource embedded in .ocx/.dll files). Produces a compact model used to
// resolve control events, vtable calls and form property codes.

import { guidAt, Image } from '../pe/pe';

export type TKind = 'enum' | 'record' | 'module' | 'interface' | 'dispatch' | 'coclass' | 'alias' | 'union';
const TKINDS: TKind[] = ['enum', 'record', 'module', 'interface', 'dispatch', 'coclass', 'alias', 'union'];

export interface TLParam { name: string; type: string; flags: number }
export interface TLFunc {
  name: string;
  memid: number;
  invkind: number; // 1=func 2=propget 4=propput 8=propputref
  vtOffset: number;
  params: TLParam[];
  ret: string;
  hidden: boolean;
  optionalCount: number;
}
export interface TLVar { name: string; memid: number; type: string; value?: number | string }
export interface TLImpl { name: string; guid: string; flags: number; index: number; external: boolean }
export interface TLType {
  index: number;
  kind: TKind;
  name: string;
  guid: string;
  flags: number;
  doc: string;
  funcs: TLFunc[];
  vars: TLVar[];
  impls: TLImpl[];
  cbSizeVft: number;
}
export interface TypeLib {
  name: string;
  guid: string;
  doc: string;
  version: string;
  types: TLType[];
}

const VT_NAMES: Record<number, string> = {
  0: 'Empty', 1: 'Null', 2: 'Integer', 3: 'Long', 4: 'Single', 5: 'Double', 6: 'Currency', 7: 'Date', 8: 'String',
  9: 'Object', 10: 'SCODE', 11: 'Boolean', 12: 'Variant', 13: 'IUnknown', 14: 'Decimal', 16: 'SByte', 17: 'Byte',
  18: 'UShort', 19: 'ULong', 20: 'LongLong', 21: 'ULongLong', 22: 'Long', 23: 'ULong', 24: 'Void', 25: 'HRESULT',
  26: 'Ptr', 27: 'SafeArray', 28: 'CArray', 29: 'UserDefined', 30: 'LPSTR', 31: 'LPWSTR', 64: 'FileTime',
};

export function parseTypeLib(bytes: Uint8Array): TypeLib {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => (o >= 0 && o + 4 <= bytes.length ? dv.getUint32(o, true) : 0);
  const i32 = (o: number) => (o >= 0 && o + 4 <= bytes.length ? dv.getInt32(o, true) : 0);
  const u16 = (o: number) => (o >= 0 && o + 2 <= bytes.length ? dv.getUint16(o, true) : 0);
  if (u32(0) !== 0x5446534d) {
    if (bytes[0] === 0x53 && bytes[1] === 0x4c && bytes[2] === 0x54 && bytes[3] === 0x47) throw new Error('SLTG type libraries are not supported yet');
    throw new Error('Not an MSFT type library');
  }
  const varflags = u32(0x14);
  const nTypes = u32(0x20);
  let pos = 0x54;
  if (varflags & 0x100) pos += 4;
  const tiOffsets: number[] = [];
  for (let i = 0; i < nTypes; i++) tiOffsets.push(u32(pos + i * 4));
  pos += nTypes * 4;
  const seg: { off: number; len: number }[] = [];
  for (let i = 0; i < 15; i++) seg.push({ off: i32(pos + i * 16), len: i32(pos + i * 16 + 4) });
  const [sTI, sImpInfo, sImpFiles, sRef, , sGuid, , sName, sString, sTypeDesc] = seg;
  void sImpFiles;

  const name = (off: number): string => {
    if (off < 0 || sName.off < 0) return '';
    const o = sName.off + off;
    const len = bytes[o + 8] ?? 0;
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[o + 12 + i]);
    return s;
  };
  const str = (off: number): string => {
    if (off < 0 || sString.off < 0) return '';
    const o = sString.off + off;
    const len = u16(o);
    let s = '';
    for (let i = 0; i < len && o + 2 + i < bytes.length; i++) s += String.fromCharCode(bytes[o + 2 + i]);
    return s;
  };
  const guid = (off: number): string => (off < 0 || sGuid.off < 0 ? '' : guidAt(bytes, sGuid.off + off));

  const tiBase = (i: number) => sTI.off + i * 0x64;
  const tiName = (i: number) => name(i32(tiBase(i) + 0x34));

  // Imported type references: hreftype with bit 0 set => offset into import info
  const importName = (href: number): { name: string; guid: string } => {
    const o = sImpInfo.off + (href & ~3);
    // MSFT_ImpInfo: { DWORD flags; DWORD oImpFile; DWORD oGuid }
    const flags = u32(o);
    const oGuid = i32(o + 8);
    // For imported types, flags & 1 => oGuid is guid offset; name may be unknown
    if (flags & 1) return { name: '', guid: guid(oGuid) };
    return { name: '', guid: '' };
  };
  const hrefName = (href: number): string => {
    if (href & 1) return importName(href).guid || 'Imported';
    const idx = Math.floor(href / 0x64);
    return idx < nTypes ? tiName(idx) : `#${href}`;
  };

  const typeStr = (dt: number, depth = 0): string => {
    if (depth > 8) return '?';
    if (dt < 0 || dt & 0x80000000) {
      const vt = dt & 0xffff;
      return VT_NAMES[vt & 0x0fff] ?? `VT${vt}`;
    }
    const o = sTypeDesc.off + dt;
    const vt = u16(o);
    const ref = i32(o + 4);
    const base = vt & 0x0fff;
    if (base === 26) return typeStr(ref, depth + 1) + '*';
    if (base === 27) return typeStr(ref, depth + 1) + '()';
    if (base === 28) return 'CArray';
    if (base === 29) return hrefName(ref);
    return VT_NAMES[base] ?? `VT${vt}`;
  };

  const types: TLType[] = [];
  for (let i = 0; i < nTypes; i++) {
    const b = tiBase(i);
    const kindRaw = u32(b) & 0xf;
    const memoff = i32(b + 4);
    const cel = u32(b + 0x18);
    const nFuncs = cel & 0xffff, nVars = cel >>> 16;
    const t: TLType = {
      index: i,
      kind: TKINDS[kindRaw] ?? 'interface',
      name: tiName(i),
      guid: guid(i32(b + 0x2c)),
      flags: u32(b + 0x30),
      doc: str(i32(b + 0x3c)),
      funcs: [], vars: [], impls: [],
      cbSizeVft: u16(b + 0x4e),
    };
    const cImpl = u16(b + 0x4c);
    const dt1 = i32(b + 0x54);
    // implemented interfaces
    if (t.kind === 'coclass' && dt1 >= 0) {
      let r = dt1;
      for (let k = 0; k < 64 && r >= 0; k++) {
        const ro = sRef.off + r;
        const href = i32(ro);
        const flags = i32(ro + 4);
        const ext = (href & 1) === 1;
        const idx = ext ? -1 : Math.floor(href / 0x64);
        t.impls.push({ name: ext ? '' : tiName(idx), guid: ext ? importName(href).guid : guid(i32(tiBase(idx) + 0x2c)), flags, index: idx, external: ext });
        r = i32(ro + 12);
      }
    } else if ((t.kind === 'interface' || t.kind === 'dispatch') && cImpl > 0 && dt1 >= 0) {
      const ext = (dt1 & 1) === 1;
      const idx = ext ? -1 : Math.floor(dt1 / 0x64);
      t.impls.push({ name: ext ? '' : tiName(idx), guid: ext ? importName(dt1).guid : idx < nTypes ? guid(i32(tiBase(idx) + 0x2c)) : '', flags: 0, index: idx, external: ext });
    }
    if (memoff > 0 && memoff < bytes.length && nFuncs + nVars > 0) {
      const infolen = u32(memoff);
      const recBase = memoff + 4;
      const arrBase = recBase + infolen;
      const n = nFuncs + nVars;
      const ids: number[] = [], names: number[] = [], offs: number[] = [];
      for (let k = 0; k < n; k++) {
        ids.push(u32(arrBase + k * 4));
        names.push(i32(arrBase + n * 4 + k * 4));
        offs.push(u32(arrBase + n * 8 + k * 4));
      }
      for (let k = 0; k < nFuncs; k++) {
        const ro = recBase + offs[k];
        const recSize = u16(ro);
        const dataType = i32(ro + 4);
        const flags = u32(ro + 8);
        const vtOff = u16(ro + 0x0c) & ~1;
        const fkccic = u32(ro + 0x10);
        const nargs = u16(ro + 0x14);
        const noargs = u16(ro + 0x16);
        const invkind = (fkccic >>> 3) & 0xf;
        const params: TLParam[] = [];
        // parameter records are at the end of the record
        const pBase = ro + recSize - nargs * 12;
        for (let a = 0; a < nargs; a++) {
          const po = pBase + a * 12;
          params.push({ type: typeStr(i32(po)), name: name(i32(po + 4)), flags: u32(po + 8) });
        }
        t.funcs.push({
          name: name(names[k]), memid: ids[k] | 0, invkind, vtOffset: vtOff, params, ret: typeStr(dataType),
          hidden: (flags & 0x40) !== 0, optionalCount: noargs,
        });
      }
      for (let k = nFuncs; k < n; k++) {
        const ro = recBase + offs[k];
        const dataType = i32(ro + 4);
        const varKind = u16(ro + 0x0c);
        const oValue = i32(ro + 0x10);
        const v: TLVar = { name: name(names[k]), memid: ids[k] | 0, type: typeStr(dataType) };
        if (varKind === 2) {
          // VAR_CONST: oValue is either inline (high bit) or offset of a VARIANT in custom data
          if (oValue < 0) v.value = oValue & 0x3ffffff;
          else {
            const co = seg[11].off + oValue;
            const vt = u16(co);
            if (vt === 3 || vt === 22 || vt === 19) v.value = i32(co + 2);
            else if (vt === 2 || vt === 18) v.value = (u16(co + 2) << 16) >> 16;
            else if (vt === 8) {
              const len = u32(co + 2);
              let s = '';
              for (let c = 0; c < len && c < 1024; c++) s += String.fromCharCode(bytes[co + 6 + c]);
              v.value = s;
            }
          }
        }
        t.vars.push(v);
      }
    }
    types.push(t);
  }
  const libNameOff = i32(0x38);
  const ver = u32(0x18);
  return {
    name: name(libNameOff), guid: guid(i32(0x08)), doc: str(i32(0x24)),
    version: `${ver & 0xffff}.${ver >>> 16}`, types,
  };
}

/** Extract the embedded TYPELIB resource from an OCX/DLL, or accept a raw .tlb/.olb. */
export function loadTypeLibFromFile(bytes: Uint8Array): TypeLib {
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const img = new Image(bytes);
    const r = img.resources.find(r => r.type.toUpperCase() === 'TYPELIB');
    if (!r) throw new Error('No TYPELIB resource in this file');
    const off = img.offsetOf(img.imageBase + r.rva);
    return parseTypeLib(bytes.subarray(off, off + r.size));
  }
  return parseTypeLib(bytes);
}

/** Compact control description derived from a coclass. */
export interface ControlClassInfo {
  name: string;
  lib: string;
  clsid: string;
  iface: string; // default interface name
  ifaceGuid: string;
  eventsGuid: string;
  events: string[]; // ordered by vtable slot / dispatch order
  eventParams: string[][];
  // members of the default interface keyed by vtable offset
  members: Record<number, { name: string; kind: 'get' | 'let' | 'set' | 'method'; params: string[]; ret: string }>;
  dispids: Record<number, { name: string; type: string }>; // property-get dispid -> name/type
}

export function controlClassesFromTypeLib(tl: TypeLib): ControlClassInfo[] {
  const out: ControlClassInfo[] = [];
  const byIndex = (i: number) => tl.types[i];
  for (const t of tl.types) {
    if (t.kind !== 'coclass') continue;
    const def = t.impls.find(i => (i.flags & 3) === 1) ?? t.impls.find(i => !(i.flags & 2));
    const src = t.impls.find(i => (i.flags & 3) === 3) ?? t.impls.find(i => (i.flags & 2) === 2);
    const info: ControlClassInfo = {
      name: t.name, lib: tl.name, clsid: t.guid, iface: def?.name ?? '', ifaceGuid: def?.guid ?? '',
      eventsGuid: src?.guid ?? '', events: [], eventParams: [], members: {}, dispids: {},
    };
    if (src && !src.external && src.index >= 0) {
      const ev = byIndex(src.index);
      const fs = [...ev.funcs];
      if (ev.kind === 'interface') fs.sort((a, b) => a.vtOffset - b.vtOffset);
      for (const f of fs) { info.events.push(f.name); info.eventParams.push(f.params.map(p => `${p.name} As ${p.type}`)); }
    }
    if (def && !def.external && def.index >= 0) {
      // Walk interface + bases for vtable members
      let cur: TLType | undefined = byIndex(def.index);
      for (let guard = 0; cur && guard < 8; guard++) {
        for (const f of cur.funcs) {
          const kind = f.invkind === 2 ? 'get' : f.invkind === 4 ? 'let' : f.invkind === 8 ? 'set' : 'method';
          if (cur.kind === 'interface' && info.members[f.vtOffset] === undefined) {
            info.members[f.vtOffset] = { name: f.name, kind, params: f.params.map(p => p.type), ret: f.ret };
          }
          if (f.invkind === 2 && info.dispids[f.memid] === undefined) {
            const last = f.params[f.params.length - 1];
            const ty = cur.kind === 'interface' ? (last ? last.type.replace(/\*$/, '') : f.ret) : f.ret;
            info.dispids[f.memid] = { name: f.name, type: ty };
          } else if (f.invkind !== 2 && info.dispids[f.memid] === undefined && !cur.funcs.some(g => g.memid === f.memid && g.invkind === 2)) {
            info.dispids[f.memid] = { name: f.name, type: '' }; // methods / write-only properties
          }
        }
        const base: TLImpl | undefined = cur.impls[0];
        cur = base && !base.external && base.index >= 0 ? byIndex(base.index) : undefined;
      }
    }
    out.push(info);
  }
  return out;
}
