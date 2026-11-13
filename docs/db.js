/* KellerKraft Receipts — storage on the phone (IndexedDB). Nothing leaves the phone except to your own computer. */
'use strict';
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const q = indexedDB.open('kk-receipts', 1);
      q.onupgradeneeded = () => {
        const db = q.result;
        if (!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), st = t.objectStore(store);
      let out; const r = fn(st);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  return {
    all: () => tx('receipts', 'readonly', s => s.getAll()),
    get: id => tx('receipts', 'readonly', s => s.get(id)),
    put: r => tx('receipts', 'readwrite', s => s.put(r)),
    del: id => tx('receipts', 'readwrite', s => s.delete(id)),
    kvGet: k => tx('kv', 'readonly', s => s.get(k)),
    kvSet: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
  };
})();
