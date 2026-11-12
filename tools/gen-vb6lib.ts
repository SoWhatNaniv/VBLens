// Generates src/core/data/vb6lib.json from VB6.OLB (names, GUIDs, vtable
// offsets, dispids and event lists only).
import { readFileSync, writeFileSync } from 'fs';
import { loadTypeLibFromFile, controlClassesFromTypeLib } from '../src/core/typelib/msft';
const tl = loadTypeLibFromFile(new Uint8Array(readFileSync(process.argv[2])));
const classes = controlClassesFromTypeLib(tl);
const ifaces: Record<string, { name: string; guid: string; base: string; members: [number, string, string, string[], string][] }> = {};
for (const t of tl.types) {
  if (t.kind !== 'interface' && t.kind !== 'dispatch') continue;
  ifaces[t.name] = {
    name: t.name, guid: t.guid, base: t.impls[0]?.name ?? '',
    members: t.funcs.map(f => [f.vtOffset, f.name, f.invkind === 2 ? 'get' : f.invkind === 4 ? 'let' : f.invkind === 8 ? 'set' : 'method', f.params.map(p => `${p.name}:${p.type}${p.flags & 0x10 ? '?' : ''}`), f.ret]),
  };
}
const enums: Record<string, Record<string, number | string>> = {};
for (const t of tl.types) if (t.kind === 'enum' || t.kind === 'module') {
  const e: Record<string, number | string> = {};
  for (const v of t.vars) if (v.value !== undefined) e[v.name] = v.value;
  if (Object.keys(e).length) enums[t.name] = e;
}
const out = {
  lib: tl.name, guid: tl.guid,
  classes: classes.map(c => ({ name: c.name, clsid: c.clsid, iface: c.iface, ifaceGuid: c.ifaceGuid, eventsGuid: c.eventsGuid, events: c.events, eventParams: c.eventParams, dispids: c.dispids })),
  interfaces: ifaces, enums,
};
writeFileSync(process.argv[3], JSON.stringify(out));
console.log('classes', classes.length, 'interfaces', Object.keys(ifaces).length, 'enums', Object.keys(enums).length, 'bytes', JSON.stringify(out).length);
