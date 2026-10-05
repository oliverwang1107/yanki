// 匯入 Anki 牌組（.apkg）：選檔 → 讀取並顯示內容摘要 → 選擇放置方式與進度選項 → 匯入。
// 全部在瀏覽器裡處理（解壓縮、讀 SQLite），只有轉出來的筆記、卡片與媒體會上傳到你的帳號。
import { readPackage } from "../apkg.js";
import { index } from "../core.js";
import { applyPlan, buildPlan } from "../importer.js";
import { uploadBytes } from "../media.js";
import { esc, setHeader, toast } from "../ui.js";

let libs;
// 第一次用到才載入 sql.js（約 650KB）與 zstd 解壓縮，平常不會下載
async function loadLibs() {
  libs ??= (async () => {
    if (!globalThis.initSqlJs) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "/vendor/sql-wasm.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("無法載入 SQLite 元件，請確認網路後重試"));
        document.head.append(s);
      });
    }
    const [SQL, { decompress }] = await Promise.all([globalThis.initSqlJs({ locateFile: () => "/vendor/sql-wasm.wasm" }), import("/vendor/fzstd.mjs")]);
    return { SQL, zstd: decompress };
  })().catch((e) => {
    libs = undefined;
    throw e;
  });
  return libs;
}

export function mount(el, { sync } = {}) {
  setHeader({ title: "匯入 Anki 牌組", back: "#/more" });
  let pkg = null;
  let fileName = "";

  const drawPick = () => {
    el.innerHTML = `<div class="card-box"><p>選擇 Anki 匯出的牌組檔（<b>.apkg</b>）。新舊版 Anki 的格式都可以，包含圖片、音檔、填空題、圖片遮蓋與正反向卡片。</p>
      <div class="row"><button class="btn primary" id="pick">選擇 .apkg 檔案</button></div>
      <p id="msg" class="muted small"></p></div>
      <p class="hint">在 Anki 裡匯出：檔案 → 匯出 → 格式選「Anki 牌組套件 (*.apkg)」。想連複習進度一起搬，匯出時勾選「包含排程資訊」。</p>`;
    el.querySelector("#pick").onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".apkg,.zip";
      input.onchange = () => input.files[0] && load(input.files[0]);
      input.click();
    };
  };

  async function load(file) {
    const msg = el.querySelector("#msg");
    msg.textContent = "讀取中…（大檔案可能要幾秒）";
    try {
      pkg = await readPackage(file, await loadLibs());
      fileName = file.name.replace(/\.[^.]+$/, "");
      drawOptions();
    } catch (err) {
      msg.textContent = `無法讀取：${err.message}`;
      msg.className = "error small";
    }
  }

  function current() {
    const q = (s) => el.querySelector(s);
    return {
      deckMode: q("input[name=dm]:checked").value,
      root: q("#o-root").value,
      targetDeckId: Number(q("#o-deck").value),
      keepScheduling: q("#o-sched").checked,
      skipDuplicates: q("#o-dup").checked,
      extraTag: q("#o-tag").value,
    };
  }

  function drawOptions() {
    const hasSched = pkg.cards.some((c) => c.type !== 0);
    el.innerHTML = `
      <div class="card-box"><b>${esc(fileName)}</b>
        <div class="muted small">${pkg.notes.length} 筆筆記 · ${pkg.cards.length} 張卡片 · ${pkg.notetypes.length} 種筆記類型 · ${pkg.decks.length} 個牌組 · ${pkg.media.names.length} 個媒體檔</div></div>
      <h2>放進哪個牌組</h2>
      <div class="card-box">
        <label class="check" style="align-items:flex-start"><input type="radio" name="dm" value="keep" checked><span>照原本的牌組階層<br><span class="small muted">放在這個根牌組底下（留白就直接建立原本的牌組）</span><br><input id="o-root" value="${esc(fileName)}" placeholder="根牌組名稱" style="margin-top:6px;width:100%;min-width:14em"></span></label>
        <label class="check" style="align-items:flex-start"><input type="radio" name="dm" value="single"><span>全部放進一個現有的牌組<br><select id="o-deck" style="margin-top:6px">${index.decks.map((d) => `<option value="${d.id}">${esc(d.name.replaceAll("::", " › "))}</option>`).join("")}</select></span></label>
      </div>
      <h2>選項</h2>
      <div class="card-box">
        <label class="check"><input type="checkbox" id="o-sched"${hasSched ? " checked" : " disabled"}>保留複習進度與紀錄${hasSched ? "" : "（這個檔案沒有進度，全部會是新卡）"}</label>
        <label class="check"><input type="checkbox" id="o-dup" checked>略過已經有的筆記（相同 ID，或同類型且第一個欄位相同）</label>
        <label>幫匯入的筆記加標籤（可留白）</label><input id="o-tag" value="匯入" autocapitalize="none">
      </div>
      <div id="summary" class="card-box"></div>
      <p class="error" id="err" hidden></p>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="go">開始匯入</button><button class="btn" id="back">換一個檔案</button></div>`;
    const refresh = () => {
      const q = (s) => el.querySelector(s);
      q("#o-root").disabled = q("input[name=dm]:checked").value !== "keep";
      q("#o-deck").disabled = !q("#o-root").disabled;
      try {
        const s = buildPlan(pkg, current()).summary;
        q("#summary").innerHTML = `<b>將匯入</b>：${s.notes} 筆筆記、${s.cards} 張卡片${s.revlog ? `、${s.revlog} 筆複習紀錄` : ""}${s.media ? `、${s.media} 個媒體檔` : ""}
          <div class="muted small">新增 ${s.decks} 個牌組、${s.noteTypes} 種筆記類型（重用 ${s.reusedNoteTypes} 種現有的）${s.duplicates ? `；略過 ${s.duplicates} 筆重複的` : ""}${s.missingMedia ? `；${s.missingMedia} 個引用的媒體檔不在套件裡` : ""}</div>
          ${s.estimatedWrites > 20000 ? `<p class="hint">這次大約會寫入 ${s.estimatedWrites.toLocaleString()} 列資料。Cloudflare 免費額度每天約 10 萬列，建議不要在同一天做太多大型匯入。</p>` : ""}`;
        q("#go").disabled = !s.notes;
        q("#err").hidden = true;
      } catch (err) {
        q("#summary").innerHTML = "";
        q("#err").textContent = err.message;
        q("#err").hidden = false;
        q("#go").disabled = true;
      }
    };
    el.oninput = el.onchange = refresh;
    refresh();
    el.querySelector("#back").onclick = () => {
      pkg = null;
      drawPick();
    };
    el.querySelector("#go").onclick = run;
  }

  async function run() {
    const plan = buildPlan(pkg, current());
    el.innerHTML = `<div class="card-box"><b>匯入中…</b><p id="pl" class="small muted">準備中</p><progress id="pp" max="1" value="0" style="width:100%"></progress><p class="hint">請先不要離開這個頁面。</p></div>`;
    try {
      const out = await applyPlan(plan, pkg, {
        uploader: uploadBytes,
        onProgress: (label, frac) => {
          const pl = el.querySelector("#pl");
          const pp = el.querySelector("#pp");
          if (pl) pl.textContent = label;
          if (pp) pp.value = frac;
        },
      });
      const warn = [out.mediaSkipped ? `${out.mediaSkipped} 個媒體檔格式不支援或太大，沒有上傳` : "", out.missingMedia ? `${out.missingMedia} 個引用的媒體檔不在套件裡` : ""].filter(Boolean);
      el.innerHTML = `<div class="card-box"><h3>匯入完成 🎉</h3><p>${out.notes} 筆筆記、${out.cards} 張卡片${out.media ? `、${out.media} 個媒體檔` : ""}已加入。${warn.length ? `<br><span class="muted small">${warn.join("；")}</span>` : ""}</p>
        <div class="row"><a class="btn primary" href="#/">回到牌組</a><a class="btn" href="#/browse?q=${encodeURIComponent("added:1")}">看剛匯入的卡片</a></div></div>`;
      toast("匯入完成，正在同步…", 3000);
      sync?.();
    } catch (err) {
      el.innerHTML = `<div class="card-box"><p class="error">匯入中斷：${esc(err.message)}</p><p class="hint">已經寫入的部分會保留；重新匯入時選「略過已經有的筆記」就不會重複。</p><div class="row"><button class="btn" id="again">重新開始</button></div></div>`;
      el.querySelector("#again").onclick = () => {
        pkg = null;
        drawPick();
      };
    }
  }

  drawPick();
}
