// 統計：今天、近 30 天、未來到期預測、卡片狀態、間隔分布、保留率、熱度圖，以及各目標的進度。
import { dayOf, index, inTree, shortName, store, today } from "../core.js";
import { deckProgress } from "../plan.js";
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
const WEEK = "日一二三四五六";
const dayToDateW = (day) => {
  const d = new Date(Date.UTC(1970, 0, 1) + day * 86400000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（週${WEEK[d.getUTCDay()]}）`;
};

// 可互動的長條圖：滑鼠移過去或手指點一下，上方會顯示那一格的數字；點下去會釘住，再點一次取消。
const charts = new Map();
const chart = (id, { values, labels, todayIndex = -1, info, summary }) => {
  charts.set(id, { info, summary, pinned: null });
  const max = Math.max(1, ...values);
  return `<div class="ichart" data-chart="${id}"><div class="readout">${summary}</div>
    <div class="ibars${values.length > 45 ? " dense" : ""}">${values.map((v, i) => `<div class="col${i === todayIndex ? " today" : ""}" data-i="${i}"><i style="height:${Math.max(1, (v / max) * 100)}%"></i></div>`).join("")}</div>
    <div class="axis"><span>${esc(labels[0] ?? "")}</span><span>${esc(labels[labels.length - 1] ?? "")}</span></div></div>`;
};
const showReadout = (box, i) => {
  const c = charts.get(box.dataset.chart);
  if (!c) return;
  box.querySelector(".readout").innerHTML = i === null ? c.summary : c.info(i);
};
function chartEvent(e, type) {
  const box = e.target.closest?.(".ichart");
  const c = box && charts.get(box.dataset.chart);
  if (!c) return;
  const col = e.target.closest(".col");
  if (type === "over" && col) showReadout(box, Number(col.dataset.i));
  else if (type === "out" && !box.querySelector(".ibars").contains(e.relatedTarget)) showReadout(box, c.pinned);
  else if (type === "click" && col) {
    const i = Number(col.dataset.i);
    c.pinned = c.pinned === i ? null : i;
    box.querySelectorAll(".col.sel").forEach((x) => x.classList.remove("sel"));
    if (c.pinned !== null) col.classList.add("sel");
    showReadout(box, c.pinned);
  }
}
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

// 各牌組（含子牌組）的完成進度：已學 = 不再是新卡的張數，剩 = 還沒學過的新卡。
// 互動表格：點欄位標題排序（同一層內排序，階層不打亂）、點 ▾ 收合／展開子牌組。選了某個牌組就只列它和底下的子牌組。
const DP_KEY = "stats-progress-ui";
const DP_COLS = [
  ["name", "牌組"],
  ["pct", "完成"],
  ["seen", "已學"],
  ["left", "剩餘"],
  ["total", "總數"],
];
function loadDpUi() {
  try {
    const s = JSON.parse(localStorage.getItem(DP_KEY) ?? "null");
    if (s && typeof s === "object") return { sort: s.sort ?? "name", dir: s.dir ?? 1, collapsed: new Set(s.collapsed ?? []) };
  } catch {}
  return { sort: "name", dir: 1, collapsed: new Set() };
}

function deckProgressHtml(root) {
  const progress = deckProgress();
  if (!index.decks.some((d) => progress.get(d.id).total > 0 && (!root || inTree(d, root)))) return "";
  return `<h2${root || !loadGoals().length ? ' style="margin-top:0"' : ""}>各牌組進度</h2><div class="card-box deck-prog" id="dp"></div>`;
}

function mountDeckTable(box, root) {
  if (!box) return;
  const ui = loadDpUi();
  const save = () => {
    try {
      localStorage.setItem(DP_KEY, JSON.stringify({ sort: ui.sort, dir: ui.dir, collapsed: [...ui.collapsed] }));
    } catch {}
  };
  const draw = () => {
    const progress = deckProgress();
    const decks = index.decks.filter((d) => progress.get(d.id).total > 0 && (!root || inTree(d, root)));
    const names = new Set(decks.map((d) => d.name));
    const parentOf = (d) => {
      const parts = d.name.split("::");
      for (let i = parts.length - 1; i > 0; i--) {
        const p = parts.slice(0, i).join("::");
        if (names.has(p)) return p;
      }
      return null;
    };
    const kids = new Map();
    for (const d of decks) {
      const p = parentOf(d);
      kids.set(p, [...(kids.get(p) ?? []), d]);
    }
    const key = (d) => {
      const p = progress.get(d.id);
      return ui.sort === "pct" ? p.seen / p.total : p[ui.sort];
    };
    const order = (list) => (ui.sort === "name" ? list : [...list].sort((a, b) => (key(a) - key(b)) * ui.dir || a.name.localeCompare(b.name)));
    if (ui.sort === "name" && ui.dir < 0) kids.forEach((v, k) => kids.set(k, [...v].reverse()));
    const rows = [];
    const walk = (parent, lv) => {
      for (const d of order(kids.get(parent) ?? [])) {
        const has = (kids.get(d.name) ?? []).length > 0;
        rows.push({ d, lv, has });
        if (has && !ui.collapsed.has(d.id)) walk(d.name, lv + 1);
      }
    };
    // 最上層：沒有任何上層牌組在列表中的牌組
    const tops = decks.filter((d) => parentOf(d) === null);
    kids.set(null, tops);
    walk(null, 0);
    const sumLeft = tops.reduce((a, d) => a + progress.get(d.id).left, 0);
    const sumTotal = tops.reduce((a, d) => a + progress.get(d.id).total, 0);
    const head = DP_COLS.map(([k, label]) => `<th data-sort="${k}" class="${ui.sort === k ? "on" : ""}">${label}${ui.sort === k ? (ui.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("");
    box.innerHTML = `<table class="simple dp-table"><thead><tr>${head}</tr></thead><tbody>${rows
      .map(({ d, lv, has }) => {
        const p = progress.get(d.id);
        const pct = (p.seen / p.total) * 100;
        const open = !ui.collapsed.has(d.id);
        return `<tr><td class="dp-name" style="padding-left:${8 + lv * 16}px">${has ? `<button class="dp-tog" data-tog="${d.id}" aria-label="${open ? "收合" : "展開"}">${open ? "▾" : "▸"}</button>` : `<span class="dp-tog"></span>`}${esc(shortName(d))}</td>
          <td class="dp-pct"><div class="progress"><div style="width:${pct}%"></div></div><span>${Math.round(pct)}%</span></td>
          <td>${p.seen}</td><td class="${p.left ? "" : "muted"}">${p.left || "✓"}</td><td class="muted">${p.total}</td></tr>`;
      })
      .join("")}</tbody></table>
      <p class="small muted" style="margin:8px 0 0">已學 = 不再是新卡；剩餘 = 還沒學過的新卡。合計 ${sumTotal - sumLeft} / ${sumTotal}，剩 ${sumLeft}。點標題可排序，點 ▾ 收合子牌組。</p>`;
  };
  box.onclick = (e) => {
    const th = e.target.closest("[data-sort]");
    const tog = e.target.closest("[data-tog]");
    if (th) {
      const k = th.dataset.sort;
      if (ui.sort === k) ui.dir = -ui.dir;
      else {
        ui.sort = k;
        ui.dir = k === "name" || k === "pct" ? 1 : -1; // 數字欄第一次點是「大到小」；完成度則先看最落後的
      }
    } else if (tog) {
      const id = Number(tog.dataset.tog);
      ui.collapsed.has(id) ? ui.collapsed.delete(id) : ui.collapsed.add(id);
    } else return;
    save();
    draw();
  };
  draw();
}

// 未來到期量：可切 30／60／90 天、每日／累積，點長條看某一天，也能展開成數據表。
const FC_KEY = "stats-forecast-ui";
const fcState = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(FC_KEY) ?? "null");
    if (s && typeof s === "object") return { range: [30, 60, 90].includes(s.range) ? s.range : 30, mode: s.mode === "cum" ? "cum" : "day", table: !!s.table };
  } catch {}
  return { range: 30, mode: "day", table: false };
})();
const saveFc = () => {
  try {
    localStorage.setItem(FC_KEY, JSON.stringify(fcState));
  } catch {}
};

function drawForecast(box, dueByDay, t) {
  if (!box) return;
  const n = fcState.range;
  const daily = dueByDay.slice(0, n);
  let acc = 0;
  const cum = daily.map((v) => (acc += v));
  const total = cum[n - 1];
  const peak = daily.reduce((best, v, i) => (v > daily[best] ? i : best), 0);
  const sum = (days) => dueByDay.slice(0, days).reduce((a, b) => a + b, 0);
  const seg = (key, opts) => `<div class="seg">${opts.map(([v, label]) => `<button data-fc="${key}:${v}" class="${String(fcState[key]) === String(v) ? "on" : ""}">${label}</button>`).join("")}</div>`;
  const labels = daily.map((_, i) => dayToDate(t + i));
  box.innerHTML = `
    <div class="statgrid">${stat(sum(1), "今天要複習（含已逾期）")}${stat(sum(7), "未來 7 天")}${stat(sum(30), "未來 30 天")}${stat(sum(91), "未來 90 天")}</div>
    <div class="row" style="gap:8px;flex-wrap:wrap">${seg("range", [[30, "30 天"], [60, "60 天"], [90, "90 天"]])}${seg("mode", [["day", "每日"], ["cum", "累積"]])}<button class="chip" data-fc="table:" style="margin-left:auto">${fcState.table ? "收起數據表" : "數據表"}</button></div>
    ${chart("forecast", {
      values: fcState.mode === "cum" ? cum : daily,
      labels,
      todayIndex: 0,
      summary: `未來 ${n} 天共 <b>${total}</b> 張 · 平均每天 ${(total / n).toFixed(1)} 張 · 最多：${dayToDate(t + peak)} 的 ${daily[peak]} 張 <span class="muted">（點長條看每天）</span>`,
      info: (i) => `<b>${dayToDateW(t + i)}${i === 0 ? " 今天" : ""}</b> 到期 <b>${daily[i]}</b> 張${i === 0 ? "（含已逾期）" : ""} · 累積 <b>${cum[i]}</b> 張${total ? `（${((cum[i] / total) * 100).toFixed(0)}%）` : ""}`,
    })}
    ${
      fcState.table
        ? `<div class="dp-scroll"><table class="simple"><thead><tr><th>日期</th><th>到期</th><th>累積</th></tr></thead><tbody>${daily.map((v, i) => `<tr><td>${dayToDateW(t + i)}${i === 0 ? " 今天" : ""}</td><td>${v}</td><td>${cum[i]}</td></tr>`).join("")}</tbody></table></div>`
        : ""
    }`;
}

export function mount(el) {
  setHeader({ title: "統計", actions: [{ label: "目標設定", onClick: editGoals }] });
  let deckId = Number(localStorage.getItem("stats-deck")) || 0;
  let redrawForecast = () => {};
  el.onclick = (e) => {
    const btn = e.target.closest("[data-fc]");
    if (btn) {
      const [k, v] = btn.dataset.fc.split(":");
      if (k === "table") fcState.table = !fcState.table;
      else fcState[k] = k === "range" ? Number(v) : v;
      saveFc();
      redrawForecast();
    } else chartEvent(e, "click");
  };
  el.onpointerover = (e) => e.pointerType === "mouse" && chartEvent(e, "over");
  el.onpointerout = (e) => e.pointerType === "mouse" && chartEvent(e, "out");

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
    const dueByDay = new Array(91).fill(0); // 第 0 格含已逾期的
    for (const c of cards) {
      if (c.queue !== 2) continue;
      const k = Math.max(0, c.due_day - t);
      if (k <= 90) dueByDay[k]++;
    }
    const state = {
      新卡: cards.filter((c) => c.type === 0 && c.queue >= 0).length,
      學習中: cards.filter((c) => (c.type === 1 || c.type === 3) && c.queue >= 0).length,
      年輕: cards.filter((c) => c.type === 2 && c.queue >= 0 && c.ivl < 21).length,
      成熟: cards.filter((c) => c.type === 2 && c.queue >= 0 && c.ivl >= 21).length,
      暫停: cards.filter((c) => c.queue === -1).length,
      擱置: cards.filter((c) => c.queue === -2 || c.queue === -3).length,
    };
    const buckets = [[1, 3], [4, 7], [8, 14], [15, 30], [31, 60], [61, 90], [91, 1e9]];
    const bucketLabels = buckets.map(([a, b]) => (b > 1e8 ? `${a}+` : `${a}–${b}`));
    const ivlHist = buckets.map(([a, b]) => cards.filter((c) => c.type === 2 && c.ivl >= a && c.ivl <= b).length);
    const ivlTotal = ivlHist.reduce((a, b) => a + b, 0);
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
      ${deckProgressHtml(root)}
      <h2>今天</h2>
      <div class="statgrid">${stat(todays.length, "複習次數")}${stat(`${minutes.toFixed(1)} 分`, "花費時間")}${stat(todays.length ? `${(((todays.length - again) / todays.length) * 100).toFixed(0)}%` : "—", "答對率（沒按重來）")}${stat(`${streak} 天`, "連續天數")}</div>
      <h2>近 30 天複習數</h2>${chart("hist", {
        values: hist30,
        labels: days30.map(dayToDate),
        todayIndex: 29,
        summary: `近 30 天共 <b>${hist30.reduce((a, b) => a + b, 0)}</b> 次 · 平均每天 ${(hist30.reduce((a, b) => a + b, 0) / 30).toFixed(1)} 次 <span class="muted">（點長條看每天）</span>`,
        info: (i) => `<b>${dayToDateW(days30[i])}</b> 複習 <b>${hist30[i]}</b> 次`,
      })}
      <h2>未來到期</h2><div id="fc"></div>
      <h2>卡片狀態</h2>
      <table class="simple">${Object.entries(state).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}<tr><td><b>合計</b></td><td><b>${cards.length}</b></td></tr></table>
      <h2>間隔分布（天）</h2>${chart("ivl", {
        values: ivlHist,
        labels: bucketLabels,
        summary: `已學卡片共 <b>${ivlTotal}</b> 張 <span class="muted">（點長條看各區間）</span>`,
        info: (i) => `間隔 <b>${bucketLabels[i]}</b> 天：<b>${ivlHist[i]}</b> 張（${ivlTotal ? ((ivlHist[i] / ivlTotal) * 100).toFixed(0) : 0}%）`,
      })}
      <h2>保留率（近 30 天）</h2>
      <div class="statgrid">${stat(retention === null ? "—" : `${retention.toFixed(1)}%`, `複習卡沒按「重來」的比例（${month.length} 次）`)}${stat(logs.length, "累計複習次數")}</div>
      <h2>複習日曆</h2><div class="heat">${heat}</div>`;
    mountDeckTable($("#dp", el), root);
    redrawForecast = () => drawForecast($("#fc", el), dueByDay, t);
    redrawForecast();
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
