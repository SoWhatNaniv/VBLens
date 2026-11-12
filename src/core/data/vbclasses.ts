// Runtime lookup tables for the intrinsic VB6 classes (derived from VB6.OLB
// by tools/gen-vb6lib.ts). Additional type libraries (OCX files the user
// loads) are merged in at runtime through `registerControlClass`.

import vb6lib from './vb6lib.json';
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
export interface IfaceInfo { name: string; guid: string; base: string; byOffset: Map<number, IfaceMember[]> }

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

function addIface(name: string, guid: string, base: string, members: IfaceMember[]) {
  const byOffset = new Map<number, IfaceMember[]>();
  for (const m of members) {
    const l = byOffset.get(m.offset);
    if (l) l.push(m); else byOffset.set(m.offset, [m]);
  }
  const info: IfaceInfo = { name, guid, base, byOffset };
  INTERFACES_BY_NAME[name] = info;
  if (guid) INTERFACES_BY_GUID[guid] = info;
}

function addClass(k: KnownClass) {
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

/** Merge an external type library (e.g. MSCOMCTL.OCX) into the lookup tables. */
export function registerTypeLib(tl: TypeLib): ControlClassInfo[] {
  const classes = controlClassesFromTypeLib(tl);
  for (const c of classes) {
    addClass({ name: c.name, lib: tl.name, clsid: c.clsid, iface: c.iface, eventsGuid: c.eventsGuid, events: c.events, eventParams: c.eventParams, dispids: Object.fromEntries(Object.entries(c.dispids)) });
  }
  for (const t of tl.types) {
    if (t.kind !== 'interface' && t.kind !== 'dispatch') continue;
    addIface(t.name, t.guid, t.impls[0]?.name ?? '', t.funcs.map(f => ({
      offset: f.vtOffset, name: f.name,
      kind: f.invkind === 2 ? 'get' : f.invkind === 4 ? 'let' : f.invkind === 8 ? 'set' : 'method',
      params: f.params.map(p => `${p.name}:${p.type}`), ret: f.ret,
    })));
  }
  return classes;
}

/** Resolve a vtable offset on an interface (walking base interfaces). */
export function lookupMember(ifaceName: string, offset: number, kind?: IfaceMember['kind']): IfaceMember | undefined {
  let cur: IfaceInfo | undefined = INTERFACES_BY_NAME[ifaceName];
  for (let g = 0; cur && g < 8; g++) {
    const l = cur.byOffset.get(offset);
    if (l) {
      const pref = l.filter(m => !m.name.startsWith('_'));
      const pool = pref.length ? pref : l;
      return (kind && pool.find(m => m.kind === kind)) || pool[0];
    }
    cur = INTERFACES_BY_NAME[cur.base];
  }
  return undefined;
}

export function classByName(name: string): KnownClass | undefined { return VB_CLASSES_BY_NAME[name]; }
