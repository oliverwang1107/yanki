// 共用核心：記憶體裡的收藏、時間（學習日）、牌組索引、儲存。沒有任何畫面相關的程式，Node 也能載入測試。
import * as db from "./db.js";

export const ROLLOVER = 4; // 凌晨 4 點換日

export const store = {
  me: null, // 目前登入的使用者 { id, username, is_admin }，啟動時由 app.js 填入
  notes: new Map(),
  cards: new Map(),
  revlog: new Map(),
  dict: new Map(),
  static: { meta: {}, notetypes: [], decks: [], configs: [] },
};

// ---------- 時間：學習日編號（本機時區、凌晨 4 點換日），與 tools/export_anki.py 相同 ----------
export const nowSec = () => Math.floor(Date.now() / 1000);
const tzSec = (ts) => -new Date(ts * 1000).getTimezoneOffset() * 60;
export const dayOf = (ts) => Math.floor((ts + tzSec(ts) - ROLLOVER * 3600) / 86400);
export const today = () => dayOf(nowSec());
export const nextDayAt = () => (today() + 1) * 86400 + ROLLOVER * 3600 - tzSec(nowSec());
export const dayStart = (day) => day * 86400 + ROLLOVER * 3600 - tzSec(day * 86400 + 43200);

// ---------- 牌組、牌組設定、筆記類型的索引 ----------
export const index = { decks: [], deckById: new Map(), configById: new Map(), noteTypeById: new Map() };

// 依層級逐段排序，才不會讓「英文單字-P」夾在「英文單字」與它的子牌組之間
const byPath = (a, b) => {
  const [x, y] = [a.name.split("::"), b.name.split("::")];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = x[i].localeCompare(y[i]);
    if (c) return c;
  }
  return x.length - y.length;
};

export function indexStatic() {
  const st = store.static;
  index.decks = [...st.decks].sort(byPath);
  index.deckById = new Map(index.decks.map((d) => [d.id, d]));
  index.configById = new Map(st.configs.map((c) => [c.id, c]));
  index.noteTypeById = new Map(st.notetypes.map((n) => [n.id, n]));
}

export const cfgOf = (deckId) => index.configById.get(index.deckById.get(deckId)?.config);
export const inTree = (d, root) => d.name === root.name || d.name.startsWith(root.name + "::");
export const depth = (d) => d.name.split("::").length - 1;
export const shortName = (d) => d.name.split("::").pop();

// 牌組設定的預設值（舊匯入的資料沒有這些欄位）
export const CONFIG_DEFAULTS = { leechFails: 8, leechAction: "tag", buryNew: false, buryReviews: false, newOrder: "pos", showDictionary: true };
export const cfgValue = (cfg, key) => cfg?.[key] ?? CONFIG_DEFAULTS[key];

// ---------- 識別碼 ----------
let lastId = 0;
export function uid() {
  let id = Date.now();
  if (id <= lastId) id = lastId + 1;
  return (lastId = id);
}

export function guid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// ---------- 變更通知（畫面訂閱後重新繪製） ----------
const listeners = new Set();
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const emit = (what) => listeners.forEach((fn) => fn(what));

// ---------- 儲存：寫進記憶體、本機資料庫，並登記到待上傳清單 ----------
// 測試時可以換掉這個物件，就不需要 IndexedDB。
export const persist = {
  cards: (rows) => db.putTracked("cards", "c", rows),
  notes: (rows) => db.putTracked("notes", "n", rows),
  revlog: (rows) => db.putTracked("revlog", "r", rows),
  removeRevlog: (ids) => db.deleteTracked("revlog", "r", ids),
  static: (value) => db.kvSet("static", value),
};

export const bump = (row) => ((row.mod = Math.max(Date.now(), (row.mod ?? 0) + 1)), row);

export async function saveCards(rows) {
  rows.forEach((r) => {
    bump(r);
    if (r.deleted) store.cards.delete(r.id);
    else store.cards.set(r.id, r);
  });
  await persist.cards(rows);
  emit("cards");
}

export async function saveNotes(rows) {
  rows.forEach((r) => {
    bump(r);
    if (r.deleted) store.notes.delete(r.id);
    else store.notes.set(r.id, r);
  });
  await persist.notes(rows);
  emit("notes");
}

export async function addRevlog(row) {
  store.revlog.set(row.id, row);
  await persist.revlog([row]);
}

export async function removeRevlog(id) {
  store.revlog.delete(id);
  await persist.removeRevlog([id]);
}

// 牌組、設定、筆記類型數量很少，整組送給伺服器；需要網路，若別的裝置先改過會被擋下。
export async function saveStatic(patch) {
  const res = await fetch("/api/static", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base: Number(store.static.meta.static_mod ?? 0), ...patch }),
  });
  if (res.status === 409) throw new Error("牌組設定已在別的裝置更新過，請先按「同步」再重試");
  if (res.status === 401) {
    location.reload();
    throw new Error("未登入");
  }
  if (!res.ok) throw new Error(`儲存失敗（${res.status}）`);
  const out = await res.json();
  Object.assign(store.static, patch);
  store.static.meta.static_mod = String(out.static_mod);
  await persist.static(store.static);
  indexStatic();
  emit("static");
}

// 一次載入／取代整份收藏（啟動、同步之後用）
export function loadAll({ notes, cards, revlog, dict, static: st }) {
  for (const [map, rows] of [[store.notes, notes], [store.cards, cards], [store.revlog, revlog], [store.dict, dict]]) {
    map.clear();
    for (const r of rows ?? []) if (!r.deleted) map.set(r.id, r);
  }
  store.static = st ?? { meta: {}, notetypes: [], decks: [], configs: [] };
  indexStatic();
}

// ---------- 小工具 ----------
export const stripHtml = (html) =>
  String(html ?? "")
    .replace(/\[sound:[^\]]*\]/g, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export const cardsOfNote = (nid) => [...store.cards.values()].filter((c) => c.nid === nid);
export const QUEUE_OF_TYPE = { 0: 0, 1: 1, 2: 2, 3: 1 };
