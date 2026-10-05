// 卡片瀏覽器：用 Anki 的搜尋語法找卡片，並可批次操作（暫停、擱置、旗標、標籤、換牌組、改到期日、重設、刪除…）。
import { kindOf, noteTitle, templatesOf } from "../cards.js";
import { index, shortName, stripHtml, store } from "../core.js";
import * as ops from "../ops.js";
import { SearchError, search } from "../search.js";
import { $, actionSheet, confirmBox, esc, openDialog, promptBox, setHeader, toast } from "../ui.js";
import { openNoteDialog } from "./editor.js";
import { dueText, openCardInfo, statusText } from "./info.js";

const PAGE = 60;
const FLAG_NAMES = ["無旗標", "紅", "橘", "綠", "藍", "粉", "青", "紫"];
const CHIPS = [
  ["到期", "is:due"], ["新卡", "is:new"], ["學習中", "is:learn"], ["暫停", "is:suspended"], ["擱置", "is:buried"],
  ["已標記", "is:marked"], ["頑固卡", "is:leech"], ["今天新增", "added:1"], ["今天複習", "rated:1"], ["逾期", "prop:due<0"], ["最近忘記", "rated:7:1"],
];
const SORTS = {
  added: ["新增日期（新→舊）", (a, b) => b.nid - a.nid],
  due: ["到期日", (a, b) => (a.due_day ?? 1e9) - (b.due_day ?? 1e9) || (a.due_ts ?? 0) - (b.due_ts ?? 0)],
  ivl: ["間隔（長→短）", (a, b) => b.ivl - a.ivl],
  reps: ["複習次數", (a, b) => b.reps - a.reps],
  lapses: ["遺忘次數", (a, b) => b.lapses - a.lapses],
  stability: ["穩定度（小→大）", (a, b) => (a.s ?? 1e9) - (b.s ?? 1e9)],
  difficulty: ["難度（高→低）", (a, b) => (b.d ?? 0) - (a.d ?? 0)],
  front: ["字母順序", (a, b) => front(a).localeCompare(front(b))],
};

const noteType = (c) => index.noteTypeById.get(store.notes.get(c.nid)?.mid);
const front = (c) => {
  const note = store.notes.get(c.nid);
  const nt = noteType(c);
  return nt && note ? noteTitle(nt, note.fields) : "";
};
// 第二行：標準類型是第二個欄位；填空題是 Back Extra；圖片遮蓋顯示是第幾張卡。多版型的筆記加上版型名稱。
const back = (c) => {
  const note = store.notes.get(c.nid);
  const nt = noteType(c);
  if (!note || !nt) return "";
  const kind = kindOf(nt);
  const tmpls = templatesOf(nt);
  const label = kind === "standard" ? (tmpls.length > 1 ? `[${tmpls[c.ord]?.name ?? c.ord + 1}] ` : "") : `[卡片 ${c.ord + 1}] `;
  return label + (kind === "occlusion" ? stripHtml(note.fields[nt.fields.indexOf("Back Extra")] ?? "") : stripHtml(note.fields[1]));
};

function pickDeck(title) {
  return new Promise((resolve) => {
    const d = openDialog(`<h3>${esc(title)}</h3><select id="pick">${index.decks.map((x) => `<option value="${x.id}">${esc(x.name.replaceAll("::", " › "))}</option>`).join("")}</select>
      <div class="dialog-actions"><button data-v="">取消</button><button data-v="ok" class="primary-btn">確定</button></div>`, { onClose: (v) => resolve(v === "ok" ? Number($("#pick").value) : null) });
    d.el.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => d.close(b.dataset.v)));
  });
}

export function mount(el, params) {
  setHeader({ title: "瀏覽" });
  let query = params.get("q") ?? localStorage.getItem("browse-q") ?? "is:due";
  let sortKey = localStorage.getItem("browse-sort") ?? "added";
  let results = [];
  let shown = PAGE;
  const selected = new Set();
  let error = "";

  el.innerHTML = `
    <div class="searchbar"><input id="q" type="search" placeholder="搜尋，例如 deck:多益 is:due" autocapitalize="none" autocorrect="off" spellcheck="false"><button class="btn primary" id="go">搜尋</button></div>
    <div class="qchips">${CHIPS.map(([label, q]) => `<button data-q="${esc(q)}">${esc(label)}</button>`).join("")}</div>
    <div class="results-info"><span id="info"></span><span class="grow"></span><select id="sort" style="width:auto;padding:4px 8px;font-size:13px">${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}"${k === sortKey ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></div>
    <div id="list"></div>
    <div id="more" style="text-align:center;margin:12px 0" hidden><button class="btn" id="show-more">顯示更多</button></div>
    <div class="bulkbar" id="bulk" hidden></div>`;
  const input = $("#q", el);
  input.value = query;

  const selectedCards = () => [...selected].map((id) => store.cards.get(id)).filter(Boolean);
  const selectedNotes = () => [...new Map(selectedCards().map((c) => [c.nid, store.notes.get(c.nid)])).values()].filter(Boolean);

  function rowHtml(c) {
    const note = store.notes.get(c.nid);
    const deck = index.deckById.get(c.did);
    const tags = ops.tagList(note);
    const pills = [
      `<span class="pill">${esc(deck ? shortName(deck) : "?")}</span>`,
      `<span class="pill${c.queue < 0 ? " warn" : ""}">${esc(statusText(c))}</span>`,
      c.type !== 0 ? `<span class="pill">${esc(dueText(c))}</span>` : "",
      c.type === 2 ? `<span class="pill">間隔 ${c.ivl}天</span>` : "",
      c.lapses ? `<span class="pill bad">忘 ${c.lapses}</span>` : "",
      tags.includes("marked") ? `<span class="pill warn">★</span>` : "",
      tags.includes("leech") ? `<span class="pill bad">leech</span>` : "",
      ...tags.filter((t) => t !== "marked" && t !== "leech").slice(0, 3).map((t) => `<span class="pill">#${esc(t)}</span>`),
    ].join("");
    return `<div class="result${selected.has(c.id) ? " sel" : ""}${c.queue === -1 ? " susp" : ""}${c.flags ? ` flag-${c.flags}` : ""}" data-id="${c.id}">
      <input type="checkbox" class="chk"${selected.has(c.id) ? " checked" : ""} aria-label="選取">
      <div class="grow"><div class="front">${esc(front(c))}</div><div class="back">${esc(back(c))}</div><div class="meta">${pills}</div></div>
      <button class="chip" data-info aria-label="卡片資訊">ⓘ</button></div>`;
  }

  function renderBulk() {
    const bar = $("#bulk", el);
    bar.hidden = selected.size === 0;
    if (!selected.size) return;
    const anySusp = selectedCards().some((c) => c.queue === -1);
    bar.innerHTML = `<span class="count">已選 ${selected.size}</span>
      <button data-b="suspend">${anySusp ? "取消暫停" : "暫停"}</button><button data-b="bury">擱置</button><button data-b="flag">旗標</button><button data-b="mark">標記</button>
      <button data-b="addtag">加標籤</button><button data-b="rmtag">移除標籤</button><button data-b="deck">換牌組</button><button data-b="due">改到期日</button>
      <button data-b="forget">重設為新卡</button><button data-b="study">複習這些</button><button data-b="delete" class="danger-text">刪除</button><button data-b="none">取消選取</button>`;
  }

  function renderList() {
    const list = $("#list", el);
    list.innerHTML = results.slice(0, shown).map(rowHtml).join("");
    $("#more", el).hidden = results.length <= shown;
    const notes = new Set(results.map((c) => c.nid)).size;
    $("#info", el).innerHTML = error ? `<span class="error" style="margin:0">${esc(error)}</span>` : `${results.length} 張卡片（${notes} 筆記）${results.length > shown ? `，顯示前 ${shown} 張` : ""}`;
    renderBulk();
  }

  function run(q = query, { keepSelection = false } = {}) {
    query = q;
    input.value = q;
    localStorage.setItem("browse-q", q);
    history.replaceState(null, "", `#/browse?q=${encodeURIComponent(q)}`);
    try {
      error = "";
      results = search(q).sort(SORTS[sortKey][1]);
    } catch (err) {
      if (!(err instanceof SearchError)) throw err;
      error = err.message;
      results = [];
    }
    if (!keepSelection) selected.clear();
    else for (const id of [...selected]) if (!results.some((c) => c.id === id)) selected.delete(id);
    shown = PAGE;
    renderList();
  }

  const bulk = async (what) => {
    const cards = selectedCards();
    const notes = selectedNotes();
    if (!cards.length) return;
    try {
      switch (what) {
        case "suspend": await ops.suspendCards(cards, !cards.some((c) => c.queue === -1)); break;
        case "bury": await ops.buryCards(cards); break;
        case "mark": await ops.toggleMark(notes); break;
        case "flag": return actionSheet(FLAG_NAMES.map((n, i) => ({ label: `${i ? "⚑ " : ""}${n}`, onClick: async () => { await ops.setFlag(cards, i); run(query, { keepSelection: true }); } })), "旗標");
        case "addtag": { const t = await promptBox({ title: "加標籤", placeholder: "用空白分隔", hint: `套用到 ${notes.length} 張筆記` }); if (t) await ops.addTags(notes, t); break; }
        case "rmtag": { const t = await promptBox({ title: "移除標籤", placeholder: "用空白分隔", hint: `從 ${notes.length} 張筆記移除` }); if (t) await ops.removeTags(notes, t); break; }
        case "deck": { const id = await pickDeck(`把 ${cards.length} 張卡片移到`); if (id) await ops.changeDeck(cards, id); break; }
        case "due": { const v = await promptBox({ title: "設定到期日", placeholder: "例如 0、3、1-7", hint: "0 是今天；1-7 是隨機一到七天後；結尾加 ! 會同時把間隔改成這個天數" }); if (v) await ops.setDue(cards, v); break; }
        case "forget": if (await confirmBox(`把 ${cards.length} 張卡片重設為新卡？複習進度會被清除。`, { ok: "重設" })) await ops.forgetCards(cards); break;
        case "study": location.hash = `#/study?q=${encodeURIComponent(`cid:${cards.map((c) => c.id).join(",")}`)}&order=due`; return;
        case "delete": if (await confirmBox(`刪除 ${notes.length} 張筆記和它們的所有卡片？這個動作無法復原。`, { ok: "刪除", danger: true })) { await ops.deleteNotes(notes); selected.clear(); } break;
        case "none": selected.clear(); break;
      }
      run(query, { keepSelection: true });
    } catch (err) {
      toast(err.message);
    }
  };

  $("#go", el).onclick = () => run($("#q", el).value);
  input.onkeydown = (e) => e.key === "Enter" && run(input.value);
  $("#sort", el).onchange = (e) => { sortKey = e.target.value; localStorage.setItem("browse-sort", sortKey); run(query, { keepSelection: true }); };
  $("#show-more", el).onclick = () => { shown += PAGE; renderList(); };
  $("#bulk", el).onclick = (e) => { const b = e.target.closest("[data-b]"); if (b) bulk(b.dataset.b); };
  el.onclick = (e) => {
    const chip = e.target.closest("[data-q]");
    if (chip) return run(chip.dataset.q);
    const row = e.target.closest(".result");
    if (!row) return;
    const card = store.cards.get(Number(row.dataset.id));
    if (!card) return;
    if (e.target.closest("[data-info]")) return openCardInfo(card);
    if (e.target.classList.contains("chk") || selected.size) {
      if (selected.has(card.id)) selected.delete(card.id);
      else selected.add(card.id);
      row.classList.toggle("sel", selected.has(card.id));
      row.querySelector(".chk").checked = selected.has(card.id);
      return renderBulk();
    }
    openNoteDialog(store.notes.get(card.nid), { onSaved: () => run(query, { keepSelection: true }), onDeleted: () => run(query) });
  };

  run(query);
}
