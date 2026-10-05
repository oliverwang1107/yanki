// 本機資料庫（IndexedDB）。整份收藏只有幾 MB，啟動時整個讀進記憶體，之後只寫有變動的列。
const STORES = ["kv", "notes", "cards", "revlog", "outbox", "dict", "ink"];

let dbPromise;
let dbName = "anki-web";

// 每位使用者各自一個本機資料庫；擁有者（uid 1）沿用原本的名稱，舊資料和還沒上傳的紀錄都不會遺失。
// 必須在第一次讀寫之前呼叫。
export function useUser(uid) {
  dbName = uid === 1 ? "anki-web" : `anki-web-u${uid}`;
  dbPromise = undefined;
}

export function deleteLocalData() {
  dbPromise?.then((d) => d.close()).catch(() => {});
  dbPromise = undefined;
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        if (name === "kv") db.createObjectStore(name);
        else if (name === "outbox") db.createObjectStore(name); // key = "c:<id>" / "n:<id>" / "r:<id>"
        else db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
  const result = await fn(...stores.map((s) => t.objectStore(s)));
  await done;
  return result;
}

export const getAll = (store) => tx([store], "readonly", (s) => wrap(s.getAll()));
export const kvGet = (key) => tx(["kv"], "readonly", (s) => wrap(s.get(key)));
export const kvSet = (key, value) => tx(["kv"], "readwrite", (s) => wrap(s.put(value, key)));
// 依 id 讀幾列（已刪除的資料列不在記憶體裡，上傳「刪除」時要從這裡讀）
export const getRows = (store, ids) => tx([store], "readonly", (s) => Promise.all(ids.map((id) => wrap(s.get(id)))));
export const outboxKeys = () => tx(["outbox"], "readonly", (s) => wrap(s.getAllKeys()));

export function putMany(store, rows) {
  return tx([store], "readwrite", (s) => { for (const r of rows) s.put(r); });
}

// 一次寫入資料列並登記到待上傳清單（同一個交易，不會只寫一半）。
export function putTracked(store, prefix, rows) {
  return tx([store, "outbox"], "readwrite", (s, o) => {
    for (const r of rows) { s.put(r); o.put(1, `${prefix}:${r.id}`); }
  });
}

export function deleteTracked(store, prefix, ids) {
  return tx([store, "outbox"], "readwrite", (s, o) => {
    for (const id of ids) { s.delete(id); o.delete(`${prefix}:${id}`); }
  });
}

export function clearOutbox(keys) {
  return tx(["outbox"], "readwrite", (o) => { for (const k of keys) o.delete(k); });
}
