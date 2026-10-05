// 備份與還原：整份收藏（筆記、卡片、複習紀錄、手寫標記、牌組與設定）存成 JSON，再讀回來。
// 還原只寫「和目前不一樣」的資料列（省 D1 寫入額度），而且走一般的儲存流程，所以之後同步會上傳到伺服器和其他裝置。
// 沒有任何畫面相關的程式，Node 也能載入測試。
import { saveCards, saveInk, saveNotes, saveStatic, store, persist, indexStatic, emit } from "./core.js";

export const BACKUP_VERSION = 2;
const CHUNK = 500;

export function makeBackup() {
  return {
    app: "yanki",
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    static: { notetypes: store.static.notetypes, decks: store.static.decks, configs: store.static.configs },
    notes: [...store.notes.values()],
    cards: [...store.cards.values()],
    revlog: [...store.revlog.values()],
    ink: [...store.ink.values()],
    dict: [...store.dict.values()],
  };
}

export const backupJson = () => JSON.stringify(makeBackup());

// 讀備份檔文字（JSON）；格式不對就丟出看得懂的錯誤。
export function parseBackup(text) {
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    throw new Error("這不是有效的備份檔（不是 JSON）");
  }
  if (!b || typeof b !== "object" || !Array.isArray(b.notes) || !Array.isArray(b.cards) || !b.static || typeof b.static !== "object") {
    throw new Error("這不是這個 App 的備份檔（缺少筆記、卡片或牌組資料）");
  }
  if (b.version > BACKUP_VERSION) throw new Error("這份備份是比較新的版本，請先更新 App");
  for (const k of ["notetypes", "decks", "configs"]) if (!Array.isArray(b.static[k])) throw new Error(`備份檔缺少「${k}」`);
  b.revlog ??= [];
  b.ink ??= [];
  return b;
}

// 比較兩列資料是否相同（忽略 mod；缺少的欄位用預設值）
const DEFAULTS = { flags: 0, deleted: 0, bury_day: null, left: 0, lrt: null, s: null, d: null };
const norm = (row) => {
  const o = { ...DEFAULTS, ...row };
  delete o.mod;
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
};
const same = (a, b) => norm(a) === norm(b);

function byId(list) {
  return new Map(list.map((x) => [x.id, x]));
}

// 算出還原要做哪些事（不會改任何資料）。
// mode：merge（合併：只補上缺少的、或備份裡比較新的）｜replace（完整：讓帳號變得和備份一樣，多出來的筆記與卡片會被刪除）
export function planRestore(b, mode = "merge") {
  const replace = mode === "replace";
  const warnings = [];
  const plan = { mode, notes: [], cards: [], ink: [], revlog: [], dropNotes: [], dropCards: [], static: null, warnings };

  // 牌組、牌組設定、筆記類型
  const cur = store.static;
  const nextStatic = {};
  for (const k of ["notetypes", "decks", "configs"]) {
    const have = byId(cur[k] ?? []);
    const theirs = b.static[k];
    if (replace) {
      if (JSON.stringify(theirs) !== JSON.stringify(cur[k])) nextStatic[k] = theirs;
    } else {
      const add = theirs.filter((x) => !have.has(x.id));
      if (add.length) nextStatic[k] = [...(cur[k] ?? []), ...add];
    }
  }
  if (Object.keys(nextStatic).length) plan.static = nextStatic;
  const finalStatic = { ...cur, ...nextStatic };
  const noteTypeIds = new Set(finalStatic.notetypes.map((n) => n.id));
  const deckIds = new Set(finalStatic.decks.map((d) => d.id));

  // 筆記
  const noteIds = new Set();
  for (const n of b.notes) {
    if (n.deleted) continue;
    if (!noteTypeIds.has(n.mid)) { warnings.push(`筆記 ${n.id} 的筆記類型不存在，已略過`); continue; }
    noteIds.add(n.id);
    const c = store.notes.get(n.id);
    if (!c || (replace ? !same(n, c) : (n.mod ?? 0) > (c.mod ?? 0) && !same(n, c))) plan.notes.push(n);
  }
  // 卡片
  const cardIds = new Set();
  for (const c of b.cards) {
    if (c.deleted) continue;
    if (!noteIds.has(c.nid) && !store.notes.has(c.nid)) { warnings.push(`卡片 ${c.id} 的筆記不存在，已略過`); continue; }
    if (!deckIds.has(c.did)) { warnings.push(`卡片 ${c.id} 的牌組不存在，已略過`); continue; }
    cardIds.add(c.id);
    const cur2 = store.cards.get(c.id);
    if (!cur2 || (replace ? !same(c, cur2) : (c.mod ?? 0) > (cur2.mod ?? 0) && !same(c, cur2))) plan.cards.push(c);
  }
  // 手寫標記
  for (const r of b.ink) {
    if (r.deleted || !r.data) continue;
    const c = store.ink.get(r.id);
    if (!c || (replace ? c.data !== r.data : (r.mod ?? 0) > (c.mod ?? 0) && c.data !== r.data)) plan.ink.push(r);
  }
  // 複習紀錄：只補上缺少的（伺服器沒有刪除複習紀錄的功能）
  for (const r of b.revlog) if (!store.revlog.has(r.id) && (cardIds.has(r.cid) || store.cards.has(r.cid))) plan.revlog.push(r);

  if (replace) {
    for (const n of store.notes.values()) if (!noteIds.has(n.id)) plan.dropNotes.push(n);
    for (const c of store.cards.values()) if (!cardIds.has(c.id)) plan.dropCards.push(c);
  }
  return plan;
}

export const planTotal = (p) => p.notes.length + p.cards.length + p.ink.length + p.revlog.length + p.dropNotes.length + p.dropCards.length;

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// 照計畫寫入。順序：牌組設定 → 筆記 → 卡片 → 手寫標記 → 複習紀錄 → 刪除多出來的。
export async function applyRestore(plan, onProgress = () => {}) {
  const total = Math.max(1, planTotal(plan));
  let done = 0;
  const tick = (n, label) => {
    done += n;
    onProgress(Math.min(1, done / total), label);
  };
  if (plan.static) {
    onProgress(0, "還原牌組與設定…");
    await saveStatic(plan.static);
  }
  for (const part of chunks(plan.notes, CHUNK)) {
    await saveNotes(part.map((n) => ({ ...n })));
    tick(part.length, "還原筆記…");
  }
  for (const part of chunks(plan.cards, CHUNK)) {
    await saveCards(part.map((c) => ({ ...c })));
    tick(part.length, "還原卡片…");
  }
  for (const r of plan.ink) {
    await saveInk({ ...r });
    tick(1, "還原手寫標記…");
  }
  for (const part of chunks(plan.revlog, CHUNK)) {
    for (const r of part) store.revlog.set(r.id, { ...r });
    await persist.revlog(part.map((r) => store.revlog.get(r.id)));
    tick(part.length, "還原複習紀錄…");
  }
  for (const part of chunks(plan.dropCards, CHUNK)) {
    part.forEach((c) => (c.deleted = 1));
    await saveCards(part);
    tick(part.length, "移除備份裡沒有的卡片…");
  }
  for (const part of chunks(plan.dropNotes, CHUNK)) {
    part.forEach((n) => (n.deleted = 1));
    await saveNotes(part);
    tick(part.length, "移除備份裡沒有的筆記…");
  }
  indexStatic();
  emit("restore");
  onProgress(1, "完成");
}
