// IndexedDB wrapper. Stores:
//   sessions   : saved sessions (keyPath id)
//   tombstones : deletion records used by sync (keyPath id)
//   kv         : misc values, e.g. the FileSystemDirectoryHandle for folder sync
const DB_NAME = 'tab-manager';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'id' });
          store.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openDB();
  const tx = db.transaction(name, mode);
  const store = tx.objectStore(name);
  const result = await fn(store);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

export const sessionsDB = {
  all: () => withStore('sessions', 'readonly', (s) => request(s.getAll())),
  get: (id) => withStore('sessions', 'readonly', (s) => request(s.get(id))),
  put: (session) => withStore('sessions', 'readwrite', (s) => request(s.put(session))),
  putMany: (sessions) => withStore('sessions', 'readwrite', async (s) => {
    for (const session of sessions) s.put(session);
  }),
  remove: (id) => withStore('sessions', 'readwrite', (s) => request(s.delete(id))),
  clear: () => withStore('sessions', 'readwrite', (s) => request(s.clear())),
};

export const tombstonesDB = {
  all: () => withStore('tombstones', 'readonly', (s) => request(s.getAll())),
  get: (id) => withStore('tombstones', 'readonly', (s) => request(s.get(id))),
  put: (t) => withStore('tombstones', 'readwrite', (s) => request(s.put(t))),
  remove: (id) => withStore('tombstones', 'readwrite', (s) => request(s.delete(id))),
};

export const kv = {
  get: (key) => withStore('kv', 'readonly', (s) => request(s.get(key))),
  set: (key, value) => withStore('kv', 'readwrite', (s) => request(s.put(value, key))),
  del: (key) => withStore('kv', 'readwrite', (s) => request(s.delete(key))),
};
