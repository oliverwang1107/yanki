// 進入點：載入資料、路由、同步。每個畫面是 views/ 底下的模組，用網址 hash 切換。
import { emit, loadAll, store } from "./core.js";
import * as db from "./db.js";
import { initEngine } from "./engine.js";
import { unburyIfNeeded } from "./ops.js";
import { applyPrefs } from "./prefs.js";
import { pullChanges, pushChanges } from "./sync.js";
import { $, $$, setHeader, toast } from "./ui.js";

const ROUTES = [
  [/^#?\/?$/, "decks", () => ({ tab: "decks" })],
  [/^#\/study\/(\d+)$/, "study", (m) => ({ tab: "decks", params: new URLSearchParams({ deck: m[1] }) })],
  [/^#\/study\?(.*)$/, "study", (m) => ({ tab: "decks", params: new URLSearchParams(m[1]) })],
  [/^#\/browse(?:\?(.*))?$/, "browse", (m) => ({ tab: "browse", params: new URLSearchParams(m[1] ?? "") })],
  [/^#\/add(?:\?(.*))?$/, "add", (m) => ({ tab: "add", params: new URLSearchParams(m[1] ?? "") })],
  [/^#\/edit\/(\d+)$/, "edit", (m) => ({ tab: "browse", arg: Number(m[1]) })],
  [/^#\/options\/(\d+)$/, "options", (m) => ({ tab: "decks", arg: Number(m[1]) })],
  [/^#\/custom$/, "custom", () => ({ tab: "decks" })],
  [/^#\/stats$/, "stats", () => ({ tab: "stats" })],
  [/^#\/quiz(?:\?(.*))?$/, "quiz", (m) => ({ tab: "decks", params: new URLSearchParams(m[1] ?? "") })],
  [/^#\/more(?:\/(\w+))?$/, "more", (m) => ({ tab: "more", arg: m[1] })],
];

const loaders = {
  decks: () => import("./views/decks.js").then((m) => (el) => m.mount(el, { sync })),
  study: () => import("./views/study.js").then((m) => (el, r) => m.mount(el, r.params, { onFinish: () => sync(false), onLeave: (n) => n && sync(false), onActivity: maybeSync })),
  browse: () => import("./views/browse.js").then((m) => (el, r) => m.mount(el, r.params)),
  add: () => import("./views/editor.js").then((m) => (el, r) => m.mountAdd(el, r.params)),
  edit: () => import("./views/editor.js").then((m) => (el, r) => m.mountEdit(el, r.arg)),
  options: () => import("./views/options.js").then((m) => (el, r) => m.mount(el, r.arg)),
  custom: () => import("./views/custom.js").then((m) => (el) => m.mount(el)),
  stats: () => import("./views/stats.js").then((m) => (el) => m.mount(el)),
  quiz: () => import("./views/quiz.js").then((m) => (el, r) => m.mount(el, r.params)),
  more: () => import("./views/more.js").then((m) => (el, r) => m.mount(el, r.arg, { sync })),
};

let cleanup = null;
let routeSeq = 0;

async function route() {
  const seq = ++routeSeq;
  const hash = location.hash || "#/";
  const hit = ROUTES.map(([re, name, fn]) => [re.exec(hash), name, fn]).find(([m]) => m);
  const [m, name, fn] = hit ?? [null, "decks", () => ({ tab: "decks" })];
  const r = fn(m ?? []);
  try {
    await cleanup?.();
  } catch (e) {
    console.error(e);
  }
  cleanup = null;
  const el = $("#view");
  el.replaceChildren();
  el.onclick = el.oninput = null;
  document.body.dataset.view = name;
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.tab === r.tab));
  setHeader({ title: "" });
  try {
    const mount = await loaders[name]();
    if (seq !== routeSeq) return;
    const out = await mount(el, r);
    if (seq !== routeSeq) return void (await out?.());
    cleanup = out ?? null;
  } catch (e) {
    console.error(e);
    el.innerHTML = `<p class="error">畫面載入失敗：${String(e.message ?? e).replace(/</g, "&lt;")}</p>`;
  }
  $("#view").parentElement.scrollTop = 0;
}

// ---------- 同步 ----------
let syncing = false;
let lastPush = Date.now();

async function updateSyncChip(state) {
  const chip = $("#sync");
  const pending = (await db.outboxKeys()).length;
  chip.className = "chip" + (state === "busy" ? " busy" : state === "error" ? " warn" : pending ? "" : " ok");
  chip.textContent = state === "busy" ? "同步中…" : state === "error" ? "離線" : pending ? `待上傳 ${pending}` : "已同步";
}

export async function sync(withPull = true) {
  if (syncing) return;
  syncing = true;
  updateSyncChip("busy");
  try {
    await pushChanges();
    lastPush = Date.now();
    if (withPull) {
      await pullChanges((table, n) => ($("#sync").textContent = `${table} ${n}…`));
      await unburyIfNeeded();
    }
    updateSyncChip();
  } catch (e) {
    console.error(e);
    updateSyncChip("error");
    if (withPull) toast(`同步失敗：${e.message}`);
  } finally {
    syncing = false;
  }
}

// 作答中定期上傳（兩分鐘一次），避免一整天的紀錄只存在這台裝置
function maybeSync() {
  if (Date.now() - lastPush > 120000) sync(false);
}

// ---------- 啟動 ----------
// iOS Safari 從 iOS 10 起不理會 user-scalable=no，所以另外擋掉雙指縮放的手勢（輸入框內的文字選取不受影響）。
document.addEventListener("gesturestart", (e) => e.preventDefault());

// 目前登入的是誰：連得上就問伺服器，離線時用上次記下的。沒登入（401）就重新載入，伺服器會顯示登入頁。
async function loadMe() {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin", signal: AbortSignal.timeout(4000) });
    if (res.status === 401) {
      location.reload();
      return null;
    }
    if (res.ok) {
      const me = await res.json();
      try { localStorage.setItem("anki-me", JSON.stringify(me)); } catch { /* 無痕模式等 */ }
      return me;
    }
  } catch { /* 離線 */ }
  try { return JSON.parse(localStorage.getItem("anki-me")); } catch { return null; }
}

async function init() {
  applyPrefs();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const me = await loadMe();
  if (!me) {
    $("#view").innerHTML = `<p class="error">需要連上網路登入一次，之後才能離線使用。</p>`;
    return;
  }
  store.me = me;
  db.useUser(me.id);
  await initEngine();

  const [notes, cards, revlog, dict, ink, st] = await Promise.all([db.getAll("notes"), db.getAll("cards"), db.getAll("revlog"), db.getAll("dict"), db.getAll("ink"), db.kvGet("static")]);
  loadAll({ notes, cards, revlog, dict, ink, static: st });
  await unburyIfNeeded();
  updateSyncChip();
  await route();

  if (!st) toast("第一次使用，正在下載收藏…", 6000);
  if (navigator.onLine) sync();
}

$("#sync").addEventListener("click", () => sync());
window.addEventListener("hashchange", route);
window.addEventListener("online", () => sync());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") sync(false);
  else emit("cards");
});

init().catch((e) => {
  console.error(e);
  toast(`啟動失敗：${e.message}`, 8000);
});

