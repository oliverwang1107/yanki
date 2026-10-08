// FSRS 參數最佳化：用你自己的複習紀錄算出一組更貼近你記憶的參數（在瀏覽器背景執行，約幾秒到幾十秒），
// 和預設值、目前各牌組設定比較預測準確度，確認後套用到選的牌組設定。套用前會把舊參數記在這台裝置上，隨時可以還原。
import { dayOf, index, saveStatic, store } from "../core.js";
import { DEFAULT_PARAMS, DIFF_MARGIN, MIN_TEST, MIN_TRAIN, buildItems, splitVerdict } from "../fsrsopt.js";
import { confirmBox, esc, setHeader, toast } from "../ui.js";

const BACKUP = "fsrs-params-backup";
const readBackup = () => { try { return JSON.parse(localStorage.getItem(BACKUP)); } catch { return null; } };

function runWorker(payload, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker("/js/fsrs.worker.js", { type: "module" });
    } catch {
      // 不支援模組 Worker：直接在主執行緒跑（畫面會暫時卡住）
      import("../fsrsopt.js").then(async ({ compareSplit, loadOptimizer }) => {
        const opt = await loadOptimizer(await fetch("/fsrs_opt.wasm"));
        if (payload.split) return resolve({ split: compareSplit(opt, payload.split, onProgress) });
        const params = opt.optimize(payload.items, payload.opts);
        resolve({ params, scores: [{ name: "new", params }, ...payload.evalSets].map(({ name, params: p }) => ({ name, ...opt.evaluate(payload.items, p) })) });
      }).catch(reject);
      return;
    }
    w.onmessage = (e) => {
      if (e.data.progress) return onProgress(e.data.progress);
      w.terminate();
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "背景計算失敗")); };
    w.postMessage(payload);
  });
}

export function mount(el) {
  setHeader({ title: "FSRS 參數最佳化", back: "#/more" });
  const { items, cids, cards } = buildItems([...store.revlog.values()], dayOf);
  const allConfigs = () => store.static.configs;
  const paramConfigs = () => allConfigs().filter((c) => c.params?.length === 21);
  const relearnSteps = () => Math.max(1, ...allConfigs().map((c) => (c.relearnSteps ?? []).length));
  let result = null;
  let evalNames = []; // 評分表裡每一列對應的牌組設定（算的當下的快照）
  let splitBy = "deck"; // 分牌組比較的分法：deck 依頂層牌組、cfg 依牌組設定
  let splitResult = null;
  let splitLabels = new Map(); // 分組代號 → 顯示名稱（算的當下的快照）

  function draw() {
    const backup = readBackup();
    el.innerHTML = `
      <div class="card-box"><div><b>${items.length}</b> 個可訓練的複習序列（來自 ${cards} 張卡片）</div>
        <p class="hint">${items.length < 400 ? "資料偏少（建議至少 400 個序列），結果可能不穩定；複習得越多越準。" : "資料量足夠。"}最佳化只讀取你的複習紀錄，在這台裝置上計算，不會上傳。</p>
        <div class="row"><button class="btn primary" id="go"${items.length < 8 ? " disabled" : ""}>開始最佳化</button></div>
        <p id="status" class="muted small"></p></div>
      <div id="result"></div>
      <h2>分牌組比較</h2>
      <div class="card-box"><p class="hint" style="margin-top:0">不同牌組各算一組專屬參數，和大家共用一組比，看分開到底有沒有比較準。</p>
        <div class="row" style="margin-top:10px;flex-wrap:wrap"><select id="split-by" style="width:auto"><option value="deck"${splitBy === "deck" ? " selected" : ""}>依頂層牌組分</option><option value="cfg"${splitBy === "cfg" ? " selected" : ""}>依牌組設定分</option></select>
          <button class="btn" id="go-split"${items.length < 8 ? " disabled" : ""}>開始比較</button></div>
        <p id="split-status" class="muted small"></p><div id="split-result"></div></div>
      ${backup ? `<div class="card-box"><div class="small muted">上次套用在 ${new Date(backup.at).toLocaleString()}，舊參數還留著。</div><div class="row" style="margin-top:8px"><button class="btn" id="undo">還原成套用前的參數</button></div></div>` : ""}
      <p class="hint">參數是 FSRS-6 的 21 個數字，決定每張卡的間隔怎麼成長。套用後下次複習就會用新參數；已經排好的到期日不會改變。</p>`;
    if (result) drawResult();
    if (splitResult) drawSplit();
  }

  function drawSplit() {
    const { groups, overall } = splitResult;
    const loss = (s) => s.logLoss.toFixed(4);
    const word = { split: "專屬較準", shared: "共用較準", same: "差不多" };
    const rows = groups.map((g) => {
      const name = esc(splitLabels.get(g.key) ?? g.key);
      if (g.skipped) return `<tr><td class="dp-name">${name}</td><td colspan="4" class="muted small" style="white-space:normal">資料太少，不比較（訓練 ${g.train}、測試 ${g.test}）</td></tr>`;
      const v = splitVerdict(g.global.logLoss, g.own.logLoss, g.test);
      return `<tr><td class="dp-name">${name}</td><td>${g.test}</td><td>${loss(g.global)}</td><td>${loss(g.own)}</td><td><b>${word[v]}</b></td></tr>`;
    });
    let summary = "";
    if (overall) {
      const v = splitVerdict(overall.global, overall.own, overall.test);
      summary = `<p style="margin:12px 0 0">整體（${overall.test} 個測試序列）：共用 ${overall.global.toFixed(4)}，分開 ${overall.own.toFixed(4)}。${{
        split: "分開明顯比較準，結論是「專屬較準」的牌組值得用自己的一組參數。",
        shared: "分開反而比較差（資料被切碎，參數變不穩），用共用一組就好。",
        same: "分開沒有比較準，用共用一組就好。",
      }[v]}</p>`;
    }
    el.querySelector("#split-result").innerHTML = `<table class="simple dp-table" style="margin-top:12px">
        <tr class="muted small"><td></td><td>測試</td><td>共用</td><td>專屬</td><td>結論</td></tr>${rows.join("")}</table>${summary}
      <p class="hint">數字是 log loss，越小越準。每張卡固定有約 20% 的機率被留作測試，不參與任何一組參數的訓練，所以共用與專屬是公平比較（用同一批紀錄訓練再打分數，專屬一定會贏）。差距沒超過雜訊的兩倍（約 0.22 ÷ √測試序列數，最少 ${DIFF_MARGIN}）就當作沒差別，測試序列越少門檻越高；每組至少要有 ${MIN_TRAIN} 個訓練序列和 ${MIN_TEST} 個測試序列才會比較。</p>`;
  }

  function drawResult() {
    const s = Object.fromEntries(result.scores.map((x) => [x.name, x]));
    const rows = [["new", "新參數（用你全部的紀錄）"], ["default", "FSRS-6 預設值"], ...evalNames.map(({ key, name }) => [key, `目前「${name}」`])].filter(([k]) => s[k]);
    const best = Math.min(...rows.map(([k]) => s[k].logLoss));
    el.querySelector("#result").innerHTML = `<h2>預測準確度</h2>
      <div class="card-box"><table style="width:100%;border-collapse:collapse">
        <tr class="muted small"><td></td><td>log loss</td><td>RMSE</td></tr>
        ${rows.map(([k, label]) => `<tr><td>${esc(label)}</td><td>${s[k].logLoss.toFixed(4)}${s[k].logLoss === best ? " ✓" : ""}</td><td>${s[k].rmse.toFixed(4)}</td></tr>`).join("")}
      </table><p class="hint">數字越小越準（log loss 是主要指標）。新參數是用同一批紀錄訓練的，所以在這批紀錄上通常最準；紀錄越多越可信。</p></div>
      <h2>套用到哪些牌組設定</h2>
      <div class="card-box">${allConfigs().map((c) => `<label class="check"><input type="checkbox" data-cfg="${c.id}" checked>${esc(c.name)}${c.params?.length === 21 ? "" : ' <span class="muted small">（目前用預設參數）</span>'}</label>`).join("")}
        <div class="row" style="margin-top:10px"><button class="btn primary" id="apply">套用新參數</button></div></div>`;
  }

  el.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "go") {
      b.disabled = true;
      const status = el.querySelector("#status");
      status.textContent = "計算中…（在背景執行，可以先看別的頁面，但請別關掉這個分頁）";
      const t0 = Date.now();
      try {
        evalNames = paramConfigs().map((c, i) => ({ key: `cfg${i}`, name: c.name, params: c.params }));
        const evalSets = [{ name: "default", params: DEFAULT_PARAMS }, ...evalNames.map((x) => ({ name: x.key, params: x.params }))];
        result = await runWorker({ items, opts: { shortTerm: true, relearnSteps: relearnSteps() }, evalSets });
        status.textContent = `完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`;
        drawResult();
      } catch (err) {
        status.textContent = `失敗：${err.message}`;
      }
      b.disabled = false;
    } else if (b.id === "go-split") {
      const status = el.querySelector("#split-status");
      const labels = new Map();
      const groupOf = (cid) => {
        const deck = index.deckById.get(store.cards.get(cid)?.did);
        if (!deck) return null;
        if (splitBy === "cfg") {
          const cfg = index.configById.get(deck.config);
          if (!cfg) return null;
          labels.set(String(cfg.id), cfg.name);
          return String(cfg.id);
        }
        const top = deck.name.split("::")[0];
        labels.set(top, top);
        return top;
      };
      const groups = cids.map(groupOf);
      if (new Set(groups.filter((g) => g != null)).size < 2) {
        status.textContent = `目前只有一個${splitBy === "cfg" ? "牌組設定" : "頂層牌組"}有複習紀錄，沒有可以比較的對象。`;
        return;
      }
      b.disabled = true;
      status.textContent = "計算中…（在背景執行，可以先看別的頁面，但請別關掉這個分頁）";
      const t0 = Date.now();
      try {
        const res = await runWorker({ split: { items, cids, groups, opts: { shortTerm: true, relearnSteps: relearnSteps() } } },
          (what) => { status.textContent = `計算中：${what}…`; });
        splitResult = res.split;
        splitLabels = labels;
        status.textContent = `完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`;
        drawSplit();
      } catch (err) {
        status.textContent = `失敗：${err.message}`;
      }
      b.disabled = false;
    } else if (b.id === "apply") {
      const ids = new Set([...el.querySelectorAll("[data-cfg]:checked")].map((x) => Number(x.dataset.cfg)));
      if (!ids.size) return toast("請至少選一個牌組設定");
      if (!(await confirmBox(`把新參數套用到 ${ids.size} 個牌組設定？舊參數會先記下來，之後可以還原。`, { ok: "套用" }))) return;
      try {
        const before = allConfigs().filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, params: c.params ?? [] }));
        const updated = allConfigs().map((c) => (ids.has(c.id) ? { ...c, params: result.params.map((x) => Math.round(x * 1e4) / 1e4) } : c));
        await saveStatic({ configs: updated });
        try { localStorage.setItem(BACKUP, JSON.stringify({ at: Date.now(), before })); } catch { /* 無痕模式 */ }
        toast("已套用新參數");
        draw();
      } catch (err) {
        toast(err.message, 5000);
      }
    } else if (b.id === "undo") {
      const backup = readBackup();
      if (!backup || !(await confirmBox("還原成套用前的參數？", { ok: "還原" }))) return;
      try {
        const old = new Map(backup.before.map((x) => [x.id, x.params]));
        await saveStatic({ configs: allConfigs().map((c) => (old.has(c.id) ? { ...c, params: old.get(c.id) } : c)) });
        try { localStorage.removeItem(BACKUP); } catch { /* 無痕模式 */ }
        toast("已還原");
        draw();
      } catch (err) {
        toast(err.message, 5000);
      }
    }
  };
  el.onchange = (e) => { if (e.target.id === "split-by") splitBy = e.target.value; };
  draw();
}
