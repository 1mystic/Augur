// Local game history: IndexedDB wrapper. Everything stays in this browser; nothing is uploaded.
const DB = 'augur-games', STORE = 'games';
let dbp;
function open() {
  return (dbp ??= new Promise((res, rej) => {
    if (!('indexedDB' in self)) { rej(new Error('IndexedDB is not available')); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('updated', 'updated'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
}
const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = async mode => (await open()).transaction(STORE, mode).objectStore(STORE);

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export async function saveGame(rec) { await wrap((await store('readwrite')).put(rec)); return rec; }
export async function getGame(id) { return (await wrap((await store('readonly')).get(id))) || null; }
export async function deleteGame(id) { await wrap((await store('readwrite')).delete(id)); }
export async function clearGames() { await wrap((await store('readwrite')).clear()); }
/** Newest first. */
export async function listGames() { return (await wrap((await store('readonly')).getAll())).sort((a, b) => (b.updated || 0) - (a.updated || 0)); }
/** Insert many records in one transaction; an existing id is only replaced by a newer copy. Returns {added, updated, skipped}. */
export async function putMany(list) {
  const db = await open(), existing = new Map((await listGames()).map(g => [g.id, g]));
  const out = { added: 0, updated: 0, skipped: 0 };
  await new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readwrite'), s = t.objectStore(STORE);
    for (const g of list) {
      const old = existing.get(g.id);
      if (!old) { s.put(g); out.added++; } else if ((g.updated || 0) > (old.updated || 0)) { s.put(g); out.updated++; } else out.skipped++;
    }
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  return out;
}
