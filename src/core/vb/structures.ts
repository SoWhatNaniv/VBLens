// Parser for the Visual Basic 5/6 runtime structures embedded in a compiled
// executable: VBHeader ("VB5!"), ProjectInfo, ObjectTable, object descriptors,
// ObjectInfo / OptionalObjectInfo, control descriptors and event tables,
// API Declare table and the GUI (form) table.

import { Image, hex } from '../pe/pe';
import { VB_CLASSES_BY_EVENT_GUID } from '../data/vbclasses';
import { runtimeOrdinalName } from '../analysis/runtime';

export type ObjectKind = 'Module' | 'Form' | 'MDIForm' | 'Class' | 'UserControl' | 'PropertyPage' | 'UserDocument' | 'Designer';

export interface VBEventSlot {
  slot: number;
  name: string;
  stubVA: number; // address in the event table
  targetVA: number; // resolved handler code (native) or 0
}

export interface VBControl {
  index: number;
  name: string;
  va: number;
  flags: number;
  fieldOffset: number; // offset of the control reference inside the object instance (+0x04)
  eventGuid: string;
  className: string; // e.g. "CommandButton" or "{GUID}" for unknown ActiveX
  libName: string; // VB / MSComctlLib ...
  eventCount: number;
  eventTableVA: number;
  ctlIndex: number; // control ID
  isArray: boolean; // member of a control array
  events: VBEventSlot[];
}

export interface VBMethod {
  index: number; // index in the object's method name table
  name: string | null;
  tableIndex: number; // index in vtable tail
  stubVA: number;
  targetVA: number;
  vtableOffset: number;
}

export interface VBAccessor { vtableOffset: number; field: number; kind: 'get' | 'let' | 'set'; type: string; tableIndex: number }

export interface VBObject {
  index: number;
  name: string;
  kind: ObjectKind;
  descVA: number;
  infoVA: number;
  optInfoVA: number;
  typeFlags: number;
  methodCount: number;
  methodNames: (string | null)[];
  objectGuid: string;
  controls: VBControl[];
  methodTableVA: number;
  methodTableCount: number;
  methods: VBMethod[]; // resolved vtable methods (forms/classes/usercontrols)
  accessors: VBAccessor[]; // public variable Get/Let thunks (table entries before the methods)
  vtableBase: number;
  publicBytesVA: number;
  staticBytesVA: number;
  modulePublicVA: number;
  moduleStaticVA: number;
  pcodeMethodCount: number;
  pcodeMethodsVA: number; // ObjectInfo.lpMethods (P-code ProcDscInfo array)
  guiIndex: number;
  formDataVA: number;
  formDataSize: number;
  constantsVA: number;
  constantsCount: number;
}

export interface VBDeclare {
  index: number;
  va: number;
  type: number;
  lib: string;
  func: string;
  entryVA: number; // per-declare data block
}

export interface VBComponent {
  index: number;
  va: number;
  guid: string;
  name: string;
  libName: string;
  file: string;
  raw: string[];
}

export interface VBProject {
  headerVA: number;
  runtimeBuild: number;
  runtimeRevision: number;
  langDll: string;
  secLangDll: string;
  lcid: number;
  secLcid: number;
  subMainVA: number;
  projectInfoVA: number;
  threadFlags: number;
  threadCount: number;
  formCount: number;
  externalCount: number;
  thunkCount: number;
  guiTableVA: number;
  externalComponentTableVA: number;
  comRegDataVA: number;
  projectDescription: string;
  projectExeName: string;
  projectHelpFile: string;
  projectName: string;
  projectInfoVersion: number;
  objectTableVA: number;
  codeStart: number;
  codeEnd: number;
  dataSize: number;
  nativeCodeVA: number;
  isPCode: boolean;
  pathInformation: string;
  externalTableVA: number;
  declares: VBDeclare[];
  objects: VBObject[];
  components: VBComponent[];
  projectGuid: string;
  compiledObjects: number;
  warnings: string[];
  vbVersion: 5 | 6;
}

const VB_FORM_VTABLE_BASE = 0x6f8;
const VB_MDIFORM_VTABLE_BASE = 0x6f8;
const VB_USERCONTROL_VTABLE_BASE = 0x7a4;
const VB_CLASS_VTABLE_BASE = 0x1c;

export function findVBHeader(img: Image): number {
  // Classic entry: push offset VBHeader; call ThunRTMain
  const ep = img.entryPoint;
  if (img.u8(ep) === 0x68) {
    const va = img.u32(ep + 1);
    if (img.cstr(va, 4) === 'VB5!') return va;
  }
  // Fallback: scan sections for the signature
  for (const s of img.sections) {
    const data = img.bytes.subarray(s.rawOffset, s.rawOffset + s.rawSize);
    for (let i = 0; i + 4 < data.length; i++) {
      if (data[i] === 0x56 && data[i + 1] === 0x42 && data[i + 2] === 0x35 && data[i + 3] === 0x21) {
        const va = s.va + i;
        const pi = img.u32(va + 0x30);
        if (img.isMapped(pi) && img.u32(pi) === 0x1f4) return va;
      }
    }
  }
  return 0;
}

function kindFromFlags(flags: number): ObjectKind {
  if (!(flags & 0x02)) return 'Module';
  if (flags & 0x80) return 'Form';
  return 'Class';
}

export function parseVBProject(img: Image): VBProject {
  const h = findVBHeader(img);
  if (!h) throw new Error('This file does not look like a Visual Basic 5/6 executable (no "VB5!" header found).');
  const warnings: string[] = [];
  const strAt = (off: number) => (off ? img.cstr(h + off, 260) : '');
  const pi = img.u32(h + 0x30);
  const p: VBProject = {
    headerVA: h,
    runtimeBuild: img.u16(h + 4),
    langDll: img.cstr(h + 6, 14),
    secLangDll: img.cstr(h + 0x14, 14),
    runtimeRevision: img.u16(h + 0x22),
    lcid: img.u32(h + 0x24),
    secLcid: img.u32(h + 0x28),
    subMainVA: img.u32(h + 0x2c),
    projectInfoVA: pi,
    threadFlags: img.u32(h + 0x3c),
    threadCount: img.u32(h + 0x40),
    formCount: img.u16(h + 0x44),
    externalCount: img.u16(h + 0x46),
    thunkCount: img.u32(h + 0x48),
    guiTableVA: img.u32(h + 0x4c),
    externalComponentTableVA: img.u32(h + 0x50),
    comRegDataVA: img.u32(h + 0x54),
    projectDescription: strAt(img.u32(h + 0x58)),
    projectExeName: strAt(img.u32(h + 0x5c)),
    projectHelpFile: strAt(img.u32(h + 0x60)),
    projectName: strAt(img.u32(h + 0x64)),
    projectInfoVersion: img.u32(pi),
    objectTableVA: img.u32(pi + 4),
    codeStart: img.u32(pi + 0x0c),
    codeEnd: img.u32(pi + 0x10),
    dataSize: img.u32(pi + 0x14),
    nativeCodeVA: img.u32(pi + 0x20),
    isPCode: img.u32(pi + 0x20) === 0,
    pathInformation: img.wstr(pi + 0x24, 264),
    externalTableVA: img.u32(pi + 0x234),
    declares: [],
    objects: [],
    components: [],
    projectGuid: '',
    compiledObjects: 0,
    warnings,
    vbVersion: 6,
  };
  // MSVBVM50 imports => VB5
  if (img.imports.some(i => /msvbvm50/i.test(i.dll))) p.vbVersion = 5;

  const ot = p.objectTableVA;
  if (!img.isMapped(ot)) throw new Error('Object table pointer is invalid (packed or corrupted file?)');
  p.projectGuid = img.guid(ot + 0x18);
  const total = img.u16(ot + 0x2a);
  p.compiledObjects = img.u16(ot + 0x2c);
  const arr = img.u32(ot + 0x30);
  const otName = img.cstr(img.u32(ot + 0x40), 260);
  if (!p.projectName) p.projectName = otName;

  for (let i = 0; i < total && i < 4096; i++) {
    try {
      p.objects.push(parseObject(img, p, arr + i * 0x30, i));
    } catch (e) {
      warnings.push(`Object #${i}: ${(e as Error).message}`);
    }
  }
  // Map WithEvents / Implements references to project objects (by interface GUID)
  const objByIface = new Map<string, VBObject>();
  for (const o of p.objects) if (o.optInfoVA) {
    const g2 = img.u32(o.optInfoVA + 0x1c);
    if (img.isMapped(g2)) { const gp = img.u32(g2); if (img.isMapped(gp)) objByIface.set(img.guid(gp), o); }
  }
  for (const o of p.objects) for (const c of o.controls) {
    if (c.libName) continue;
    const t = objByIface.get(c.eventGuid);
    if (t) { c.className = t.name; c.libName = p.projectName; }
  }
  try { parseDeclares(img, p); } catch (e) { warnings.push('API declares: ' + (e as Error).message); }
  try { parseGuiTable(img, p); } catch (e) { warnings.push('GUI table: ' + (e as Error).message); }
  try { parseComponents(img, p); } catch (e) { warnings.push('External components: ' + (e as Error).message); }
  return p;
}

function readMethodTarget(img: Image, stub: number, codeStart: number, codeEnd: number): number {
  // Native vtable entries point at "jmp rel32" (sometimes preceded by
  // "sub dword ptr [esp+4], imm" this-adjustor). Event table entries point at
  // the adjustor.
  let va = stub;
  for (let k = 0; k < 3; k++) {
    const b0 = img.u8(va);
    if (b0 === 0xe9) {
      const t = (va + 5 + img.i32(va + 1)) >>> 0;
      return t;
    }
    if (b0 === 0xeb) return (va + 2 + ((img.u8(va + 1) << 24) >> 24)) >>> 0;
    // 81 6C 24 04 imm32 : sub dword ptr [esp+4], imm32
    if (b0 === 0x81 && img.u8(va + 1) === 0x6c && img.u8(va + 2) === 0x24 && img.u8(va + 3) === 0x04) { va += 8; continue; }
    // 83 6C 24 04 imm8
    if (b0 === 0x83 && img.u8(va + 1) === 0x6c && img.u8(va + 2) === 0x24 && img.u8(va + 3) === 0x04) { va += 5; continue; }
    break;
  }
  void codeStart; void codeEnd;
  return 0;
}

function parseObject(img: Image, p: VBProject, od: number, index: number): VBObject {
  const oi = img.u32(od);
  const flags = img.u32(od + 0x28);
  const methodCount = img.u32(od + 0x1c);
  const namesVA = img.u32(od + 0x20);
  const methodNames: (string | null)[] = [];
  if (namesVA && img.isMapped(namesVA) && methodCount < 65536) {
    for (let j = 0; j < methodCount; j++) {
      const np = img.u32(namesVA + j * 4);
      methodNames.push(np && img.isMapped(np) ? img.cstr(np, 256) : null);
    }
  }
  const o: VBObject = {
    index,
    name: img.cstr(img.u32(od + 0x18), 260) || `Object${index}`,
    kind: kindFromFlags(flags),
    descVA: od,
    infoVA: oi,
    optInfoVA: 0,
    typeFlags: flags,
    methodCount,
    methodNames,
    objectGuid: '',
    controls: [],
    methodTableVA: 0,
    methodTableCount: 0,
    methods: [],
    accessors: [],
    vtableBase: 0,
    publicBytesVA: img.u32(od + 0x08),
    staticBytesVA: img.u32(od + 0x0c),
    modulePublicVA: img.u32(od + 0x10),
    moduleStaticVA: img.u32(od + 0x14),
    pcodeMethodCount: 0,
    pcodeMethodsVA: 0,
    guiIndex: -1,
    formDataVA: 0,
    formDataSize: 0,
    constantsVA: 0,
    constantsCount: 0,
  };
  if (!oi || !img.isMapped(oi)) return o;
  o.pcodeMethodCount = img.u16(oi + 0x20);
  o.pcodeMethodsVA = img.u32(oi + 0x24);
  o.constantsCount = img.u16(oi + 0x28);
  o.constantsVA = img.u32(oi + 0x34);
  if (flags & 0x02) {
    const opt = oi + 0x38;
    o.optInfoVA = opt;
    const guidCount = img.u32(opt);
    const guidPtr = img.u32(opt + 4);
    if (guidCount && img.isMapped(guidPtr)) o.objectGuid = img.guid(guidPtr);
    const ctlCount = img.u32(opt + 0x20);
    const ctlVA = img.u32(opt + 0x24);
    o.methodTableCount = img.u16(opt + 0x28);
    o.methodTableVA = img.u32(opt + 0x30);
    if (ctlCount < 10000 && img.isMapped(ctlVA)) {
      for (let c = 0; c < ctlCount; c++) o.controls.push(parseControl(img, p, ctlVA + c * 0x28, c));
    }
    // Determine the precise kind from the designer's own control entry
    for (const c of o.controls) {
      const k = c.className;
      if (k === 'Form') { o.kind = 'Form'; break; }
      if (k === 'MDIForm') { o.kind = 'MDIForm'; break; }
      if (k === 'UserControl') { o.kind = 'UserControl'; break; }
      if (k === 'PropertyPage') { o.kind = 'PropertyPage'; break; }
      if (k === 'UserDocument') { o.kind = 'UserDocument'; break; }
    }
    if (o.kind === 'Form' && !o.controls.some(c => c.className === 'Form' || c.className === 'MDIForm')) {
      // A form without its own Form control entry is unusual, keep "Form"
    }
    o.vtableBase = o.kind === 'Class' ? VB_CLASS_VTABLE_BASE : o.kind === 'UserControl' ? VB_USERCONTROL_VTABLE_BASE
      : o.kind === 'MDIForm' ? VB_MDIFORM_VTABLE_BASE : VB_FORM_VTABLE_BASE;
    if (!p.isPCode && o.methodTableCount < 100000 && img.isMapped(o.methodTableVA)) {
      // The table holds: [control get/set thunks...] [methods...] [trailing thunks]
      const entries: { stub: number; target: number }[] = [];
      for (let k = 0; k < o.methodTableCount; k++) {
        const stub = img.u32(o.methodTableVA + k * 4);
        const target = stub ? readMethodTarget(img, stub, p.codeStart, p.codeEnd) : 0;
        entries.push({ stub, target });
      }
      // Public variable accessors: add dword ptr [esp+4], X ; mov ecx, thunk ; jmp ecx
      entries.forEach((e, k) => {
        const st = e.stub;
        if (!st) return;
        let field = -1, p2 = 0;
        if (img.u8(st) === 0x81 && img.u8(st + 1) === 0x44 && img.u8(st + 2) === 0x24 && img.u8(st + 3) === 0x04) { field = img.u32(st + 4); p2 = st + 8; }
        else if (img.u8(st) === 0x83 && img.u8(st + 1) === 0x44 && img.u8(st + 2) === 0x24 && img.u8(st + 3) === 0x04) { field = img.u8(st + 4); p2 = st + 5; }
        if (field < 0 || img.u8(p2) !== 0xb9) return;
        const thunk = img.u32(p2 + 1);
        // thunk: jmp dword ptr [IAT]
        let nm = '';
        if (img.u8(thunk) === 0xff && img.u8(thunk + 1) === 0x25) {
          const imp = img.importsByIat.get(img.u32(thunk + 2));
          nm = imp ? (imp.name ?? (imp.ordinal !== null ? runtimeOrdinalName(imp.dll, imp.ordinal) ?? '' : '')) : '';
        }
        const m = /^(Get|Put|Set)Mem(\w+)$/.exec(nm);
        if (!m) return;
        o.accessors.push({ vtableOffset: o.vtableBase + k * 4, field, kind: m[1] === 'Get' ? 'get' : m[1] === 'Put' ? 'let' : 'set', type: m[2], tableIndex: k });
      });
      // Method entries are those resolving to code in the project code range.
      // The last `methodCount` such entries map 1:1 to the method name table.
      const inCode = (t: number) => t >= p.codeStart && t < p.codeEnd;
      let first = entries.findIndex(e => inCode(e.target));
      if (first >= 0) {
        // methods are contiguous from `first` (a null stub = method not implemented)
        let mi = 0;
        for (let k = first; k < entries.length && mi < Math.max(methodCount, 1) + 64; k++) {
          const e = entries[k];
          if (!e.stub) { mi++; continue; }
          if (!inCode(e.target)) {
            // could be a stub jumping to a runtime thunk: stop at trailing thunks ("pop eax")
            if (img.u8(e.stub) === 0x58) break;
            mi++;
            continue;
          }
          o.methods.push({
            index: mi,
            name: methodNames[mi] ?? null,
            tableIndex: k,
            stubVA: e.stub,
            targetVA: e.target,
            vtableOffset: o.vtableBase + k * 4,
          });
          mi++;
        }
      }
    }
  }
  return o;
}

function parseControl(img: Image, p: VBProject, va: number, index: number): VBControl {
  const flags = img.u16(va);
  const eventCount = img.u16(va + 2);
  const fieldOffset = img.u32(va + 4);
  const guidVA = img.u32(va + 8);
  const ctlIndex = img.u16(va + 0x0c);
  const eventTableVA = img.u32(va + 0x18);
  const name = img.cstr(img.u32(va + 0x20), 260);
  const eventGuid = img.isMapped(guidVA) ? img.guid(guidVA) : '';
  let known = VB_CLASSES_BY_EVENT_GUID[eventGuid];
  let isArray = false;
  if (!known && eventGuid) {
    // Control arrays use the events GUID + 1 (events get an extra Index parameter)
    const d1 = parseInt(eventGuid.slice(1, 9), 16);
    const alt = '{' + ((d1 - 1) >>> 0).toString(16).toUpperCase().padStart(8, '0') + eventGuid.slice(9);
    known = VB_CLASSES_BY_EVENT_GUID[alt];
    if (known) isArray = true;
  }
  const c: VBControl = {
    index, name, va, flags, fieldOffset, eventGuid,
    className: known ? known.name : eventGuid,
    libName: known ? known.lib : '',
    eventCount, eventTableVA, ctlIndex, events: [], isArray,
  };
  // The runtime event table of designers (UserControl...) has extra leading slots that
  // the event interface in the type library does not list.
  const shift = known && known.name === 'UserControl' && eventCount > known.events.length ? 9 : 0;
  if (eventCount < 2048 && img.isMapped(eventTableVA)) {
    for (let e = 0; e < eventCount; e++) {
      const stub = img.u32(eventTableVA + 0x18 + e * 4);
      if (!stub) continue;
      const target = p.isPCode ? 0 : readMethodTarget(img, stub, p.codeStart, p.codeEnd);
      const nm = shift && e === 7 ? 'Resize' : known?.events[e - shift]; // UserControl runtime slot 7 is Resize
      c.events.push({ slot: e, name: nm ?? `Event${e}`, stubVA: stub, targetVA: target });
    }
  }
  return c;
}

function parseDeclares(img: Image, p: VBProject) {
  const t = p.externalTableVA;
  const n = img.u32(p.projectInfoVA + 0x238);
  if (!t || !img.isMapped(t) || n > 100000) return;
  for (let i = 0; i < n; i++) {
    const e = t + i * 8;
    const type = img.u32(e);
    const data = img.u32(e + 4);
    if (!img.isMapped(data)) continue;
    if (type === 7) {
      const lib = img.cstr(img.u32(data), 260);
      const func = img.cstr(img.u32(data + 4), 260);
      p.declares.push({ index: i, va: e, type, lib, func, entryVA: data });
    } else {
      p.declares.push({ index: i, va: e, type, lib: '', func: '', entryVA: data });
    }
  }
}

function parseGuiTable(img: Image, p: VBProject) {
  if (!p.guiTableVA || !img.isMapped(p.guiTableVA)) return;
  const byName = new Map<string, VBObject>();
  for (const o of p.objects) if (o.kind !== 'Module' && o.kind !== 'Class') byName.set(o.name.toLowerCase(), o);
  const designers = p.objects.filter(o => o.kind !== 'Module' && o.kind !== 'Class');
  for (let i = 0; i < p.formCount && i < 4096; i++) {
    const e = p.guiTableVA + i * 0x50;
    if (img.u32(e) !== 0x50) break;
    const dataSize = img.u32(e + 0x40);
    const dataVA = img.u32(e + 0x48);
    // The form name appears near the start of the property stream: WORD len, name, 0
    let o: VBObject | undefined;
    const head = img.slice(dataVA, 0x200);
    for (let k = 0x30; k + 3 < head.length && !o; k++) {
      const len = head[k] | (head[k + 1] << 8);
      if (len < 1 || len > 64 || k + 2 + len >= head.length || head[k + 2 + len] !== 0) continue;
      let nm = '';
      for (let c = 0; c < len; c++) nm += String.fromCharCode(head[k + 2 + c]);
      const cand = byName.get(nm.toLowerCase());
      if (cand && cand.guiIndex < 0) o = cand;
    }
    if (!o) o = designers.find(d => d.guiIndex < 0);
    if (o) { o.guiIndex = i; o.formDataVA = dataVA; o.formDataSize = dataSize; }
    else p.warnings.push(`GUI entry ${i} has no matching object`);
  }
}

function parseComponents(img: Image, p: VBProject) {
  // External component (OCX) table: variable-length records
  // +0x00 size, +0x04 offset of CLSID, +0x28 file, +0x2c ProgID, +0x30 class name
  let va = p.externalComponentTableVA;
  if (!va || !img.isMapped(va)) return;
  for (let i = 0; i < p.externalCount && i < 1024; i++) {
    const size = img.u32(va);
    if (size < 0x34 || size > 0x10000) break;
    const s = (off: number) => (off && off < size ? img.cstr(va + off, 260) : '');
    const clsOff = img.u32(va + 4);
    const guids: string[] = [];
    // collect every GUID-sized block between the CLSID and the first string
    const strStart = Math.min(...[img.u32(va + 0x28), img.u32(va + 0x2c), img.u32(va + 0x30)].filter(x => x > 0), size);
    for (let g = clsOff; g && g + 16 <= strStart; g += 4) guids.push(img.guid(va + g));
    p.components.push({
      index: i, va, guid: clsOff && clsOff + 16 <= size ? img.guid(va + clsOff) : '',
      file: s(img.u32(va + 0x28)), libName: s(img.u32(va + 0x2c)), name: s(img.u32(va + 0x30)), raw: guids,
    });
    va += size;
  }
  // Map ActiveX control event GUIDs to the component that declares them
  const guidToComp = new Map<string, VBComponent>();
  for (const c of p.components) for (const g of c.raw) if (!guidToComp.has(g)) guidToComp.set(g, c);
  for (const o of p.objects) for (const c of o.controls) {
    if (c.libName) continue;
    const comp = guidToComp.get(c.eventGuid);
    if (comp) {
      c.className = comp.name || comp.libName || c.className;
      c.libName = comp.libName.split('.')[0] || comp.file;
    }
  }
}

export function describeObjectFlags(f: number): string { return '0x' + hex(f); }
