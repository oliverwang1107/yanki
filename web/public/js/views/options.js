// 牌組選項：每日上限、學習步驟、目標記憶率、最長間隔、FSRS 參數、擱置與頑固卡設定。
import { CONFIG_DEFAULTS, cfgValue, index, inTree, saveStatic, store, uid } from "../core.js";
import { confirmBox, esc, promptBox, setHeader, toast } from "../ui.js";

const numList = (text) => String(text).split(/[\s,，]+/).filter(Boolean).map(Number);
const stepsText = (steps) => (steps ?? []).join(" ");

function validate(f) {
  const int = (v, name, min, max) => {
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name}要是 ${min} 到 ${max} 的整數`);
    return v;
  };
  const steps = (text, name) => {
    const list = numList(text);
    if (list.some((n) => !Number.isFinite(n) || n <= 0 || n > 43200)) throw new Error(`${name}要是正數（分鐘），用空白分隔，例如 1 10`);
    if (list.some((n, i) => i && n < list[i - 1])) throw new Error(`${name}要由小到大排列`);
    return list;
  };
  const retention = Number(f.desiredRetention);
  if (!(retention >= 0.7 && retention <= 0.99)) throw new Error("目標記憶率要在 0.70 到 0.99 之間");
  const params = f.params.trim() ? numList(f.params) : [];
  if (params.length && (![17, 19, 21].includes(params.length) || params.some((n) => !Number.isFinite(n)))) throw new Error(`FSRS 參數要是 17、19 或 21 個數字（目前 ${params.length} 個），留空則使用預設值`);
  return {
    newPerDay: int(Number(f.newPerDay), "每日新卡上限", 0, 9999),
    revPerDay: int(Number(f.revPerDay), "每日複習上限", 0, 9999),
    learnSteps: steps(f.learnSteps, "學習步驟"),
    relearnSteps: steps(f.relearnSteps, "重學步驟"),
    desiredRetention: retention,
    maxIvl: int(Number(f.maxIvl), "最長間隔", 1, 36500),
    minLapseIvl: int(Number(f.minLapseIvl), "重學後最短間隔", 1, 36500),
    params,
    newOrder: f.newOrder,
    buryNew: f.buryNew,
    buryReviews: f.buryReviews,
    leechFails: int(Number(f.leechFails), "頑固卡門檻", 0, 99),
    leechAction: f.leechAction,
    showDictionary: f.showDictionary,
  };
}

export function mount(el, deckId) {
  const deck = index.deckById.get(deckId);
  setHeader({ title: "牌組選項", back: "#/" });
  if (!deck) {
    el.innerHTML = `<p class="muted">找不到這個牌組。</p>`;
    return;
  }
  let cfgId = deck.config;

  function draw() {
    const cfg = index.configById.get(cfgId);
    const using = store.static.decks.filter((d) => d.config === cfgId);
    const subs = index.decks.filter((d) => d.id !== deck.id && inTree(d, deck));
    el.innerHTML = `
      <p class="muted" style="margin-top:0">${esc(deck.name.replaceAll("::", " › "))}</p>
      <div class="card-box">
        <label style="margin-top:0">預設組（${using.length} 個牌組使用）</label>
        <select id="preset">${store.static.configs.map((c) => `<option value="${c.id}"${c.id === cfgId ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        <div class="row" style="margin-top:10px;flex-wrap:wrap"><button class="btn" id="p-new">新增預設組</button><button class="btn" id="p-clone">複製</button><button class="btn" id="p-rename">改名</button><button class="btn danger-text" id="p-del">刪除</button></div>
      </div>
      <form id="opts">
        <h2>每日上限</h2>
        <div class="optgrid"><div><label>新卡 / 天</label><input name="newPerDay" inputmode="numeric" value="${cfg.newPerDay}"></div><div><label>複習 / 天</label><input name="revPerDay" inputmode="numeric" value="${cfg.revPerDay}"></div></div>
        <p class="hint">每個牌組各算一次；從上層牌組讀的時候，上層牌組自己的上限也會限制總量。</p>
        <h2>新卡與步驟</h2>
        <div class="optgrid"><div><label>學習步驟（分鐘）</label><input name="learnSteps" value="${esc(stepsText(cfg.learnSteps))}"></div><div><label>重學步驟（分鐘）</label><input name="relearnSteps" value="${esc(stepsText(cfg.relearnSteps))}"></div></div>
        <label>新卡順序</label><select name="newOrder"><option value="pos"${cfgValue(cfg, "newOrder") === "pos" ? " selected" : ""}>依新增順序</option><option value="random"${cfgValue(cfg, "newOrder") === "random" ? " selected" : ""}>隨機</option></select>
        <h2>排程（FSRS）</h2>
        <div class="optgrid"><div><label>目標記憶率</label><input name="desiredRetention" inputmode="decimal" value="${cfg.desiredRetention}"></div><div><label>最長間隔（天）</label><input name="maxIvl" inputmode="numeric" value="${cfg.maxIvl}"></div>
        <div><label>重學後最短間隔（天）</label><input name="minLapseIvl" inputmode="numeric" value="${cfg.minLapseIvl ?? 1}"></div></div>
        <label>FSRS 參數（${(cfg.params ?? []).length || "預設"}）</label><textarea name="params" rows="3" spellcheck="false" placeholder="留空使用預設參數；或貼上 21 個數字">${esc((cfg.params ?? []).join(", "))}</textarea>
        <p class="hint">最長間隔是考前複習的保險：每張卡最遲這麼多天一定會再出現。改設定只影響「之後」的排程，已排好的卡不會動。</p>
        <h2>擱置與頑固卡</h2>
        <label class="check"><input type="checkbox" name="buryNew"${cfgValue(cfg, "buryNew") ? " checked" : ""}>擱置同一筆記的其他新卡（作答後擱置到明天）</label>
        <label class="check"><input type="checkbox" name="buryReviews"${cfgValue(cfg, "buryReviews") ? " checked" : ""}>擱置同一筆記的其他複習卡</label>
        <div class="optgrid"><div><label>頑固卡門檻（遺忘次數，0 = 關閉）</label><input name="leechFails" inputmode="numeric" value="${cfgValue(cfg, "leechFails")}"></div>
        <div><label>達到門檻時</label><select name="leechAction"><option value="tag"${cfgValue(cfg, "leechAction") === "tag" ? " selected" : ""}>只加 leech 標籤</option><option value="suspend"${cfgValue(cfg, "leechAction") === "suspend" ? " selected" : ""}>加標籤並暫停</option></select></div></div>
        <h2>顯示</h2>
        <label class="check"><input type="checkbox" name="showDictionary"${cfgValue(cfg, "showDictionary") ? " checked" : ""}>翻面後顯示字典（同義字、反義字、英文釋義…）</label>
        ${subs.length ? `<h2>套用範圍</h2><label class="check"><input type="checkbox" id="apply-subs">同時把 ${subs.length} 個子牌組改用這個預設組</label>` : ""}
        <div id="opt-error" class="error" hidden></div>
        <div class="row" style="margin-top:20px"><button class="btn primary" id="save" type="submit">儲存</button><button class="btn" id="cancel" type="button">取消</button></div>
      </form>`;

    const form = el.querySelector("#opts");
    const read = () => {
      const f = {};
      for (const input of form.elements) {
        if (!input.name) continue;
        f[input.name] = input.type === "checkbox" ? input.checked : input.value;
      }
      return f;
    };
    const fail = (msg) => {
      const box = el.querySelector("#opt-error");
      box.textContent = msg;
      box.hidden = !msg;
    };

    el.querySelector("#preset").onchange = (e) => ((cfgId = Number(e.target.value)), draw());
    el.querySelector("#cancel").onclick = () => (location.hash = "#/");
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        fail("");
        const next = { ...cfg, ...validate(read()) };
        const configs = store.static.configs.map((c) => (c.id === cfgId ? next : c));
        const apply = el.querySelector("#apply-subs")?.checked;
        const decks = store.static.decks.map((d) => (d.id === deck.id || (apply && inTree(d, deck)) ? { ...d, config: cfgId } : d));
        await saveStatic({ configs, decks });
        toast("已儲存");
        location.hash = "#/";
      } catch (err) {
        fail(err.message);
      }
    };
    const preset = async (fn) => {
      try {
        await fn();
        draw();
      } catch (err) {
        toast(err.message);
      }
    };
    el.querySelector("#p-new").onclick = () => preset(async () => {
      const name = await promptBox({ title: "新增預設組", placeholder: "名稱" });
      if (!name) return;
      const fresh = { id: uid(), name, newPerDay: 20, revPerDay: 200, maxIvl: 36500, desiredRetention: 0.9, learnSteps: [1, 10], relearnSteps: [10], minLapseIvl: 1, params: [], ...CONFIG_DEFAULTS };
      await saveStatic({ configs: [...store.static.configs, fresh], decks: store.static.decks.map((d) => (d.id === deck.id ? { ...d, config: fresh.id } : d)) });
      cfgId = fresh.id;
    });
    el.querySelector("#p-clone").onclick = () => preset(async () => {
      const name = await promptBox({ title: "複製預設組", value: `${cfg.name} 副本` });
      if (!name) return;
      const copy = { ...cfg, id: uid(), name };
      await saveStatic({ configs: [...store.static.configs, copy], decks: store.static.decks.map((d) => (d.id === deck.id ? { ...d, config: copy.id } : d)) });
      cfgId = copy.id;
    });
    el.querySelector("#p-rename").onclick = () => preset(async () => {
      const name = await promptBox({ title: "改名", value: cfg.name });
      if (name) await saveStatic({ configs: store.static.configs.map((c) => (c.id === cfgId ? { ...c, name } : c)) });
    });
    el.querySelector("#p-del").onclick = () => preset(async () => {
      if (store.static.configs.length < 2) throw new Error("至少要保留一個預設組");
      if (!(await confirmBox(`刪除預設組「${cfg.name}」？使用它的 ${using.length} 個牌組會改用另一個預設組。`, { ok: "刪除", danger: true }))) return;
      const fallback = store.static.configs.find((c) => c.id !== cfgId);
      await saveStatic({ configs: store.static.configs.filter((c) => c.id !== cfgId), decks: store.static.decks.map((d) => (d.config === cfgId ? { ...d, config: fallback.id } : d)) });
      cfgId = fallback.id;
    });
  }
  draw();
}
