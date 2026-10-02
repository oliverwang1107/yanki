// 管理（只有管理員看得到）：產生新同學的邀請連結、重設密碼連結、停用／啟用帳號。
// 連結只在產生的當下顯示一次；伺服器只存雜湊，之後無法再查。
import { esc, openDialog, setHeader, toast } from "../ui.js";

async function api(path, body) {
  const res = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `失敗（${res.status}）`);
  return data;
}

const when = (t) => (t ? new Date(t).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "從未");

function showLink({ path, title, note }) {
  const url = `${location.origin}${path}`;
  const dlg = openDialog(`<h3>${esc(title)}</h3>
    <p class="muted small" style="margin:0 0 8px">${esc(note)}</p>
    <input id="lnk" readonly value="${esc(url)}" onfocus="this.select()">
    <div class="dialog-actions"><button data-close>關閉</button>${navigator.share ? `<button id="share">分享…</button>` : ""}<button class="primary-btn" id="copy">複製連結</button></div>`);
  dlg.el.onclick = async (e) => {
    if (e.target === dlg.el || e.target.closest("[data-close]")) return dlg.close();
    if (e.target.closest("#copy")) {
      try {
        await navigator.clipboard.writeText(url);
        toast("已複製");
      } catch {
        dlg.el.querySelector("#lnk").select();
        toast("請長按連結手動複製");
      }
    }
    if (e.target.closest("#share")) navigator.share({ title: "單字複習邀請", text: "用這個連結建立帳號：", url }).catch(() => {});
  };
}

export async function mount(el) {
  setHeader({ title: "使用者管理", back: "#/more" });

  async function render() {
    let users;
    try {
      users = (await api("/api/admin/users")).users;
    } catch (e) {
      el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      return;
    }
    el.innerHTML = `
      <div class="card-box"><b>邀請同學</b>
        <p class="hint" style="margin-top:4px">產生一個連結傳給同學，7 天內有效、只能用一次。同學打開連結就能自己設定帳號和密碼。</p>
        <button class="btn primary-btn" id="invite" style="margin-top:8px">產生邀請連結</button></div>
      <h2>使用者（${users.length}）</h2>
      ${users.map((u) => `<div class="card-box" data-id="${u.id}">
        <div class="row"><div class="grow"><b>${esc(u.username)}</b>${u.is_admin ? ` <span class="pill">管理員</span>` : ""}${u.disabled ? ` <span class="pill bad">已停用</span>` : ""}
          <div class="muted small">${u.cards} 張卡片 · ${u.reviews} 次複習 · 最近登入 ${when(u.last_login)}</div></div></div>
        ${u.is_admin ? "" : `<div class="row" style="margin-top:8px;flex-wrap:wrap"><button class="btn" data-act="reset">重設密碼連結</button><button class="btn ${u.disabled ? "" : "danger-text"}" data-act="${u.disabled ? "enable" : "disable"}">${u.disabled ? "啟用" : "停用"}</button></div>`}
      </div>`).join("")}`;
  }

  el.onclick = async (e) => {
    try {
      if (e.target.closest("#invite")) {
        const { code } = await api("/api/admin/invites", { kind: "signup" });
        showLink({ path: `/signup?code=${code}`, title: "邀請連結", note: "傳給你的同學。7 天內有效，只能用一次；關掉這個視窗後就看不到了，要再給別人請重新產生。" });
        return;
      }
      const act = e.target.closest("[data-act]");
      const id = Number(e.target.closest("[data-id]")?.dataset.id);
      if (!act || !id) return;
      if (act.dataset.act === "reset") {
        const { code } = await api("/api/admin/invites", { kind: "reset", uid: id });
        showLink({ path: `/reset?code=${code}`, title: "重設密碼連結", note: "傳給這位同學，24 小時內有效、只能用一次。他設定新密碼後，舊密碼和原本登入的裝置都會失效。" });
      } else {
        await api(`/api/admin/users/${id}/disabled`, { disabled: act.dataset.act === "disable" ? 1 : 0 });
        toast(act.dataset.act === "disable" ? "已停用，對方會立刻被登出" : "已啟用，對方需要重新登入");
        await render();
      }
    } catch (err) {
      toast(err.message);
    }
  };
  await render();
}
