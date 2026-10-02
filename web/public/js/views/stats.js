// 統計：今天、近 30 天、未來到期預測、卡片狀態、間隔分布、保留率、熱度圖，以及各目標的進度。
import { dayOf, index, inTree, shortName, store, today } from "../core.js";
import { SearchError, search } from "../search.js";
import { $, esc, openDialog, setHeader, toast } from "../ui.js";

const dateToDay = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return dayOf(new Date(y, m - 1, d, 12).getTime() / 1000);
};
const dayToDate = (day) => {
  const d = new Date(Date.UTC(1970, 0, 1) + day * 86400000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const bars = (values, { todayIndex = -1, labels } = {}) => {
  const max = Math.max(1, ...values);
  return `<div class="bars">${values.map((v, i) => `<div class="${i === todayIndex ? "today" : ""}" style="height:${Math.max(1, (v / max) * 100)}%" title="${esc(labels?.[i] ?? "")}: ${v}"></div>`).join("")}</div>
    <div class="axis"><span>${esc(labels?.[0] ?? "")}</span><span>${esc(labels?.[values.length - 1] ?? "")}</span></div>`;
};
const stat = (value, label) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;

const GOAL_KEY = "goals";
function loadGoals() {
  try {
    const saved = JSON.parse(localStorage.getItem(GOAL_KEY) ?? "null");
    if (Array.isArray(saved)) return saved;
  } catch {}
  const names = new Set(index.decks.map((d) => d.name));
  const goals = [];
  if (names.has("多益 900分 ENG-CH")) goals.push({ name: "多益 900 分", q: 'deck:"多益 900分 ENG-CH"', deadline: "2026-10-18", exam: "2026-11-01" });
  if (names.has("英文單字::L1")) goals.push({ name: "英文單字 L1–L4", q: "deck:英文單字::L1 or deck:英文單字::L2 or deck:英文單字::L3 or deck:英文單字::L4", deadline: "2026-10-10", exam: "2027-01-20" });
  if (names.has("英文單字::L5")) goals.push({ name: "英文單字 L5–L6", q: "deck:英文單字::L5 or deck:英文單字::L6", deadline: "2026-12-10", exam: "2027-01-20" });
  return goals;
}

function goalHtml(g) {
  let all;
  try {
    all = search(g.q);
  } catch (err) {
    if (err instanceof SearchError) return `<div class="card-box"><b>${esc(g.name)}</b><p class="error">${esc(err.message)}</p></div>`;
    throw err;
  }
  const t = today();
  const total = all.length;
  const newLeft = all.filter((c) => c.type === 0).length;
  const done = total - newLeft;
  const deadline = g.deadline ? dateToDay(g.deadline) : null;
  const exam = g.exam ? dateToDay(g.exam) : null;
  const ids = new Set(all.map((c) => c.id));
  const firstSeen = new Map();
  for (const r of store.revlog.values()) {
    const cur = firstSeen.get(r.cid);
    if (cur === undefined || r.id < cur) firstSeen.set(r.cid, r.id);
  }
  const recent = [...ids].filter((id) => firstSeen.has(id) && dayOf(firstSeen.get(id) / 1000) > t - 7).length / 7;
  const daysLeft = deadline === null ? null : deadline - t;
  const need = daysLeft && daysLeft > 0 ? newLeft / daysLeft : newLeft ? Infinity : 0;
  const eta = recent > 0 && newLeft ? t + Math.ceil(newLeft / recent) : null;
  const afterExam = exam === null ? 0 : all.filter((c) => c.type === 2 && c.queue !== -1 && c.due_day > exam).length;
  const status = !newLeft ? "ok" : deadline !== null && eta !== null && eta > deadline ? "bad" : "ok";
  return `<div class="card-box">
    <div class="row"><b class="grow">${esc(g.name)}</b><span class="pill ${status === "bad" ? "bad" : ""}">${done} / ${total}</span></div>
    <div class="progress"><div style="width:${total ? (done / total) * 100 : 0}%"></div></div>
    <div class="small muted" style="line-height:1.7">
      剩 ${newLeft} 張新卡${deadline !== null ? ` · 截止 ${g.deadline}（還有 ${daysLeft} 天）${daysLeft > 0 && newLeft ? `，每天要 ${Number.isFinite(need) ? need.toFixed(1) : "∞"} 張` : ""}` : ""}<br>
      近 7 天平均每天 ${recent.toFixed(1)} 張${eta ? `，照這個速度 ${dayToDate(eta)} 讀完${deadline !== null && eta > deadline ? "（比截止日晚）" : ""}` : ""}
      ${exam !== null ? `<br>考試 ${g.exam}${afterExam ? `：<span style="color:var(--r1)">有 ${afterExam} 張卡的下次複習排在考試之後</span>` : "：所有卡的下次複習都在考前"}` : ""}
    </div></div>`;
}

export function mount(el) {
  setHeader({ title: "統計", actions: [{ label: "目標設定", onClick: editGoals }] });
  let deckId = Number(localStorage.getItem("stats-deck")) || 0;

  const draw = () => {
    const t = today();
    const root = deckId ? index.deckById.get(deckId) : null;
    const cards = [...store.cards.values()].filter((c) => !root || inTree(index.deckById.get(c.did) ?? { name: "" }, root));
    const cardIds = new Set(cards.map((c) => c.id));
    const logs = [...store.revlog.values()].filter((r) => cardIds.has(r.cid));
    const perDay = new Map();
    for (const r of logs) {
      const d = dayOf(r.id / 1000);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    const todays = logs.filter((r) => dayOf(r.id / 1000) === t);
    const again = todays.filter((r) => r.ease === 1).length;
    const minutes = todays.reduce((a, r) => a + r.time, 0) / 60000;
    let streak = 0;
    for (let d = perDay.has(t) ? t : t - 1; perDay.get(d); d--) streak++;

    const days30 = Array.from({ length: 30 }, (_, i) => t - 29 + i);
    const hist30 = days30.map((d) => perDay.get(d) ?? 0);
    const forecast = Array.from({ length: 30 }, (_, i) => cards.filter((c) => c.queue === 2 && (i === 0 ? c.due_day <= t : c.due_day === t + i)).length);
    const state = {
      新卡: cards.filter((c) => c.type === 0 && c.queue >= 0).length,
      學習中: cards.filter((c) => (c.type === 1 || c.type === 3) && c.queue >= 0).length,
      年輕: cards.filter((c) => c.type === 2 && c.queue >= 0 && c.ivl < 21).length,
      成熟: cards.filter((c) => c.type === 2 && c.queue >= 0 && c.ivl >= 21).length,
      暫停: cards.filter((c) => c.queue === -1).length,
      擱置: cards.filter((c) => c.queue === -2 || c.queue === -3).length,
    };
    const buckets = [[1, 3], [4, 7], [8, 14], [15, 30], [31, 60], [61, 90], [91, 1e9]];
    const ivlHist = buckets.map(([a, b]) => cards.filter((c) => c.type === 2 && c.ivl >= a && c.ivl <= b).length);
    const month = logs.filter((r) => r.type === 1 && dayOf(r.id / 1000) > t - 30);
    const retention = month.length ? (month.filter((r) => r.ease > 1).length / month.length) * 100 : null;
    const weeks = 26;
    const start = t - ((t + 4) % 7) - (weeks - 1) * 7; // 以週日對齊
    const heat = Array.from({ length: weeks * 7 }, (_, i) => {
      const d = start + i;
      const n = d > t ? -1 : perDay.get(d) ?? 0;
      const level = n < 0 ? 0 : n === 0 ? 0 : n < 20 ? 1 : n < 60 ? 2 : n < 150 ? 3 : 4;
      return `<i data-l="${level}" title="${dayToDate(d)}: ${Math.max(0, n)}" style="${n < 0 ? "visibility:hidden" : ""}"></i>`;
    }).join("");

    el.innerHTML = `
      <div class="row" style="margin-bottom:12px"><label style="margin:0">牌組</label><select id="deck" style="flex:1"><option value="0">全部</option>${index.decks.filter((d) => d.id !== 1).map((d) => `<option value="${d.id}"${d.id === deckId ? " selected" : ""}>${"　".repeat(d.name.split("::").length - 1)}${esc(shortName(d))}</option>`).join("")}</select></div>
      ${!deckId && loadGoals().length ? `<h2 style="margin-top:0">目標進度</h2>${loadGoals().map(goalHtml).join("")}` : ""}
      <h2>今天</h2>
      <div class="statgrid">${stat(todays.length, "複習次數")}${stat(`${minutes.toFixed(1)} 分`, "花費時間")}${stat(todays.length ? `${(((todays.length - again) / todays.length) * 100).toFixed(0)}%` : "—", "答對率（沒按重來）")}${stat(`${streak} 天`, "連續天數")}</div>
      <h2>近 30 天複習數</h2>${bars(hist30, { todayIndex: 29, labels: days30.map(dayToDate) })}
      <h2>未來 30 天到期</h2>${bars(forecast, { todayIndex: 0, labels: forecast.map((_, i) => dayToDate(t + i)) })}
      <h2>卡片狀態</h2>
      <table class="simple">${Object.entries(state).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}<tr><td><b>合計</b></td><td><b>${cards.length}</b></td></tr></table>
      <h2>間隔分布（天）</h2>${bars(ivlHist, { labels: buckets.map(([a, b]) => (b > 1e8 ? `${a}+` : `${a}–${b}`)) })}
      <h2>保留率（近 30 天）</h2>
      <div class="statgrid">${stat(retention === null ? "—" : `${retention.toFixed(1)}%`, `複習卡沒按「重來」的比例（${month.length} 次）`)}${stat(logs.length, "累計複習次數")}</div>
      <h2>複習日曆</h2><div class="heat">${heat}</div>`;
    $("#deck", el).onchange = (e) => {
      deckId = Number(e.target.value);
      localStorage.setItem("stats-deck", deckId);
      draw();
    };
  };

  function editGoals() {
    const d = openDialog(`<h3>目標設定</h3><p class="hint" style="margin-top:0">每個目標是一個搜尋條件，加上讀完新卡的截止日和考試日（YYYY-MM-DD）。格式是 JSON。</p>
      <textarea id="goal-json" rows="12" spellcheck="false" style="font-family:monospace;font-size:12px">${esc(JSON.stringify(loadGoals(), null, 2))}</textarea>
      <div id="goal-err" class="error" hidden></div><div class="dialog-actions"><button data-c>取消</button><button class="primary-btn" id="goal-save">儲存</button></div>`);
    d.el.querySelector("[data-c]").onclick = () => d.close();
    d.el.querySelector("#goal-save").onclick = () => {
      try {
        const list = JSON.parse(d.el.querySelector("#goal-json").value);
        if (!Array.isArray(list) || list.some((g) => !g.name || !g.q)) throw new Error("每個目標都要有 name 和 q");
        localStorage.setItem(GOAL_KEY, JSON.stringify(list));
        d.close();
        draw();
        toast("已儲存");
      } catch (err) {
        const box = d.el.querySelector("#goal-err");
        box.textContent = err.message;
        box.hidden = false;
      }
    };
  }

  draw();
}
