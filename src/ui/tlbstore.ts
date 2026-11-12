// Remembers type libraries (.ocx/.tlb) the user loaded, in IndexedDB, so they are
// applied automatically to every executable opened afterwards.
const DB = 'vblens', STORE = 'typelibs';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveTypeLib(name: string, bytes: Uint8Array) {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(bytes, name.toLowerCase()); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  } catch { /* storage unavailable (private mode / file://) */ }
}

export async function loadTypeLibs(): Promise<{ name: string; bytes: Uint8Array }[]> {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const out: { name: string; bytes: Uint8Array }[] = [];
      const t = db.transaction(STORE, 'readonly');
      const c = t.objectStore(STORE).openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { out.push({ name: String(cur.key), bytes: cur.value as Uint8Array }); cur.continue(); } else res(out); };
      c.onerror = () => rej(c.error);
    });
  } catch { return []; }
}

export async function clearTypeLibs() {
  try { const db = await open(); db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch { /* ignore */ }
}
