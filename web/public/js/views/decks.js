// 牌組列表：每日數量、進入複習、牌組管理（新增、改名、刪除、選項）。
import { index, inTree, onChange, saveStatic, shortName, store, uid } from "../core.js";
import { deleteCards } from "../ops.js";
import { deckCounts } from "../plan.js";
import { todayProgress } from "../progress.js";
import { resetCursor } from "../sync.js";
import { actionSheet, confirmBox, esc, openDialog, promptBox, setHeader, toast } from "../ui.js";

const defaultConfigId = () => index.deckById.get(1)?.config ?? store.static.configs[0]?.id;

// 建立牌組（含缺少的上層牌組）
async function createDeck(name) {
  const parts = name.split("::").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("牌組名稱不能是空的");
  const decks = [...store.static.decks];
  let created = 0;
  for (let i = 0; i < parts.length; i++) {
    const full = parts.slice(0, i + 1).join("::");
    if (!decks.some((d) => d.name === full)) {
      decks.push({ id: uid(), name: full, config: defaultConfigId() });
      created++;
    }
  }
  if (!created) throw new Error("已經有同名的牌組了");
  await saveStatic({ decks });
}

async function renameDeck(deck, newName) {
  const name = newName.split("::").map((p) => p.trim()).filter(Boolean).join("::");
  if (!name) throw new Error("牌組名稱不能是空的");
  if (store.static.decks.some((d) => d.name === name && d.id !== deck.id)) throw new Error("已經有同名的牌組了");
  const old = deck.name;
  const decks = store.static.decks.map((d) => (d.name === old || d.name.startsWith(old + "::") ? { ...d, name: name + d.name.slice(old.length) } : d));
  await saveStatic({ decks });
}

async function deleteDeck(deck) {
  const subtree = index.decks.filter((d) => inTree(d, deck));
  const ids = new Set(subtree.map((d) => d.id));
  const cards = [...store.cards.values()].filter((c) => ids.has(c.did));
  const ok = await confirmBox(`刪除「${deck.name}」${subtree.length > 1 ? `和它的 ${subtree.length - 1} 個子牌組` : ""}，以及裡面的 ${cards.length} 張卡片？這個動作無法復原。`, { ok: "刪除", danger: true });
  if (!ok) return;
  if (cards.length) await deleteCards(cards);
  const remaining = store.static.decks.filter((d) => !ids.has(d.id));
  await saveStatic({ decks: remaining.length ? remaining : [{ id: 1, name: "Default", config: defaultConfigId() }] });
  toast(`已刪除 ${cards.length} 張卡片`);
}

// 進度條 + 「已學 / 總數 · 剩幾張新卡」；沒有卡片的牌組（例如只是容器）不顯示
function progressLine(r) {
  if (!r.total) return "";
  const pct = Math.round((r.seen / r.total) * 100);
  return `<span class="prog"><span class="bar"><i style="width:${(r.seen / r.total) * 100}%"></i></span><span class="txt">${r.seen} / ${r.total} · ${pct}%${r.left ? ` · 剩 ${r.left}` : " · 全部學過"}</span></span>`;
}

function render(el) {
  const rows = deckCounts().filter((r) => r.total > 0 || r.deck.id !== 1);
  const z = (n, cls) => `<span class="${n ? cls : "z"}">${n}</span>`;
  const pr = todayProgress();
  const today = pr.hasHistory
    ? `<div class="card-box today"><div><b>${pr.reviews}</b><span>今天複習</span></div><div><b>${pr.minutes}</b><span>分鐘</span></div><div class="streak"><b>${pr.streak ? `🔥 ${pr.streak}` : "0"}</b><span>連續天數</span></div></div>`
    : "";
  el.innerHTML =
    today +
    (rows.length
      ? rows.map((r) => `<div class="deck-row${r.depth ? " child" : ""}"><button class="deck" data-id="${r.deck.id}"><span class="info"><span class="name">${esc(shortName(r.deck))}</span>${progressLine(r)}</span>
        <span class="counts">${z(r.new, "n")}${z(r.learn, "l")}${z(r.due, "d")}</span></button><button class="gear" data-gear="${r.deck.id}" aria-label="牌組選項">⚙</button></div>`).join("")
      : welcome()) +
    `<div class="links"><button data-act="new-deck">＋ 新增牌組</button><button data-act="library">牌組庫</button><button data-act="quiz">快測</button><button data-act="custom">自訂複習</button></div>`;
}

// 帳號裡還沒有任何牌組：第一次登入的新同學，或還在下載資料的時候
function welcome() {
  const first = !store.static.decks.length && !store.notes.size;
  return `<div class="card-box" style="text-align:center;padding:24px 16px">
    <h3 style="margin-bottom:6px">${first ? "歡迎！" : "還沒有牌組"}</h3>
    <p class="muted" style="margin:0 0 14px">${first ? "你的帳號還沒有牌組。從牌組庫加入一個開始背單字，進度只屬於你自己。" : "從牌組庫加入，或新增一個空白牌組。"}</p>
    <button class="btn primary-btn" data-act="library">加入牌組庫的牌組</button></div>`;
}

// 牌組庫：列出可以加入的牌組，加入後會複製一份到自己的帳號（進度全新）。
async function openLibrary(sync) {
  let decks, budget;
  try {
    const res = await fetch("/api/library", { credentials: "same-origin" });
    if (!res.ok) throw new Error(String(res.status));
    ({ decks, budget } = await res.json());
  } catch {
    toast("需要連上網路才能打開牌組庫");
    return;
  }
  // 每個牌組一列（子牌組縮排，可以單獨加入）；加入上層牌組會連底下的子牌組一起加入
  const row = (d) => {
    const status = d.state === "joined" ? `<span class="pill">已加入</span>` : `<button class="btn primary-btn" data-join="${d.id}">${d.state === "partial" ? "補齊" : "加入"}</button>`;
    const sub = d.state === "partial" ? `已有 ${d.have} / ${d.cards} 張` : `${d.cards} 張卡片`;
    return `<div class="card-box row" style="margin-left:${d.depth * 18}px"><div class="grow"><b>${esc(d.name.split("::").pop())}</b><div class="muted small">${sub}</div></div>${status}</div>`;
  };
  const dlg = openDialog(`<h3>牌組庫</h3><p class="hint" style="margin:0 0 12px">加入後會複製一份到你的帳號，進度從頭開始，不會和別人混在一起。${budget ? `<br>免費額度有限：今天全站大約還能再加入 ${Math.max(0, Math.floor((budget.limit - budget.used) / budget.perWord)).toLocaleString()} 個單字，台灣時間每天早上 8 點重置。` : ""}</p>${decks.length ? decks.map(row).join("") : `<p class="muted">牌組庫目前是空的。</p>`}<div class="dialog-actions"><button data-close>關閉</button></div>`);
  dlg.el.onclick = async (e) => {
    if (e.target === dlg.el || e.target.closest("[data-close]")) return dlg.close();
    const btn = e.target.closest("[data-join]");
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = "加入中…";
    try {
      const res = await fetch("/api/library/join", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deck: Number(btn.dataset.join) }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `加入失敗（${res.status}）`);
      await resetCursor("dict"); // 新加入的筆記有字典，游標歸零才會拉到
      dlg.close();
      toast("已加入，正在下載卡片…", 4000);
      await sync?.();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "加入";
      toast(err.message);
    }
  };
}

export function mount(el, { sync } = {}) {
  setHeader({ title: "單字複習" });
  render(el);
  const off = onChange((what) => (what === "cards" || what === "static" || what === "sync" || what === "revlog") && el.isConnected && render(el));
  el.onclick = async (e) => {
    const deckBtn = e.target.closest(".deck");
    const gear = e.target.closest("[data-gear]");
    const act = e.target.closest("[data-act]")?.dataset.act;
    try {
      if (deckBtn) location.hash = `#/study/${deckBtn.dataset.id}`;
      else if (gear) {
        const deck = index.deckById.get(Number(gear.dataset.gear));
        actionSheet(
          [
            { label: "牌組選項", onClick: () => (location.hash = `#/options/${deck.id}`) },
            { label: "瀏覽這個牌組的卡片", onClick: () => (location.hash = `#/browse?q=${encodeURIComponent(`deck:"${deck.name}"`)}`) },
            { label: "新增卡片到這個牌組", onClick: () => (location.hash = `#/add?deck=${deck.id}`) },
            { separator: true },
            { label: "新增子牌組", onClick: async () => { const n = await promptBox({ title: "新增子牌組", label: `在「${deck.name}」底下`, placeholder: "名稱" }); if (n) await createDeck(`${deck.name}::${n}`).catch((err) => toast(err.message)); } },
            { label: "重新命名", onClick: async () => { const n = await promptBox({ title: "重新命名", value: deck.name, hint: "用 :: 表示層級，例如 英文單字::L1" }); if (n) await renameDeck(deck, n).catch((err) => toast(err.message)); } },
            ...(deck.id === 1 ? [] : [{ label: "刪除牌組", danger: true, onClick: () => deleteDeck(deck).catch((err) => toast(err.message)) }]),
          ],
          deck.name
        );
      } else if (act === "new-deck") {
        const n = await promptBox({ title: "新增牌組", placeholder: "名稱，用 :: 表示層級", hint: "例如 英文單字::L7" });
        if (n) await createDeck(n);
      } else if (act === "library") await openLibrary(sync);
      else if (act === "quiz") location.hash = "#/quiz";
      else if (act === "custom") location.hash = "#/custom";
    } catch (err) {
      toast(err.message);
    }
  };
  return () => off();
}

