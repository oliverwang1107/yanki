// 複習畫面：依牌組的每日上限（或自訂搜尋）排出今天的卡，翻面、評分、撤銷，以及卡片選單。
import { addRevlog, cfgOf, cfgValue, dayOf, emit, index, nowSec, removeRevlog, saveCards, shortName, store, stripHtml, today } from "../core.js";
import { getEngine } from "../engine.js";
import * as ops from "../ops.js";
import { plan } from "../plan.js";
import { getPrefs } from "../prefs.js";
import { renderDict, renderSide } from "../render.js";
import { search } from "../search.js";
import { englishOf, speak, stopSpeaking, ttsAvailable } from "../tts.js";
import { $, actionSheet, confirmBox, esc, fmtDays, promptBox, setHeader, toast } from "../ui.js";
import { openNoteDialog } from "./editor.js";
import { openCardInfo } from "./info.js";

const LEARN_AHEAD = 1200; // 沒有別的卡時，提前 20 分鐘內的學習卡也拿出來
const KIND_TYPE = { learning: 1, review: 2, relearning: 3 };
const FLAGS = ["無旗標", "紅", "橘", "綠", "藍", "粉", "青", "紫"];

let S = null; // 目前的複習階段

// 自訂複習：不受每日上限限制，從搜尋結果排出（暫停與擱置的不算）
export function customPlan(query, { limit = 200, order = "due" } = {}) {
  const cards = search(query).filter((c) => c.queue >= 0);
  const key = {
    due: (a, b) => (a.due_day ?? 1e9) - (b.due_day ?? 1e9),
    random: () => Math.random() - 0.5,
    lapses: (a, b) => b.lapses - a.lapses,
    oldest: (a, b) => (a.lrt ?? 0) - (b.lrt ?? 0), // 最久沒看的優先
    difficulty: (a, b) => (b.d ?? 0) - (a.d ?? 0),
  }[order] ?? (() => 0);
  const learning = cards.filter((c) => c.queue === 1).sort((a, b) => a.due_ts - b.due_ts);
  const rest = cards.filter((c) => c.queue !== 1).sort((a, b) => (a.queue === b.queue ? key(a, b) : b.queue - a.queue)).slice(0, limit);
  return { learning, rev: rest.filter((c) => c.queue === 2), new: rest.filter((c) => c.queue === 0), ids: new Set(cards.map((c) => c.id)) };
}

const belongs = (c) => (S.custom ? S.ids.has(c.id) : S.ids.has(c.did));

function elapsedDays(card) {
  return card.type === 0 || !card.lrt ? 0 : Math.max(0, today() - dayOf(card.lrt));
}

function learningCards() {
  return [...store.cards.values()].filter((c) => c.queue === 1 && belongs(c)).sort((a, b) => a.due_ts - b.due_ts);
}

function nextCard() {
  const now = nowSec();
  const learning = learningCards();
  const card = learning.find((c) => c.due_ts <= now) ?? S.review.shift() ?? S.newc.shift() ?? learning.find((c) => c.due_ts <= now + LEARN_AHEAD);
  if (!card) return finish(learning);
  // 在別處（編輯、暫停、同步）變成不能讀的卡直接略過
  if (card.deleted || card.queue < 0 || !store.cards.has(card.id)) return nextCard();
  showCard(card);
}

function counts() {
  return { n: S.newc.length, l: learningCards().length, d: S.review.length };
}

function metaLine(card) {
  const c = counts();
  const cls = card.type === 0 ? "n" : card.queue === 1 ? "l" : "d";
  const item = (key, label, n) => `<span class="${key}${cls === key ? " on" : ""}">${label} ${n}</span>`;
  return `<div class="card-meta">${item("n", "新", c.n + (cls === "n" ? 1 : 0))}${item("l", "學習", c.l)}${item("d", "複習", c.d + (cls === "d" ? 1 : 0))}</div>`;
}

// 筆記類型的樣式：改成套在 .card-body，並拿掉固定的黑字白底（深色模式會看不見）。
function setCardCss(css) {
  let el = $("#nt-css");
  if (!el) {
    el = document.createElement("style");
    el.id = "nt-css";
    document.head.append(el);
  }
  el.textContent = css
    .replace(/\.card\b/g, ".card-body")
    .split("}")
    .map((rule) => (/\.card-body|\.example/.test(rule.split("{")[0]) ? rule.replace(/(^|[;{\s])(background-)?color\s*:[^;}]*;?/g, "$1") : rule))
    .join("}");
}

let audio;
function play(file) {
  audio?.pause();
  audio = new Audio(`/media/${encodeURIComponent(file)}`);
  audio.play().catch(() => {}); // iOS 沒有點擊動作時會擋掉自動播放，按播放鈕即可
}

// ---------- 朗讀（瀏覽器內建語音合成）：沒有音檔的單字、例句都能聽 ----------
function sayParts(card) {
  const note = store.notes.get(card.nid);
  const nt = index.noteTypeById.get(note.mid);
  const exIndex = nt.fields.indexOf("例句");
  const example = (exIndex >= 0 ? englishOf(note.fields[exIndex]) : "") || store.dict.get(card.nid)?.ex?.[0] || "";
  return { word: englishOf(note.fields[0]), example };
}

function ttsRow(card, side, sounds) {
  if (!getPrefs().tts || !ttsAvailable()) return "";
  const { word, example } = sayParts(card);
  const buttons = [];
  if (word && !sounds.length) buttons.push(`<button type="button" data-say="word">🔊 單字</button>`);
  if (side === "a" && example) buttons.push(`<button type="button" data-say="example">🔊 例句</button>`);
  return buttons.length ? `<div class="tts-row">${buttons.join("")}</div>` : "";
}

function draw(side) {
  const card = S.current;
  const note = store.notes.get(card.nid);
  const nt = index.noteTypeById.get(note.mid);
  setCardCss(nt.css);
  const r = renderSide(nt, note.fields, side);
  const dict = side === "a" && cfgValue(cfgOf(card.did), "showDictionary") ? renderDict(store.dict.get(card.nid)) : "";
  const flag = card.flags ? `<div class="cardflag" data-f="${card.flags}"></div>` : "";
  const marked = ops.tagList(note).includes("marked") ? `<span class="pill warn" style="align-self:center;margin-bottom:6px">★ 已標記</span>` : "";
  $("#card").innerHTML = `${flag}<div class="card-body">${marked}${r.html}${dict}</div>${ttsRow(card, side, r.sounds)}${metaLine(card)}`;
  return r;
}

function showCard(card) {
  S.current = card;
  S.flipped = false;
  S.shownAt = Date.now();
  S.states = getEngine().next(card, cfgOf(card.did), elapsedDays(card));
  $("#done").hidden = true;
  $("#card").hidden = false;
  $("#show").hidden = false;
  $("#rates").hidden = true;
  const r = draw("q");
  if (r.sounds.length) play(r.sounds[0]);
  else if (getPrefs().autoSpeak === "word") speak(sayParts(card).word);
}

function flip() {
  if (!S?.current || S.flipped) return;
  S.flipped = true;
  const r = draw("a");
  $("#show").hidden = true;
  $("#rates").hidden = false;
  [...$("#rates").children].forEach((btn, i) => (btn.querySelector("small").textContent = fmtState(S.states[i])));
  if (r.sounds.length) play(r.sounds[r.sounds.length - 1]);
  if (getPrefs().autoSpeak === "example") speak(sayParts(S.current).example);
}

function fmtState(st) {
  if (st.kind === "review") return fmtDays(st.days);
  const m = st.secs / 60;
  return m < 1 ? "<1分" : m < 60 ? `${Math.round(m)}分` : `${(m / 60).toFixed(1)}時`;
}

async function answer(rating) {
  if (!S?.current || !S.flipped) return;
  S.onActivity?.();
  const card = S.current;
  const st = S.states[rating];
  const prev = { ...card };
  const nowMs = Date.now();
  const sec = Math.floor(nowMs / 1000);

  // 複習紀錄沿用 Anki 的慣例：ivl／last_ivl 為負數代表秒數（學習中），正數代表天數。
  const prevScheduledSecs = prev.queue === 1 && prev.lrt ? prev.due_ts - prev.lrt : 0;
  const lastIvl = prev.type === 0 ? 0 : prev.queue === 1 ? -prevScheduledSecs : prev.ivl;
  let newIvl;
  card.type = KIND_TYPE[st.kind];
  card.s = st.s;
  card.d = st.d;
  card.lrt = sec;
  card.reps = prev.reps + 1;
  if (st.kind === "review") {
    card.queue = 2; card.ivl = st.days; card.due_day = today() + st.days; card.due_ts = null; card.left = 0;
    newIvl = st.days;
  } else {
    card.queue = 1; card.left = st.remaining; card.due_ts = sec + st.secs; card.due_day = null;
    card.ivl = st.kind === "relearning" ? st.days : 0;
    newIvl = -st.secs;
  }
  if (prev.type === 2 && rating === 0) card.lapses = prev.lapses + 1;

  let id = nowMs;
  while (store.revlog.has(id)) id++;
  const row = { id, cid: card.id, ease: rating + 1, ivl: newIvl, last_ivl: lastIvl, time: Math.min(60000, nowMs - S.shownAt), type: prev.type === 2 ? 1 : prev.type === 3 ? 2 : 0 };
  S.undo = { prev, rowId: id, siblings: null };
  S.answered++;
  S.ratings[rating]++;
  S.current = null;
  await Promise.all([saveCards([card]), addRevlog(row)]);
  await ops.buryAfterAnswer(card);
  if (prev.type === 2 && rating === 0 && (await ops.handleLeech(card))) toast("這張卡一直忘記，已標記為頑固卡 (leech)", 3500);
  emit("revlog");
  nextCard();
}

async function undo() {
  if (!S?.undo) return toast("沒有可以撤銷的動作");
  const { prev, rowId } = S.undo;
  const unsynced = await import("../db.js").then((m) => m.outboxKeys());
  if (!unsynced.includes(`r:${rowId}`)) return toast("這筆已經同步，無法撤銷");
  const card = store.cards.get(prev.id);
  Object.assign(card, prev);
  S.undo = null;
  await Promise.all([saveCards([card]), removeRevlog(rowId)]);
  showCard(card);
}

function finish(learning) {
  S.current = null;
  $("#card").hidden = true;
  $("#show").hidden = true;
  $("#rates").hidden = true;
  const next = learning.find((c) => c.due_ts > nowSec());
  const wait = next ? Math.max(1, Math.ceil((next.due_ts - nowSec()) / 60)) : 0;
  $("#done").hidden = false;
  const [again, hard, good, easy] = S.ratings;
  const minutes = Math.max(1, Math.round((Date.now() - S.startedAt) / 60000));
  $("#done").innerHTML = `<h2>今天的卡片完成了 🎉</h2>
    ${S.answered ? `<p>這次複習了 ${S.answered} 張，花了 ${minutes} 分鐘。<br><span class="small">重來 ${again} · 困難 ${hard} · 良好 ${good} · 簡單 ${easy}</span></p>` : ""}
    ${wait ? `<p>還有學習中的卡，約 ${wait} 分鐘後到期。</p>` : ""}
    <button class="btn primary-btn" data-quiz style="min-height:44px;margin-top:6px">來一組快測</button>`;
  S.onFinish?.();
  clearTimeout(finish.t);
  if (wait) finish.t = setTimeout(() => S && !S.current && S.timerOk && nextCard(), Math.min(wait * 60000, 30000));
}

// ---------- 卡片選單 ----------
async function afterChange() {
  const card = S.current;
  if (!card) return;
  if (card.deleted || card.queue < 0 || !store.cards.has(card.id)) {
    S.current = null;
    return nextCard();
  }
  draw(S.flipped ? "a" : "q");
}

function menu() {
  const card = S.current;
  if (!card) return;
  const note = store.notes.get(card.nid);
  const marked = ops.tagList(note).includes("marked");
  const run = (fn) => async () => {
    try {
      await fn();
      await afterChange();
    } catch (err) {
      toast(err.message);
    }
  };
  actionSheet(
    [
      { label: "編輯筆記", onClick: () => openNoteDialog(note, { onSaved: () => afterChange(), onDeleted: () => afterChange() }) },
      { label: "卡片資訊", onClick: () => openCardInfo(card) },
      { label: marked ? "取消標記" : "標記這張筆記 ★", onClick: run(() => ops.toggleMark([note])) },
      { label: "旗標…", onClick: () => actionSheet(FLAGS.map((n, i) => ({ label: `${i ? "⚑ " : ""}${n}${card.flags === i ? " ✓" : ""}`, onClick: run(() => ops.setFlag([card], i)) })), "旗標") },
      { separator: true },
      { label: "擱置到明天（這張卡）", onClick: run(() => ops.buryCards([card])) },
      { label: "擱置到明天（同一筆記的所有卡）", onClick: run(() => ops.buryCards(store.cards.size ? [...store.cards.values()].filter((c) => c.nid === card.nid) : [card])) },
      { label: "暫停這張卡", onClick: run(() => ops.suspendCards([card])) },
      { separator: true },
      { label: "設定到期日…", onClick: async () => { const v = await promptBox({ title: "設定到期日", placeholder: "例如 0、3、1-7", hint: "0 是今天；1-7 是隨機一到七天後；結尾加 ! 會同時把間隔改成這個天數" }); if (v) await run(() => ops.setDue([card], v))(); } },
      { label: "重設為新卡", onClick: async () => { if (await confirmBox("把這張卡重設為新卡？它的複習進度會被清除。", { ok: "重設" })) await run(() => ops.forgetCards([card]))(); } },
      { label: "刪除筆記", danger: true, onClick: async () => { if (await confirmBox("刪除這張筆記和它的所有卡片？", { ok: "刪除", danger: true })) await run(() => ops.deleteNotes([note]))(); } },
    ],
    esc(stripHtml(note.fields[0])).slice(0, 40)
  );
}

// ---------- 進出畫面 ----------
function onKey(e) {
  if (!S || (e.target instanceof Element && e.target.closest("input,textarea,select")) || $("#dialog").open) return;
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); S.flipped ? answer(2) : flip(); }
  else if (S.flipped && /^[1-4]$/.test(e.key)) answer(Number(e.key) - 1);
  else if (e.key === "z") undo();
  else if (e.key === "*") { const n = store.notes.get(S.current?.nid); if (n) ops.toggleMark([n]).then(afterChange); }
  else if (e.key === "@") { const c = S.current; if (c) ops.suspendCards([c]).then(afterChange); }
  else if (e.key === "-") { const c = S.current; if (c) ops.buryCards([c]).then(afterChange); }
  else if (e.key === "e") { const n = store.notes.get(S.current?.nid); if (n) openNoteDialog(n, { onSaved: afterChange, onDeleted: afterChange }); }
  else if (e.key === "i") { if (S.current) openCardInfo(S.current); }
  else if (/^[1-7]$/.test(e.key) && e.ctrlKey && S.current) ops.setFlag([S.current], S.current.flags === Number(e.key) ? 0 : Number(e.key)).then(afterChange);
}

export async function mount(el, params, hooks = {}) {
  await ops.unburyIfNeeded();
  const custom = params.has("q");
  let p;
  let title;
  let deckId = 0;
  if (custom) {
    try {
      p = customPlan(params.get("q"), { limit: Number(params.get("limit")) || 200, order: params.get("order") || "due" });
    } catch (err) {
      el.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      setHeader({ title: "自訂複習", back: "#/custom" });
      return;
    }
    title = "自訂複習";
  } else {
    const deck = index.deckById.get(Number(params.get("deck")));
    if (!deck) {
      el.innerHTML = `<p class="muted">找不到這個牌組。</p>`;
      setHeader({ title: "複習", back: "#/" });
      return;
    }
    p = plan(deck.id);
    title = shortName(deck);
    deckId = deck.id;
  }
  setHeader({ title, back: custom ? "#/custom" : "#/", actions: [{ label: "↶", title: "撤銷上一張", onClick: undo }, { label: "⋯", title: "卡片選單", onClick: menu }] });
  el.innerHTML = `<div id="card"></div><div id="done" hidden></div>`;
  S = { custom, ids: p.ids, review: p.rev, newc: p.new, current: null, states: null, shownAt: 0, flipped: false, undo: null, answered: 0, ratings: [0, 0, 0, 0], startedAt: Date.now(), deckId, timerOk: true, ...hooks };
  $("#show").onclick = flip;
  $("#rates").onclick = (e) => {
    const btn = e.target.closest("button");
    if (btn) answer(Number(btn.dataset.r));
  };
  $("#done").onclick = (e) => {
    if (e.target.closest("[data-quiz]")) location.hash = `#/quiz${S.deckId ? `?deck=${S.deckId}` : ""}`;
  };
  $("#card").onclick = (e) => {
    const say = e.target.closest("[data-say]");
    const snd = e.target.closest(".snd");
    if (say && S?.current) {
      const p = sayParts(S.current);
      speak(say.dataset.say === "word" ? p.word : p.example);
    } else if (snd) play(snd.dataset.file);
    else if (!S?.flipped) flip();
  };
  document.addEventListener("keydown", onKey);
  nextCard();

  return () => {
    document.removeEventListener("keydown", onKey);
    clearTimeout(finish.t);
    audio?.pause();
    stopSpeaking();
    S?.onLeave?.(S.answered);
    S = null;
  };
}

