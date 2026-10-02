// 卡片資訊：狀態、到期、FSRS 記憶狀態、複習紀錄。
import { dayOf, index, nowSec, store, today } from "../core.js";
import { esc, fmtDate, openDialog } from "../ui.js";

const TYPE = ["新卡", "學習中", "複習", "重學中"];
const EASE = ["", "重來", "困難", "良好", "簡單"];
const REVTYPE = ["學習", "複習", "重學", "提前", "手動"];

export function retrievability(card) {
  if (!card.s || !card.lrt) return null;
  const decay = index.configById.get(index.deckById.get(card.did)?.config)?.params?.[20] ?? 0.1542;
  const factor = 0.9 ** (-1 / decay) - 1;
  const days = Math.max(0, today() - dayOf(card.lrt));
  return (1 + (factor * days) / card.s) ** -decay;
}

export function dueText(card) {
  if (card.type === 0) return `新卡 #${card.pos ?? "?"}`;
  if (card.queue === 1 && card.due_ts) {
    const m = Math.round((card.due_ts - nowSec()) / 60);
    return m <= 0 ? "現在" : m < 60 ? `${m} 分鐘後` : `${(m / 60).toFixed(1)} 小時後`;
  }
  if (card.due_day == null) return "—";
  const d = card.due_day - today();
  return d === 0 ? "今天" : d < 0 ? `逾期 ${-d} 天` : `${d} 天後`;
}

export const statusText = (card) =>
  card.queue === -1 ? "暫停" : card.queue === -2 || card.queue === -3 ? "擱置至明天" : TYPE[card.type];

export function openCardInfo(card) {
  const note = store.notes.get(card.nid);
  const nt = index.noteTypeById.get(note?.mid);
  const deck = index.deckById.get(card.did);
  const r = retrievability(card);
  const history = [...store.revlog.values()].filter((x) => x.cid === card.id).sort((a, b) => b.id - a.id);
  const rows = [
    ["新增日期", note ? fmtDate(note.id) : "—"],
    ["牌組", deck?.name ?? "?"],
    ["筆記類型", nt?.name ?? "?"],
    ["狀態", statusText(card)],
    ["到期", dueText(card)],
    ["間隔", card.type === 2 || card.type === 3 ? `${card.ivl} 天` : "—"],
    ["複習次數", card.reps],
    ["遺忘次數", card.lapses],
    ["穩定度", card.s ? `${card.s.toFixed(1)} 天` : "—"],
    ["難度", card.d ? `${card.d.toFixed(1)} / 10` : "—"],
    ["目前可提取率", r === null ? "—" : `${(r * 100).toFixed(1)}%`],
    ["卡片編號", card.id],
    ["筆記編號", card.nid],
  ];
  openDialog(`<h3>卡片資訊</h3><table class="simple">${rows.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${esc(v)}</td></tr>`).join("")}</table>
    <h3 style="margin-top:18px">複習紀錄（${history.length}）</h3>
    ${history.length ? `<table class="simple"><tr><th>日期</th><th>類型</th><th>按鈕</th><th>間隔</th></tr>${history.slice(0, 40).map((h) => `<tr><td>${fmtDate(h.id)}</td><td>${REVTYPE[h.type] ?? h.type}</td><td>${EASE[h.ease] ?? h.ease}</td><td>${h.ivl < 0 ? `${Math.round(-h.ivl / 60)}分` : `${h.ivl}天`}</td></tr>`).join("")}</table>` : '<p class="muted">還沒有紀錄</p>'}
    <div class="dialog-actions"><button data-close class="primary-btn">關閉</button></div>`).el.querySelector("[data-close]").onclick = () => document.querySelector("#dialog").close();
}

