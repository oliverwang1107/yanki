// 匯入 .apkg：把 apkg.js 讀出來的套件轉成這個 App 的資料（牌組、筆記類型、筆記、卡片、媒體、複習進度），
// 先算出完整計畫（可以顯示給使用者確認），再照計畫寫入。沒有任何畫面相關的程式，Node 也能載入測試。
import { kindOf, presetNoteType } from "./cards.js";
import { guid, index, nowSec, persist, saveCards, saveNotes, saveStatic, store, today, uid } from "./core.js";
import { nextNewPos } from "./ops.js";

export const DEFAULT_OPTIONS = {
  deckMode: "keep", // keep＝照原本的牌組階層（可加上一層根牌組）；single＝全部放進指定牌組
  root: "", // keep 模式下的根牌組名稱，空白＝不加
  targetDeckId: null, // single 模式的目標牌組
  keepScheduling: false, // 保留複習進度與紀錄；預設全部當新卡
  skipDuplicates: true, // 已經有同樣的筆記就略過
  extraTag: "", // 幫匯入的筆記加一個標籤
};

const CHUNK = 500;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------- 媒體參照 ----------
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// 筆記欄位裡引用的媒體檔名（圖片 src、音檔 src、[sound:…]）
export function mediaRefs(html) {
  const names = new Set();
  const s = String(html ?? "");
  for (const m of s.matchAll(/<(?:img|audio|source|video)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(v)) names.add(safeDecode(v));
  }
  for (const m of s.matchAll(/\[sound:([^\]]+)\]/g)) names.add(m[1]);
  return names;
}

// 把欄位裡的舊檔名換成上傳後的新檔名
export function rewriteMedia(html, nameMap) {
  return String(html ?? "")
    .replace(/(<(?:img|audio|source|video)\b[^>]*?\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (all, head, a, b, c) => {
      const raw = a ?? b ?? c;
      const to = nameMap.get(safeDecode(raw));
      if (!to) return all;
      const q = a !== undefined ? '"' : b !== undefined ? "'" : '"';
      return `${head}${q}/media/${encodeURIComponent(to)}${q}`;
    })
    .replace(/\[sound:([^\]]+)\]/g, (all, name) => (nameMap.has(name) ? `[sound:${nameMap.get(name)}]` : all));
}

const uniqueName = (base, taken) => {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  taken.add(name);
  return name;
};

// ---------- 筆記類型 ----------
function mapNoteTypes(pkg) {
  const existing = store.static.notetypes;
  const taken = new Set(existing.map((n) => n.name));
  const create = [];
  const map = new Map(); // 來源 mid → { mid, fieldMap（目標欄位順序 → 來源欄位索引，-1 代表沒有）}
  const sameFields = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (const src of pkg.notetypes) {
    let target;
    if (src.kind === "occlusion") {
      target = existing.find((n) => kindOf(n) === "occlusion") ?? create.find((n) => n.kind === "occlusion");
      if (!target) {
        target = presetNoteType("occlusion", uid(), uniqueName("Image Occlusion", taken));
        create.push(target);
      }
    } else {
      target = existing.find((n) => n.name === src.name && kindOf(n) === src.kind && sameFields(n.fields, src.fields));
      target ??= create.find((n) => n.srcId === src.srcId);
      if (!target) {
        const clash = existing.some((n) => n.name === src.name) || create.some((n) => n.name === src.name);
        const tmpls = src.tmpls.length ? src.tmpls : [{ name: "卡片 1", qfmt: `{{${src.fields[0]}}}`, afmt: "{{FrontSide}}" }];
        target = {
          id: uid(), srcId: src.srcId, name: clash ? uniqueName(`${src.name}（匯入）`, taken) : (taken.add(src.name), src.name),
          kind: src.kind, fields: [...src.fields], tmpls: tmpls.map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
          qfmt: tmpls[0].qfmt, afmt: tmpls[0].afmt, css: src.css ?? "",
        };
        create.push(target);
      }
    }
    map.set(src.srcId, { mid: target.id, fieldMap: target.fields.map((f) => src.fields.indexOf(f)), target });
  }
  return { map, create: create.map(({ srcId, ...nt }) => nt) };
}

// ---------- 牌組 ----------
function deckName(src, opts) {
  const name = src.replace(/^::+|::+$/g, "") || "Default";
  return opts.root.trim() ? `${opts.root.trim()}::${name}` : name;
}

// ---------- 卡片進度 ----------
function convertCard(src, pkg, nid, did, pos, keep) {
  const base = {
    id: uid(), nid, did, ord: src.ord, type: 0, queue: 0, ivl: 0, reps: 0, lapses: 0, left: 0, mod: 0,
    s: null, d: null, lrt: null, pos, due_ts: null, due_day: null, flags: 0, bury_day: null, deleted: 0,
  };
  if (!keep || src.type === 0) return base;
  const out = { ...base, reps: src.reps ?? 0, lapses: src.lapses ?? 0, ivl: src.ivl > 0 ? src.ivl : 0 };
  const hasMemory = Number.isFinite(src.data?.s) && Number.isFinite(src.data?.d);
  if (src.type === 2) {
    const dueIn = src.due - pkg.today;
    const s = hasMemory ? src.data.s : Math.max(1, src.ivl);
    const d = hasMemory ? src.data.d : clamp(11 - ((src.factor || 2500) / 1000 - 1.3) / 1.2 * 6, 1, 10);
    Object.assign(out, { type: 2, queue: 2, due_day: today() + dueIn, s, d, lrt: nowSec() - Math.max(1, src.ivl - dueIn) * 86400 });
  } else {
    // 學習中／重學中的卡：沒辦法精確換算剩餘步驟，改成「現在就到期的學習卡」
    Object.assign(out, { type: src.type === 3 ? 3 : 1, queue: 1, left: (src.left ?? 0) % 1000 || 1, due_ts: nowSec(), s: hasMemory ? src.data.s : null, d: hasMemory ? src.data.d : null, lrt: hasMemory ? nowSec() - 86400 : null });
  }
  if (src.queue === -1) out.queue = -1; // 暫停的維持暫停
  return out;
}

// ---------- 計畫 ----------
// 回傳 { decks, notetypes, notes, cards, revlog, media, summary }，還沒有寫入任何東西。
export function buildPlan(pkg, userOpts = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...userOpts };
  const { map: ntMap, create: newTypes } = mapNoteTypes(pkg);

  // 牌組
  const wanted = new Set(pkg.cards.map((c) => c.did));
  const nameOf = new Map(pkg.decks.map((d) => [d.srcId, d.name]));
  const deckTarget = new Map(); // 來源 did → 牌組名稱（keep）或 id（single）
  const newDeckNames = [];
  if (opts.deckMode === "single") {
    if (!index.deckById.has(opts.targetDeckId)) throw new Error("請選擇要放進哪個牌組");
  } else {
    const have = new Set(store.static.decks.map((d) => d.name));
    for (const did of wanted) {
      const name = deckName(nameOf.get(did) ?? "Default", opts);
      deckTarget.set(did, name);
      const parts = name.split("::");
      for (let i = 1; i <= parts.length; i++) {
        const full = parts.slice(0, i).join("::");
        if (!have.has(full)) { have.add(full); newDeckNames.push(full); }
      }
    }
  }

  // 筆記（略過重複的）
  const guids = new Set([...store.notes.values()].map((n) => n.guid));
  const firstKey = (mid, v) => `${mid}:${String(v ?? "").trim().toLowerCase()}`;
  const firsts = new Set([...store.notes.values()].map((n) => firstKey(n.mid, n.fields[0])));
  const notes = [];
  const noteIdOf = new Map();
  let duplicates = 0;
  const refs = new Set();
  for (const src of pkg.notes) {
    const m = ntMap.get(src.mid);
    if (!m) continue;
    const fields = m.fieldMap.map((i) => (i >= 0 ? src.fields[i] ?? "" : ""));
    const key = firstKey(m.mid, fields[0]);
    if (opts.skipDuplicates && (guids.has(src.guid) || firsts.has(key))) { duplicates++; continue; }
    firsts.add(key);
    const id = uid();
    noteIdOf.set(src.srcId, id);
    for (const f of fields) for (const name of mediaRefs(f)) refs.add(name);
    const tags = [...new Set([...src.tags, ...(opts.extraTag.trim() ? [opts.extraTag.trim().replace(/\s+/g, "_")] : [])])];
    notes.push({ id, guid: src.guid || guid(), mid: m.mid, mod: 0, tags: tags.join(" "), fields, deleted: 0 });
  }

  // 卡片
  const srcCards = pkg.cards.filter((c) => noteIdOf.has(c.nid));
  const ordered = [...srcCards].sort((a, b) => (a.type === 0 ? a.due : 1e12) - (b.type === 0 ? b.due : 1e12) || a.id - b.id);
  let pos = nextNewPos();
  const cardIdOf = new Map();
  const cards = ordered.map((c) => {
    const card = convertCard(c, pkg, noteIdOf.get(c.nid), null, pos++, opts.keepScheduling);
    cardIdOf.set(c.id, card.id);
    card._srcDid = c.did;
    return card;
  });
  const revlog = opts.keepScheduling
    ? pkg.revlog.filter((r) => cardIdOf.has(r.cid)).map((r) => ({ id: r.id, cid: cardIdOf.get(r.cid), ease: r.ease, ivl: r.ivl, last_ivl: r.lastIvl, time: r.time, type: r.type }))
    : [];

  // 媒體：只處理被匯入的筆記引用到、而且套件裡真的有的檔案
  const available = new Set(pkg.media.names);
  const mediaList = [...refs].filter((n) => available.has(n));
  const missingMedia = [...refs].filter((n) => !available.has(n));

  const summary = {
    decks: opts.deckMode === "single" ? 0 : newDeckNames.length,
    noteTypes: newTypes.length,
    reusedNoteTypes: pkg.notetypes.length - newTypes.length,
    notes: notes.length,
    duplicates,
    cards: cards.length,
    revlog: revlog.length,
    media: mediaList.length,
    missingMedia: missingMedia.length,
    estimatedWrites: (notes.length + cards.length) * 3 + revlog.length * 2,
  };
  return { opts, newDeckNames, deckTarget, notetypes: newTypes, notes, cards, revlog, mediaList, missingMedia, summary };
}

// ---------- 套用 ----------
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// uploader(name, bytes) → Promise<新檔名 | null>；回傳 null 代表這個檔案不支援或太大，保留原本的引用
export async function applyPlan(plan, pkg, { uploader, onProgress = () => {} } = {}) {
  const { opts } = plan;
  // 1. 牌組與筆記類型（需要網路）
  onProgress("建立牌組與筆記類型…", 0);
  const patch = {};
  const configId = index.deckById.get(1)?.config ?? store.static.configs[0]?.id;
  const deckIdByName = new Map(store.static.decks.map((d) => [d.name, d.id]));
  if (plan.newDeckNames.length) {
    const decks = [...store.static.decks];
    for (const name of plan.newDeckNames) {
      const d = { id: uid(), name, config: configId };
      decks.push(d);
      deckIdByName.set(name, d.id);
    }
    patch.decks = decks;
  }
  if (plan.notetypes.length) patch.notetypes = [...store.static.notetypes, ...plan.notetypes];
  if (Object.keys(patch).length) await saveStatic(patch);

  // 2. 媒體
  const nameMap = new Map();
  let skipped = 0;
  if (uploader && plan.mediaList.length) {
    let done = 0;
    const queue = [...plan.mediaList];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let name; (name = queue.shift()) !== undefined; ) {
        try {
          const bytes = await pkg.media.read(name);
          const out = bytes ? await uploader(name, bytes) : null;
          if (out) nameMap.set(name, out);
          else skipped++;
        } catch {
          skipped++;
        }
        onProgress(`上傳媒體 ${++done}/${plan.mediaList.length}…`, done / plan.mediaList.length);
      }
    }));
  }
  if (nameMap.size) for (const n of plan.notes) n.fields = n.fields.map((f) => rewriteMedia(f, nameMap));

  // 3. 筆記、卡片、複習紀錄
  const total = plan.notes.length + plan.cards.length + plan.revlog.length;
  let written = 0;
  for (const part of chunks(plan.notes, CHUNK)) {
    await saveNotes(part);
    onProgress("寫入筆記…", (written += part.length) / total);
  }
  for (const card of plan.cards) {
    card.did = opts.deckMode === "single" ? opts.targetDeckId : deckIdByName.get(plan.deckTarget.get(card._srcDid));
    delete card._srcDid;
  }
  for (const part of chunks(plan.cards, CHUNK)) {
    await saveCards(part);
    onProgress("寫入卡片…", (written += part.length) / total);
  }
  for (const part of chunks(plan.revlog, CHUNK)) {
    for (const r of part) {
      while (store.revlog.has(r.id)) r.id++;
      store.revlog.set(r.id, r);
    }
    await persist.revlog(part);
    onProgress("寫入複習紀錄…", (written += part.length) / total);
  }
  onProgress("完成", 1);
  return { notes: plan.notes.length, cards: plan.cards.length, media: nameMap.size, mediaSkipped: skipped, missingMedia: plan.missingMedia.length };
}

