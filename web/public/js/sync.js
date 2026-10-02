// 與 Worker 同步：先上傳本機的變更，再用 (mod, id) 游標只拉伺服器上的新資料。
import { emit, indexStatic, store } from "./core.js";
import * as db from "./db.js";

const PUSH_BATCH = 500;

async function api(path, init) {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) {
    location.reload(); // 沒登入或登入碼失效：重新載入會顯示登入頁
    throw new Error("未登入");
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.error;
    throw new Error(res.status === 503 && detail ? detail : `${path} ${res.status}`);
  }
  return res.json();
}

// 重設某個資料表的游標，下次同步會從頭拉（加入牌組庫的牌組後，字典要重新拉）。
export const resetCursor = (table) => db.kvSet(`cursor:${table}`, { mod: 0, id: 0 });

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export async function pushChanges() {
  const keys = await db.outboxKeys();
  if (!keys.length) return 0;
  const by = { c: [], n: [], r: [] };
  const maps = { c: store.cards, n: store.notes, r: store.revlog };
  const done = [];
  for (const key of keys) {
    const [prefix, id] = [key[0], Number(key.slice(2))];
    const row = maps[prefix].get(id);
    if (row) by[prefix].push(row);
    done.push(key); // 資料列已被刪除的也一併清掉
  }
  const batches = [];
  for (const [name, prefix] of [["notes", "n"], ["cards", "c"], ["revlog", "r"]]) {
    for (const part of chunks(by[prefix], PUSH_BATCH)) batches.push({ [name]: part });
  }
  for (const body of batches) {
    await api("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  await db.clearOutbox(done);
  return done.length;
}

export async function pullChanges(onProgress = () => {}) {
  const st = await api("/api/static");
  store.static = {
    meta: Object.fromEntries(st.meta.map((r) => [r.k, r.v])),
    notetypes: st.notetypes.map((n) => ({ ...n, fields: JSON.parse(n.fields) })),
    decks: st.decks,
    configs: st.configs.map((c) => JSON.parse(c.data)),
  };
  await db.kvSet("static", store.static);
  indexStatic();

  const dirty = new Set(await db.outboxKeys());
  for (const table of ["notes", "cards", "revlog", "dict"]) {
    const map = store[table];
    let cursor = (await db.kvGet(`cursor:${table}`)) ?? { mod: 0, id: 0 };
    for (;;) {
      const q = new URLSearchParams({ mod: cursor.mod, id: cursor.id });
      const { rows, more } = await api(`/api/pull/${table}?${q}`);
      const keep = [];
      for (const row of rows) {
        if (table === "notes") row.fields = JSON.parse(row.fields);
        if (table === "dict") Object.assign(row, JSON.parse(row.data)), delete row.data;
        const prefix = table[0] === "r" ? "r" : table[0];
        const mine = map.get(row.id);
        // 本機有尚未上傳、而且比較新的版本就保留本機的
        if (mine && dirty.has(`${prefix}:${row.id}`) && (mine.mod ?? 0) >= (row.mod ?? 0)) continue;
        if (row.deleted) map.delete(row.id);
        else map.set(row.id, row);
        keep.push(row);
      }
      await db.putMany(table, keep);
      if (rows.length) {
        const last = rows[rows.length - 1];
        cursor = { mod: last.mod ?? 0, id: last.id };
        await db.kvSet(`cursor:${table}`, cursor);
      }
      onProgress(table, map.size);
      if (!more) break;
    }
  }
  emit("sync");
}
