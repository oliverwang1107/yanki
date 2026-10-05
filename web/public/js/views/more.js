// 「更多」：自訂複習、頑固卡與暫停的卡的捷徑、備份、登出等。
import { backupJson, applyRestore, parseBackup, planRestore, planTotal } from "../backup.js";
import { index, store } from "../core.js";
import * as db from "../db.js";
import { getPrefs, setPref } from "../prefs.js";
import { derive } from "../pw.js";
import { speak, ttsAvailable } from "../tts.js";
import { confirmBox, esc, fmtDate, openDialog, setHeader, toast } from "../ui.js";

function download(name, text, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const LAST_BACKUP = "anki-last-backup";
const lastBackupAt = () => { try { return Number(localStorage.getItem(LAST_BACKUP)) || 0; } catch { return 0; } };
const stampBackup = () => { try { localStorage.setItem(LAST_BACKUP, String(Date.now())); } catch { /* 無痕模式 */ } };
const backupAgeText = () => {
  const t = lastBackupAt();
  if (!t) return "這台裝置還沒有下載過備份";
  const days = Math.floor((Date.now() - t) / 86400000);
  return days < 1 ? "上次備份：今天" : `上次備份：${days} 天前（${fmtDate(t)}）`;
};

function downloadBackup() {
  const d = new Date();
  download(`anki-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`, backupJson());
  stampBackup();
}

// 還原：選檔 → 顯示兩種方式各會改動多少 → 確認 → 寫入（之後同步上傳）
function restoreFlow(sync) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let backup;
    try {
      backup = parseBackup(await file.text());
    } catch (err) {
      return toast(err.message, 5000);
    }
    const plans = { merge: planRestore(backup, "merge"), replace: planRestore(backup, "replace") };
    const line = (p) => `新增或更新 ${p.notes.length} 筆筆記、${p.cards.length} 張卡片、${p.revlog.length} 筆複習紀錄${p.ink.length ? `、${p.ink.length} 張手寫標記` : ""}${p.static ? "、牌組與設定" : ""}${p.dropCards.length ? `；刪除 ${p.dropNotes.length} 筆筆記與 ${p.dropCards.length} 張卡片` : ""}`;
    const when = backup.exportedAt ? fmtDate(backup.exportedAt) : "（未知日期）";
    const dlg = openDialog(`<h3>還原備份</h3>
      <p class="small muted">備份日期 ${when} · ${backup.notes.length} 筆筆記 · ${backup.cards.length} 張卡片 · ${backup.revlog.length} 筆複習紀錄</p>
      <label class="check" style="align-items:flex-start"><input type="radio" name="rm" value="merge" checked><span><b>合併（建議）</b><br><span class="small muted">只補上目前缺少的、或備份裡比較新的資料，不會刪除任何東西。<br>${line(plans.merge)}</span></span></label>
      <label class="check" style="align-items:flex-start"><input type="radio" name="rm" value="replace"><span><b>完整還原</b><br><span class="small muted">讓帳號和備份一模一樣；備份之後新增的筆記和卡片會被刪除（複習紀錄只會補回、不會刪除）。還原前會先自動下載一份目前的備份。<br>${line(plans.replace)}</span></span></label>
      ${plans.merge.warnings.length ? `<p class="hint">有 ${plans.merge.warnings.length} 項資料因為缺少關聯而略過。</p>` : ""}
      <p class="error" id="rerr" hidden></p>
      <div class="dialog-actions"><button data-close>取消</button><button class="primary-btn" id="rgo">開始還原</button></div>`);
    const $ = (s) => dlg.el.querySelector(s);
    dlg.el.onclick = (e) => { if (e.target === dlg.el || e.target.closest("[data-close]")) dlg.close(); };
    $("#rgo").onclick = async () => {
      const mode = dlg.el.querySelector("input[name=rm]:checked").value;
      const plan = plans[mode];
      if (!planTotal(plan) && !plan.static) { dlg.close(); return toast("目前的資料已經和備份一致，不需要還原"); }
      if (mode === "replace" && !(await confirmBox(`完整還原會刪除 ${plan.dropCards.length} 張卡片、${plan.dropNotes.length} 筆筆記（備份之後新增的）。繼續嗎？`, { ok: "完整還原", danger: true }))) return;
      if (mode === "replace") downloadBackup(); // 保險：先留一份還原前的備份
      const body = dlg.el.querySelector(".dialog-body");
      body.innerHTML = `<h3>還原中…</h3><p id="pl" class="small muted">準備中</p><progress id="pp" max="1" value="0" style="width:100%"></progress>`;
      try {
        await applyRestore(plan, (frac, label) => {
          const pl = dlg.el.querySelector("#pl"), pp = dlg.el.querySelector("#pp");
          if (pl) pl.textContent = label;
          if (pp) pp.value = frac;
        });
        dlg.close();
        toast("還原完成，正在同步到伺服器…", 4000);
        sync?.();
        location.hash = "#/";
      } catch (err) {
        dlg.close();
        toast(`還原中斷：${err.message}`, 6000);
      }
    };
  };
  input.click();
}

async function logout(clearLocal) {
  if (clearLocal) {
    const pending = (await db.outboxKeys()).length;
    if (pending && !(await confirmBox(`還有 ${pending} 筆複習紀錄沒上傳，清除後會遺失。確定要清除這台裝置的資料並登出嗎？`, { ok: "清除並登出", danger: true }))) return;
    await db.deleteLocalData();
  }
  try { localStorage.removeItem("anki-me"); } catch { /* 無痕模式等 */ }
  await fetch("/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  location.reload();
}

function changePasswordDialog() {
  const me = store.me;
  const dlg = openDialog(`<h3>變更密碼</h3>
    <label for="op">目前的密碼</label><input id="op" type="password" autocomplete="current-password">
    <label for="np">新密碼（至少 8 個字）</label><input id="np" type="password" autocomplete="new-password">
    <label for="np2">再輸入一次新密碼</label><input id="np2" type="password" autocomplete="new-password">
    <p class="error" id="err" hidden></p>
    <div class="dialog-actions"><button data-close>取消</button><button class="primary-btn" id="save">更新密碼</button></div>`);
  const $ = (s) => dlg.el.querySelector(s);
  const fail = (m) => { $("#err").textContent = m; $("#err").hidden = false; };
  dlg.el.onclick = (e) => { if (e.target === dlg.el || e.target.closest("[data-close]")) dlg.close(); };
  $("#save").onclick = async () => {
    const [op, np, np2] = [$("#op").value, $("#np").value, $("#np2").value];
    if (!op || !np) return fail("請填寫所有欄位");
    if (np.length < 8) return fail("新密碼至少要 8 個字");
    if (np !== np2) return fail("兩次輸入的新密碼不一樣");
    $("#save").disabled = true;
    try {
      const res = await fetch("/api/auth/password", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldKey: await derive(me.username, op), newKey: await derive(me.username, np) }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `失敗（${res.status}）`);
      dlg.close();
      toast("密碼已更新，其他裝置需要重新登入", 4000);
    } catch (e) {
      fail(e.message);
      $("#save").disabled = false;
    }
  };
}

export async function mount(el, arg, { sync }) {
  if (arg === "admin") return (await import("./admin.js")).mount(el);
  if (arg === "types") return (await import("./types.js")).mount(el);
  setHeader({ title: "更多" });
  const me = store.me;
  const prefs = getPrefs();
  const link = (href, title, sub) => `<a class="card-box row" href="${href}" style="text-decoration:none;color:inherit"><div class="grow"><b>${title}</b><div class="muted small">${sub}</div></div><span class="muted">›</span></a>`;
  const stats = { notes: store.notes.size, cards: store.cards.size, decks: index.decks.length };
  el.innerHTML = `
    ${link("#/custom", "自訂複習", "用搜尋條件挑卡片複習，例如考前掃描")}
    ${link("#/more/types", "筆記類型與版型", "正反向卡片、填空題、圖片遮蓋、欄位與版型編輯")}
    ${link(`#/browse?q=${encodeURIComponent("is:leech")}`, "頑固卡", "一直忘記的卡片 (leech)")}
    ${link(`#/browse?q=${encodeURIComponent("is:suspended")}`, "暫停的卡片", "不會出現在複習裡")}
    ${link(`#/browse?q=${encodeURIComponent("is:marked")}`, "已標記的筆記", "★")}
    <h2>學習設定</h2>
    <div class="card-box">
      <label for="p-fs">卡片文字大小</label>
      <select id="p-fs">${[[0.9, "小"], [1, "標準"], [1.15, "大"], [1.3, "特大"], [1.5, "超大"]].map(([v, n]) => `<option value="${v}"${prefs.fontScale === v ? " selected" : ""}>${n}</option>`).join("")}</select>
      ${ttsAvailable() ? `<label class="check"><input type="checkbox" id="p-tts"${prefs.tts ? " checked" : ""}>顯示朗讀按鈕（沒有音檔的單字、例句也能聽）</label>
      <label for="p-rate">朗讀速度</label>
      <select id="p-rate">${[[0.7, "慢"], [0.9, "正常"], [1.1, "快"]].map(([v, n]) => `<option value="${v}"${prefs.ttsRate === v ? " selected" : ""}>${n}</option>`).join("")}</select>
      <label for="p-auto">自動朗讀</label>
      <select id="p-auto">${[["off", "關閉"], ["word", "出題時朗讀單字"], ["example", "翻到答案時朗讀例句"]].map(([v, n]) => `<option value="${v}"${prefs.autoSpeak === v ? " selected" : ""}>${n}</option>`).join("")}</select>
      <div class="row" style="margin-top:12px"><button class="btn" id="p-test">🔊 試聽</button></div>` : `<p class="hint">這個瀏覽器不支援語音朗讀。</p>`}
      <p class="hint">這些設定只存在這台裝置上。</p>
    </div>
    <h2>資料</h2>
    <div class="card-box"><div class="muted small">${stats.notes} 張筆記 · ${stats.cards} 張卡片 · ${stats.decks} 個牌組</div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap"><button class="btn" id="resync">重新同步</button><button class="btn" id="backup">下載備份 (JSON)</button><button class="btn" id="restore">還原備份…</button></div>
      <p class="hint"><span id="backup-age">${backupAgeText()}</span>。備份包含所有筆記、卡片、複習紀錄、手寫標記和牌組設定，建議每週下載一次。還原時可以選「合併」（只補缺少的）或「完整還原」。</p></div>
    <h2>帳號</h2>
    <div class="card-box"><div><b>${esc(me?.username ?? "（尚未設定帳號）")}</b>${me?.is_admin ? ` <span class="pill">管理員</span>` : ""}</div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap">${me?.username ? `<button class="btn" id="chpw">變更密碼</button>` : ""}<button class="btn" id="logout">登出</button><button class="btn danger-text" id="logout-clear">登出並清除本機資料</button></div>
      <p class="hint">「登出」只清除登入狀態，這台裝置上的資料仍保留。在公用的電腦或別人的手機上，請用「登出並清除本機資料」。</p></div>
    ${me?.is_admin ? link("#/more/admin", "邀請同學與使用者管理", "產生邀請連結、重設密碼、停用帳號") : ""}
    <p class="muted small" style="margin-top:20px">${esc(location.host)}</p>`;
  el.querySelector("#p-fs").onchange = (e) => setPref("fontScale", Number(e.target.value));
  el.querySelector("#p-tts")?.addEventListener("change", (e) => setPref("tts", e.target.checked));
  el.querySelector("#p-rate")?.addEventListener("change", (e) => (setPref("ttsRate", Number(e.target.value)), speak("Practice makes perfect.")));
  el.querySelector("#p-auto")?.addEventListener("change", (e) => setPref("autoSpeak", e.target.value));
  el.querySelector("#p-test")?.addEventListener("click", () => speak("Practice makes perfect."));
  el.querySelector("#resync").onclick = () => sync();
  el.querySelector("#backup").onclick = () => {
    downloadBackup();
    el.querySelector("#backup-age").textContent = backupAgeText();
    toast("已下載備份");
  };
  el.querySelector("#restore").onclick = () => restoreFlow(sync);
  el.querySelector("#logout").onclick = () => logout(false);
  el.querySelector("#logout-clear").onclick = () => logout(true);
  el.querySelector("#chpw")?.addEventListener("click", changePasswordDialog);
}
