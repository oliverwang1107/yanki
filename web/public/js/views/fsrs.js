// FSRS 參數最佳化：用你自己的複習紀錄算出一組更貼近你記憶的參數（在瀏覽器背景執行，約幾秒到幾十秒），
// 和預設值、目前各牌組設定比較預測準確度，確認後套用到選的牌組設定。套用前會把舊參數記在這台裝置上，隨時可以還原。
import { dayOf, saveStatic, store } from "../core.js";
import { DEFAULT_PARAMS, buildItems } from "../fsrsopt.js";
import { confirmBox, esc, setHeader, toast } from "../ui.js";

const BACKUP = "fsrs-params-backup";
const readBackup = () => { try { return JSON.parse(localStorage.getItem(BACKUP)); } catch { return null; } };

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker("/js/fsrs.worker.js", { type: "module" });
    } catch {
      // 不支援模組 Worker：直接在主執行緒跑（畫面會暫時卡住）
      import("../fsrsopt.js").then(async ({ loadOptimizer }) => {
        const opt = await loadOptimizer(await fetch("/fsrs_opt.wasm"));
        const params = opt.optimize(payload.items, payload.opts);
        resolve({ params, scores: [{ name: "new", params }, ...payload.evalSets].map(({ name, params: p }) => ({ name, ...opt.evaluate(payload.items, p) })) });
      }).catch(reject);
      return;
    }
    w.onmessage = (e) => { w.terminate(); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "背景計算失敗")); };
    w.postMessage(payload);
  });
}

export function mount(el) {
  setHeader({ title: "FSRS 參數最佳化", back: "#/more" });
  const { items, cards } = buildItems([...store.revlog.values()], dayOf);
  const allConfigs = () => store.static.configs;
  const paramConfigs = () => allConfigs().filter((c) => c.params?.length === 21);
  let result = null;
  let evalNames = []; // 評分表裡每一列對應的牌組設定（算的當下的快照）

  function draw() {
    const backup = readBackup();
    el.innerHTML = `
      <div class="card-box"><div><b>${items.length}</b> 個可訓練的複習序列（來自 ${cards} 張卡片）</div>
        <p class="hint">${items.length < 400 ? "資料偏少（建議至少 400 個序列），結果可能不穩定；複習得越多越準。" : "資料量足夠。"}最佳化只讀取你的複習紀錄，在這台裝置上計算，不會上傳。</p>
        <div class="row"><button class="btn primary" id="go"${items.length < 8 ? " disabled" : ""}>開始最佳化</button></div>
        <p id="status" class="muted small"></p></div>
      <div id="result"></div>
      ${backup ? `<div class="card-box"><div class="small muted">上次套用在 ${new Date(backup.at).toLocaleString()}，舊參數還留著。</div><div class="row" style="margin-top:8px"><button class="btn" id="undo">還原成套用前的參數</button></div></div>` : ""}
      <p class="hint">參數是 FSRS-6 的 21 個數字，決定每張卡的間隔怎麼成長。套用後下次複習就會用新參數；已經排好的到期日不會改變。</p>`;
    if (result) drawResult();
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
        const relearn = Math.max(1, ...allConfigs().map((c) => (c.relearnSteps ?? []).length));
        evalNames = paramConfigs().map((c, i) => ({ key: `cfg${i}`, name: c.name, params: c.params }));
        const evalSets = [{ name: "default", params: DEFAULT_PARAMS }, ...evalNames.map((x) => ({ name: x.key, params: x.params }))];
        result = await runWorker({ items, opts: { shortTerm: true, relearnSteps: relearn }, evalSets });
        status.textContent = `完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`;
        drawResult();
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
  draw();
}
