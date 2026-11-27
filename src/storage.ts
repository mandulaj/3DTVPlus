// Lightweight browser-native IndexedDB wrapper (100% client-side, zero backend).
// Shared by saved tracks (tracks.ts) and upcoming custom user layers (Phase 4).

const DB_NAME = 'terrain-viewer';
const DB_VERSION = 1;
export type StoreName = 'kv' | 'customLayers';

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memoryFallback = new Map<string, unknown>();

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('customLayers')) db.createObjectStore('customLayers', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return memoryFallback.get(`${store}:${key}`) as T | undefined;
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut<T>(store: StoreName, key: string, value: T): Promise<void> {
  const db = await openDb();
  if (!db) {
    memoryFallback.set(`${store}:${key}`, value);
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    if (store === 'customLayers') tx.objectStore(store).put(value);
    else tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memoryFallback.delete(`${store}:${key}`);
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  if (!db) {
    const prefix = `${store}:`;
    return [...memoryFallback.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v as T);
  }
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as T[]);
    req.onerror = () => reject(req.error);
  });
}
