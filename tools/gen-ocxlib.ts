// Generates src/core/data/ocxlib.json: the type information (class and member names,
// GUIDs, vtable offsets, DISPIDs, events) of the common VB5/VB6 ActiveX controls, so
// their properties, methods and events are named without loading the .ocx files.
//   npx tsx tools/gen-ocxlib.ts out.json path/to/*.ocx
// Only interface metadata is kept, never code.
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { loadTypeLibFromFile, controlClassesFromTypeLib } from '../src/core/typelib/msft';

const [out, ...files] = process.argv.slice(2);
const libs = [];
for (const file of files) {
  let tl;
  try { tl = loadTypeLibFromFile(new Uint8Array(readFileSync(file))); } catch (e) { console.error(basename(file), 'skipped:', (e as Error).message); continue; }
  const classes = controlClassesFromTypeLib(tl);
  const interfaces: Record<string, { name: string; guid: string; base: string; members: [number, string, string, string[], string][] }> = {};
  for (const t of tl.types) {
    if (t.kind !== 'interface' && t.kind !== 'dispatch') continue;
    interfaces[t.name] = {
      name: t.name, guid: t.guid, base: t.impls[0]?.name ?? '',
      members: t.funcs.map(f => [f.vtOffset, f.name, f.invkind === 2 ? 'get' : f.invkind === 4 ? 'let' : f.invkind === 8 ? 'set' : 'method', f.params.map(p => `${p.name}:${p.type}${p.flags & 0x10 ? '?' : ''}`), f.ret]),
    };
  }
  libs.push({
    file: basename(file).toUpperCase(), lib: tl.name, guid: tl.guid, doc: tl.doc ?? '',
    classes: classes.map(c => ({ name: c.name, clsid: c.clsid, iface: c.iface, ifaceGuid: c.ifaceGuid, eventsGuid: c.eventsGuid, events: c.events, eventParams: c.eventParams, dispids: c.dispids })),
    interfaces,
  });
  console.log(basename(file).padEnd(14), tl.name.padEnd(16), 'classes', classes.length, 'interfaces', Object.keys(interfaces).length);
}
writeFileSync(out, JSON.stringify(libs));
console.log('bytes', JSON.stringify(libs).length);
