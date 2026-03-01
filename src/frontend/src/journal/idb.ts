const DB_NAME = "g100-ledger";
const DB_VERSION = 2;

let dbInstance: IDBDatabase | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains("ledgerEvents")) {
        db.createObjectStore("ledgerEvents", {
          keyPath: "eventId",
          autoIncrement: true,
        });
      }
      if (!db.objectStoreNames.contains("trades")) {
        db.createObjectStore("trades", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("metricsDaily")) {
        db.createObjectStore("metricsDaily", { keyPath: "date" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      // v2: shadow trades store — separate from real trades, never mixed
      if (!db.objectStoreNames.contains("shadow_trades")) {
        db.createObjectStore("shadow_trades", { keyPath: "id" });
      }
    };

    request.onsuccess = (e) => {
      dbInstance = (e.target as IDBOpenDBRequest).result;
      resolve(dbInstance);
    };

    request.onerror = (e) => {
      reject((e.target as IDBOpenDBRequest).error);
    };
  });
}

export async function idbPut(store: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    const req = os.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll(store: string): Promise<unknown[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const os = tx.objectStore(store);
    const req = os.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(store: string, key: string): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const os = tx.objectStore(store);
    const req = os.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    const req = os.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
