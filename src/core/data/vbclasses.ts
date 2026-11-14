// Runtime lookup tables for the intrinsic VB6 classes (derived from VB6.OLB by
// tools/gen-vb6lib.ts) and the common ActiveX controls shipped with VB5/VB6
// (ocxlib.json, from tools/gen-ocxlib.ts: names, GUIDs, offsets and DISPIDs only).
// Type libraries the user loads are merged in at runtime through `registerTypeLib`.

import vb6lib from './vb6lib.json';
import ocxlib from './ocxlib.json';
import type { ControlClassInfo, TypeLib } from '../typelib/msft';
import { controlClassesFromTypeLib } from '../typelib/msft';

export interface KnownClass {
  name: string;
  lib: string;
  clsid: string;
  iface: string;
  eventsGuid: string;
  events: string[];
  eventParams: string[][];
  dispids: Record<string, { name: string; type: string }>;
}

export interface IfaceMember { offset: number; name: string; kind: 'get' | 'let' | 'set' | 'method'; params: string[]; ret: string }
export interface IfaceInfo { name: string; guid: string; base: string; lib: string; byOffset: Map<number, IfaceMember[]> }

type RawLib = {
  lib: string;
  classes: { name: string; clsid: string; iface: string; ifaceGuid: string; eventsGuid: string; events: string[]; eventParams: string[][]; dispids: Record<string, { name: string; type: string }> }[];
  interfaces: Record<string, { name: string; guid: string; base: string; members: [number, string, string, string[], string][] }>;
};

export const VB_CLASSES_BY_EVENT_GUID: Record<string, KnownClass> = {};
export const VB_CLASSES_BY_NAME: Record<string, KnownClass> = {};
export const VB_CLASSES_BY_CLSID: Record<string, KnownClass> = {};
export const INTERFACES_BY_NAME: Record<string, IfaceInfo> = {};
export const INTERFACES_BY_GUID: Record<string, IfaceInfo> = {};

function addIface(name: string, guid: string, base: string, members: IfaceMember[], lib = '') {
  const byOffset = new Map<number, IfaceMember[]>();
  for (const m of members) {
    const l = byOffset.get(m.offset);
    if (l) l.push(m); else byOffset.set(m.offset, [m]);
  }
  const info: IfaceInfo = { name, guid, base, lib, byOffset };
  // the same interface name can exist in several libraries with different layouts
  // (ComctlLib.ITreeView vs MSComctlLib.ITreeView): the qualified name is exact,
  // the plain name goes to the first library that defines it
  if (lib) INTERFACES_BY_NAME[`${lib}::${name}`] = info;
  if (!lib || !INTERFACES_BY_NAME[name]) INTERFACES_BY_NAME[name] = info;
  if (guid) INTERFACES_BY_GUID[guid] = info;
}

function addClass(k: KnownClass) {
  // newer OCX builds add alias coclasses (Winsock2, Winsock3...) with the same events:
  // controls keep the original class
  const prev = k.eventsGuid ? VB_CLASSES_BY_EVENT_GUID[k.eventsGuid] : undefined;
  if (prev && prev.lib === k.lib && prev.name !== k.name) { VB_CLASSES_BY_NAME[k.name] ??= k; return; }
  // a class name already used by another library (TreeView in ComctlLib and MSComctlLib)
  const taken = VB_CLASSES_BY_NAME[k.name];
  if (taken && taken.lib !== k.lib && taken.eventsGuid !== k.eventsGuid) k = { ...k, name: `${k.lib}.${k.name}` };
  if (k.eventsGuid) VB_CLASSES_BY_EVENT_GUID[k.eventsGuid] = k;
  VB_CLASSES_BY_NAME[k.name] = k;
  if (k.clsid) VB_CLASSES_BY_CLSID[k.clsid] = k;
}

const raw = vb6lib as unknown as RawLib;
for (const c of raw.classes) addClass({ ...c, lib: 'VB' });
// Events of a class module itself (not in VB6.OLB's coclass list)
addClass({ name: 'Class', lib: 'VB', clsid: '', iface: '', eventsGuid: '{FCFB3D21-A0FA-1068-A738-08002B3371B5}', events: ['Initialize', 'Terminate'], eventParams: [[], []], dispids: {} });
for (const i of Object.values(raw.interfaces)) {
  addIface(i.name, i.guid, i.base, i.members.map(([offset, name, kind, params, ret]) => ({ offset, name, kind: kind as IfaceMember['kind'], params, ret })));
}
// Common ActiveX controls (MSCOMCTL, Winsock, CommonDialog, RichTextBox, Inet, MSComm...)
type OcxLib = Omit<RawLib, 'lib'> & { file: string; lib: string };
export const BUNDLED_TYPELIBS: { file: string; lib: string; classes: string[] }[] = [];
for (const l of ocxlib as unknown as OcxLib[]) {
  for (const i of Object.values(l.interfaces)) {
    addIface(i.name, i.guid, i.base, i.members.map(([offset, name, kind, params, ret]) => ({ offset, name, kind: kind as IfaceMember['kind'], params, ret })), l.lib);
  }
  for (const c of l.classes) addClass({ ...c, lib: l.lib });
  BUNDLED_TYPELIBS.push({ file: l.file, lib: l.lib, classes: l.classes.filter(c => c.events.length).map(c => c.name) });
}

/** Merge an external type library (e.g. MSCOMCTL.OCX) into the lookup tables. */
export function registerTypeLib(tl: TypeLib): ControlClassInfo[] {
  const classes = controlClassesFromTypeLib(tl);
  for (const t of tl.types) {
    if (t.kind !== 'interface' && t.kind !== 'dispatch') continue;
    addIface(t.name, t.guid, t.impls[0]?.name ?? '', t.funcs.map(f => ({
      offset: f.vtOffset, name: f.name,
      kind: f.invkind === 2 ? 'get' : f.invkind === 4 ? 'let' : f.invkind === 8 ? 'set' : 'method',
      params: f.params.map(p => `${p.name}:${p.type}`), ret: f.ret,
    })), tl.name);
  }
  for (const c of classes) {
    // already known (bundled or loaded before): keep the registered class
    if (c.eventsGuid && VB_CLASSES_BY_EVENT_GUID[c.eventsGuid]?.lib === tl.name) { c.name = VB_CLASSES_BY_EVENT_GUID[c.eventsGuid].name; continue; }
    addClass({ name: c.name, lib: tl.name, clsid: c.clsid, iface: c.iface, eventsGuid: c.eventsGuid, events: c.events, eventParams: c.eventParams, dispids: Object.fromEntries(Object.entries(c.dispids)) });
    if (c.eventsGuid) c.name = VB_CLASSES_BY_EVENT_GUID[c.eventsGuid]?.name ?? c.name;
  }
  return classes;
}

/** Resolve a vtable offset on an interface (walking base interfaces). */
export function lookupMember(iface: string | IfaceInfo, offset: number, kind?: IfaceMember['kind']): IfaceMember | undefined {
  let cur: IfaceInfo | undefined = typeof iface === 'string' ? INTERFACES_BY_NAME[iface] : iface;
  for (let g = 0; cur && g < 8; g++) {
    const l = cur.byOffset.get(offset);
    if (l) {
      const pref = l.filter(m => !m.name.startsWith('_'));
      const pool = pref.length ? pref : l;
      return (kind && pool.find(m => m.kind === kind)) || pool[0];
    }
    cur = (cur.lib && INTERFACES_BY_NAME[`${cur.lib}::${cur.base}`]) || INTERFACES_BY_NAME[cur.base];
  }
  return undefined;
}

export function classByName(name: string): KnownClass | undefined { return VB_CLASSES_BY_NAME[name]; }
