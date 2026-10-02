// 自訂複習：用搜尋條件挑卡片複習，不受每日上限限制（取代 Anki 的篩選牌組，例如考前掃描）。
import { index } from "../core.js";
import { SearchError, search } from "../search.js";
import { $, esc, promptBox, setHeader, toast } from "../ui.js";

const KEY = "custom-presets";
const ORDERS = [["due", "到期日最早的優先"], ["oldest", "最久沒看的優先"], ["difficulty", "難度最高的優先"], ["lapses", "忘記最多次的優先"], ["random", "隨機"]];

function loadPresets() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(saved)) return saved;
  } catch {}
  // 第一次使用：依你的複習計畫放兩個範例（牌組存在才放）
  const names = new Set(index.decks.map((d) => d.name));
  const presets = [];
  if (names.has("多益 900分 ENG-CH")) {
    presets.push({ name: "多益 考前掃描", q: 'deck:"多益 900分 ENG-CH" -is:new -rated:7', limit: 150, order: "oldest" });
    presets.push({ name: "多益 弱點牌", q: 'deck:"多益 900分 ENG-CH" (rated:30:1 or prop:lapses>=1 or prop:d>0.5)', limit: 150, order: "difficulty" });
  }
  if (names.has("英文單字")) presets.push({ name: "英文單字 考前總掃描", q: "deck:英文單字 -is:new -rated:14", limit: 200, order: "oldest" });
  return presets;
}
const savePresets = (list) => localStorage.setItem(KEY, JSON.stringify(list));

export function mount(el) {
  setHeader({ title: "自訂複習", back: "#/" });
  let presets = loadPresets();
  const last = JSON.parse(localStorage.getItem("custom-last") ?? "null") ?? { q: "is:due", limit: 100, order: "due" };

  const draw = () => {
    el.innerHTML = `
      <div class="card-box">
        <label style="margin-top:0">搜尋條件</label>
        <textarea id="c-q" rows="2" spellcheck="false" autocapitalize="none">${esc(last.q)}</textarea>
        <div class="optgrid"><div><label>最多幾張</label><input id="c-limit" inputmode="numeric" value="${last.limit}"></div>
        <div><label>順序</label><select id="c-order">${ORDERS.map(([k, v]) => `<option value="${k}"${k === last.order ? " selected" : ""}>${v}</option>`).join("")}</select></div></div>
        <div id="c-info" class="hint"></div>
        <div class="row" style="margin-top:14px;flex-wrap:wrap"><button class="btn primary" id="c-start">開始複習</button><button class="btn" id="c-save">存成常用</button><a class="btn" href="#/browse" id="c-browse" style="text-decoration:none">在瀏覽器看</a></div>
        <p class="hint">暫停與擱置的卡不會出現。照實際作答重新排程，所以這次的複習會和一般複習一樣記進進度。</p>
      </div>
      <h2>常用</h2>
      ${presets.length ? presets.map((p, i) => `<div class="card-box row"><div class="grow"><b>${esc(p.name)}</b><div class="muted small" style="overflow-wrap:anywhere">${esc(p.q)}</div></div><button class="btn" data-use="${i}">使用</button><button class="btn danger-text" data-del="${i}">刪除</button></div>`).join("") : `<p class="muted small">還沒有。設定好條件後按「存成常用」。</p>`}
      <h2>語法速查</h2>
      <div class="card-box small muted" style="line-height:1.8">
        <code>deck:名稱</code>（含子牌組） · <code>tag:標籤</code> · <code>is:new / learn / review / due / suspended</code><br>
        <code>rated:7</code> 近 7 天有複習 · <code>rated:7:1</code> 近 7 天按過「重來」 · <code>added:3</code> · <code>introduced:7</code><br>
        <code>prop:ivl&gt;=21</code> · <code>prop:due&lt;0</code> 逾期 · <code>prop:lapses&gt;=2</code> · <code>prop:d&gt;0.5</code> 難度 · <code>prop:r&lt;0.9</code> 可提取率<br>
        <code>-</code> 否定 · <code>or</code> 或 · <code>( )</code> 括號 · <code>"詞組"</code> · <code>*</code> 萬用字元 · <code>欄位名:內容</code>
      </div>`;
    const read = () => ({ q: $("#c-q", el).value.trim(), limit: Math.max(1, Number($("#c-limit", el).value) || 100), order: $("#c-order", el).value });
    const preview = () => {
      const { q } = read();
      try {
        const all = search(q);
        const usable = all.filter((c) => c.queue >= 0).length;
        $("#c-info", el).innerHTML = `符合 ${all.length} 張卡片，其中 ${usable} 張可以複習（排除暫停與擱置）`;
      } catch (err) {
        if (!(err instanceof SearchError)) throw err;
        $("#c-info", el).innerHTML = `<span class="error" style="margin:0">${esc(err.message)}</span>`;
      }
    };
    $("#c-q", el).oninput = preview;
    $("#c-start", el).onclick = () => {
      const v = read();
      try {
        search(v.q);
      } catch (err) {
        return toast(err.message);
      }
      localStorage.setItem("custom-last", JSON.stringify(v));
      location.hash = `#/study?q=${encodeURIComponent(v.q)}&limit=${v.limit}&order=${v.order}`;
    };
    $("#c-browse", el).onclick = () => localStorage.setItem("browse-q", read().q);
    $("#c-save", el).onclick = async () => {
      const name = await promptBox({ title: "存成常用", placeholder: "名稱" });
      if (!name) return;
      presets = [...presets, { name, ...read() }];
      savePresets(presets);
      draw();
    };
    el.onclick = (e) => {
      const use = e.target.closest("[data-use]");
      const del = e.target.closest("[data-del]");
      if (use) {
        Object.assign(last, presets[Number(use.dataset.use)]);
        draw();
      } else if (del) {
        presets = presets.filter((_, i) => i !== Number(del.dataset.del));
        savePresets(presets);
        draw();
      }
    };
    preview();
  };
  draw();
}
