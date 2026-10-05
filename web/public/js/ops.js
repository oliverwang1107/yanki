// 卡片與筆記的操作（暫停、擱置、旗標、重設、改到期日、換牌組、標籤、新增／編輯／刪除）。
// 全部直接修改記憶體裡的資料列再存檔，所以呼叫端拿到的物件永遠是最新的。
import { QUEUE_OF_TYPE, cardsOfNote, cfgOf, cfgValue, guid, index, saveCards, saveNotes, saveStatic, store, today, uid } from "./core.js";

// ---------- 標籤 ----------
export const tagList = (note) => (note.tags ? note.tags.split(/\s+/).filter(Boolean) : []);
export const normTags = (tags) => [...new Set((Array.isArray(tags) ? tags : String(tags ?? "").split(/[\s,]+/)).map((t) => t.trim()).filter(Boolean))].join(" ");

export async function addTags(notes, tags) {
  const add = normTags(tags).split(" ").filter(Boolean);
  if (!add.length) return;
  for (const n of notes) n.tags = normTags([...tagList(n), ...add]);
  await saveNotes(notes);
}

export async function removeTags(notes, tags) {
  const drop = new Set(normTags(tags).split(" ").filter(Boolean).map((t) => t.toLowerCase()));
  for (const n of notes) n.tags = tagList(n).filter((t) => !drop.has(t.toLowerCase())).join(" ");
  await saveNotes(notes);
}

export async function toggleMark(notes) {
  const marked = notes.every((n) => tagList(n).includes("marked"));
  await (marked ? removeTags(notes, "marked") : addTags(notes, "marked"));
  return !marked;
}

// ---------- 暫停、擱置、旗標 ----------
export async function suspendCards(cards, on = true) {
  for (const c of cards) {
    c.queue = on ? -1 : QUEUE_OF_TYPE[c.type];
    c.bury_day = null;
  }
  await saveCards(cards);
}

export async function buryCards(cards) {
  for (const c of cards) {
    if (c.queue < 0) continue; // 已經暫停或擱置的不動
    c.queue = -3;
    c.bury_day = today();
  }
  await saveCards(cards);
}

// 擱置的卡隔天自動恢復；啟動時與換日後呼叫。
export async function unburyIfNeeded() {
  const t = today();
  const back = [...store.cards.values()].filter((c) => c.queue <= -2 && (c.bury_day ?? 0) < t);
  for (const c of back) {
    c.queue = QUEUE_OF_TYPE[c.type];
    c.bury_day = null;
  }
  if (back.length) await saveCards(back);
  return back.length;
}

export async function setFlag(cards, flag) {
  for (const c of cards) c.flags = flag;
  await saveCards(cards);
}

// ---------- 重設、改到期日、換牌組 ----------
export const nextNewPos = () => Math.max(0, ...[...store.cards.values()].map((c) => c.pos ?? 0)) + 1;

export async function forgetCards(cards, { resetCounts = false } = {}) {
  let pos = nextNewPos();
  for (const c of [...cards].sort((a, b) => a.id - b.id)) {
    Object.assign(c, { type: 0, queue: 0, ivl: 0, left: 0, s: null, d: null, lrt: null, due_ts: null, due_day: null, bury_day: null, pos: pos++ });
    if (resetCounts) Object.assign(c, { reps: 0, lapses: 0 });
  }
  await saveCards(cards);
}

// 設定到期日：「0」今天、「3」三天後、「1-7」隨機一到七天後；結尾加「!」會同時把間隔改成這個天數。
export function parseDueSpec(spec) {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*(!)?\s*$/.exec(spec ?? "");
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (b < a || b > 36500) return null;
  return { from: a, to: b, setInterval: Boolean(m[3]) };
}

export async function setDue(cards, spec) {
  const p = typeof spec === "string" ? parseDueSpec(spec) : spec;
  if (!p) throw new Error("格式不對，例如 0、3、1-7，結尾加 ! 會一起改間隔");
  const t = today();
  for (const c of cards) {
    const days = p.from + Math.floor(Math.random() * (p.to - p.from + 1));
    const wasReview = c.type === 2 || c.type === 3;
    if (!wasReview) {
      // 新卡／學習中的卡直接變成複習卡；沒有記憶狀態就用天數估一個
      Object.assign(c, { type: 2, ivl: Math.max(1, days), left: 0, due_ts: null, s: c.s ?? Math.max(1, days), d: c.d ?? 5 });
    } else if (c.type === 3) {
      Object.assign(c, { type: 2, left: 0, due_ts: null });
    }
    if (p.setInterval) c.ivl = Math.max(1, days);
    c.queue = c.queue < 0 ? c.queue : 2;
    c.due_day = t + days;
    c.lrt = c.lrt ?? null;
  }
  await saveCards(cards);
}

export async function changeDeck(cards, deckId) {
  if (!index.deckById.has(deckId)) throw new Error("找不到這個牌組");
  for (const c of cards) c.did = deckId;
  await saveCards(cards);
}

// ---------- 筆記：新增、編輯、刪除 ----------
const newCard = (nid, did, ord, pos) => ({
  id: uid(), nid, did, ord, type: 0, queue: 0, ivl: 0, reps: 0, lapses: 0, left: 0, mod: 0,
  s: null, d: null, lrt: null, pos, due_ts: null, due_day: null, flags: 0, bury_day: null, deleted: 0,
});

// 同一個筆記類型裡，第一個欄位相同的筆記
export function findDuplicates(mid, firstField, exceptId) {
  const key = String(firstField).trim().toLowerCase();
  return [...store.notes.values()].filter((n) => n.mid === mid && n.id !== exceptId && String(n.fields[0]).trim().toLowerCase() === key);
}

export async function addNote({ mid, did, fields, tags = "" }) {
  const nt = index.noteTypeById.get(mid);
  if (!nt) throw new Error("找不到筆記類型");
  if (!index.deckById.has(did)) throw new Error("請選擇牌組");
  if (!String(fields[0] ?? "").trim()) throw new Error(`「${nt.fields[0]}」欄位不能是空的`);
  const note = { id: uid(), guid: guid(), mid, mod: 0, tags: normTags(tags), fields: nt.fields.map((_, i) => String(fields[i] ?? "")), deleted: 0 };
  const cards = [newCard(note.id, did, 0, nextNewPos())];
  await saveNotes([note]);
  await saveCards(cards);
  return { note, cards };
}

// 複習時從字典把片語加成新卡：放進「字典片語」牌組（沒有就建立），已經加過的不重複。
export const PHRASE_DECK = "字典片語";
export async function addPhraseCard(en, zh, sourceWord = "") {
  const front = en.trim();
  let deck = store.static.decks.find((d) => d.name === PHRASE_DECK);
  if (!deck) {
    deck = { id: uid(), name: PHRASE_DECK, config: index.deckById.get(1)?.config ?? store.static.configs[0]?.id };
    await saveStatic({ decks: [...store.static.decks, deck] });
  }
  const nt = store.static.notetypes.find((n) => n.name === "基本型+") ?? store.static.notetypes.find((n) => n.fields.length >= 2);
  if (!nt) throw new Error("找不到可用的筆記類型");
  if (findDuplicates(nt.id, front).length) return { added: false };
  const fields = [front, zh.trim()];
  const exIndex = nt.fields.indexOf("例句");
  if (exIndex >= 0 && sourceWord) fields[exIndex] = `來自：${sourceWord}`;
  await addNote({ mid: nt.id, did: deck.id, fields, tags: "字典片語" });
  return { added: true };
}

export async function editNote(note, { fields, tags }) {
  const nt = index.noteTypeById.get(note.mid);
  if (fields) {
    if (!String(fields[0] ?? "").trim()) throw new Error(`「${nt.fields[0]}」欄位不能是空的`);
    note.fields = nt.fields.map((_, i) => String(fields[i] ?? ""));
  }
  if (tags !== undefined) note.tags = normTags(tags);
  await saveNotes([note]);
}

// 刪除卡片；一張筆記的卡片全部被刪掉時，筆記也一併刪除。
export async function deleteCards(cards) {
  const gone = new Set(cards.map((c) => c.id));
  const emptied = [...new Set(cards.map((c) => c.nid))]
    .filter((nid) => cardsOfNote(nid).every((c) => gone.has(c.id)))
    .map((nid) => store.notes.get(nid))
    .filter(Boolean);
  cards.forEach((c) => (c.deleted = 1));
  emptied.forEach((n) => (n.deleted = 1));
  await saveCards(cards);
  if (emptied.length) await saveNotes(emptied);
  return { notes: emptied.length, cards: cards.length };
}

export async function deleteNotes(notes) {
  const cards = notes.flatMap((n) => cardsOfNote(n.id));
  cards.forEach((c) => (c.deleted = 1));
  notes.forEach((n) => (n.deleted = 1));
  await saveCards(cards);
  await saveNotes(notes);
  return { notes: notes.length, cards: cards.length };
}

// ---------- 作答之後：擱置同一筆記的其他卡、處理頑固卡 ----------
export async function buryAfterAnswer(card) {
  const cfg = cfgOf(card.did);
  const bury = card.type === 0 || card.queue === 0 ? cfgValue(cfg, "buryNew") : cfgValue(cfg, "buryReviews");
  if (!bury) return;
  const siblings = cardsOfNote(card.nid).filter((c) => c.id !== card.id && c.queue >= 0);
  for (const c of siblings) {
    c.queue = -2;
    c.bury_day = today();
  }
  if (siblings.length) await saveCards(siblings);
}

// 回傳 true 表示這張卡剛變成頑固卡（lapses 到達門檻，之後每增加門檻的一半再觸發一次）
export async function handleLeech(card) {
  const cfg = cfgOf(card.did);
  const fails = cfgValue(cfg, "leechFails");
  if (!fails || card.lapses < fails || (card.lapses - fails) % Math.max(1, Math.floor(fails / 2)) !== 0) return false;
  const note = store.notes.get(card.nid);
  if (note && !tagList(note).includes("leech")) await addTags([note], "leech");
  if (cfgValue(cfg, "leechAction") === "suspend") await suspendCards([card], true);
  return true;
}
