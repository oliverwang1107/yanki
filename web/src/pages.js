// 登入／註冊／重設密碼頁：同一份 HTML，由網址上的邀請碼決定要顯示哪一種表單。
// 密碼的 PBKDF2 在瀏覽器裡做（/js/pw.js），這一頁不載入其他需要登入才能取得的檔案。
const PAGE = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#2563eb">
<link rel="icon" href="/icon.svg"><title>單字複習</title>
<style>
:root{--bg:#f6f7f9;--fg:#1a1d21;--muted:#6b7280;--card:#fff;--line:#d1d5db;--primary:#2563eb;--err:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8eaed;--muted:#9aa0a6;--card:#1a1d23;--line:#2a2f37;--primary:#5b8def;--err:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Noto Sans TC",sans-serif;
  display:grid;place-items:center;padding:24px max(16px,env(safe-area-inset-right)) 24px max(16px,env(safe-area-inset-left))}
main{width:min(380px,100%);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px 22px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);font-size:14px;margin:0 0 18px}
label{display:block;font-size:13px;color:var(--muted);margin:14px 0 4px}
input{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;width:100%}
input:focus{outline:2px solid var(--primary);outline-offset:-1px}
button{font:inherit;width:100%;margin-top:20px;padding:13px;border:0;border-radius:12px;background:var(--primary);color:#fff;font-weight:600;cursor:pointer;min-height:48px}
button:disabled{opacity:.55;cursor:default}
.err{color:var(--err);font-size:14px;margin:12px 0 0;min-height:1.2em}
.hint{color:var(--muted);font-size:13px;margin:16px 0 0}
[hidden]{display:none!important}
</style></head><body><main>
<h1 id="h">單字複習</h1><p class="sub" id="sub">請先登入</p>
<form id="f" autocomplete="on" novalidate>
<label id="lname" for="name">帳號</label><input id="name" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
<label for="pw">密碼</label><input id="pw" name="password" type="password" autocomplete="current-password" required>
<div id="again" hidden><label for="pw2">再輸入一次密碼</label><input id="pw2" type="password" autocomplete="new-password"></div>
<button id="go" type="submit">登入</button><p class="err" id="err" role="alert"></p>
</form>
<p class="hint" id="hint">還沒有帳號嗎？需要朋友給你邀請連結才能註冊。</p>
</main>
<script type="module">
import { derive } from "/js/pw.js";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const code = params.get("code") || "";
if (code) history.replaceState(null, "", location.pathname); // 邀請碼不留在網址列和瀏覽紀錄裡
let mode = "login", info = null;

function setMode(m) {
  mode = m;
  const signup = m === "signup" || m === "claim", reset = m === "reset";
  $("h").textContent = signup ? "建立帳號" : reset ? "重設密碼" : "單字複習";
  $("sub").textContent = m === "claim" ? "為你的帳號設定名稱和密碼" : signup ? "你收到邀請了，設定帳號和密碼吧" : reset ? "請設定新的密碼" : "請先登入";
  $("again").hidden = !(signup || reset);
  $("pw").autocomplete = signup || reset ? "new-password" : "current-password";
  $("go").textContent = signup ? "建立帳號" : reset ? "更新密碼" : "登入";
  $("hint").hidden = signup || reset;
  if (reset) { $("name").value = info?.username || ""; $("name").readOnly = true; $("lname").textContent = "帳號"; }
  $("pw").placeholder = signup || reset ? "至少 8 個字" : "";
}

async function boot() {
  if (!code) return setMode("login");
  try {
    const res = await fetch("/api/auth/invite?code=" + encodeURIComponent(code));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "連結無效");
    info = data;
    setMode(data.kind);
  } catch (e) {
    setMode("login");
    $("err").textContent = e.message || "連結無效或已過期";
  }
}

$("f").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("err"), go = $("go");
  err.textContent = "";
  const name = $("name").value.trim(), pw = $("pw").value;
  if (!name || !pw) return (err.textContent = "請輸入帳號和密碼");
  if (mode !== "login") {
    if (pw.length < 8) return (err.textContent = "密碼至少要 8 個字");
    if (pw !== $("pw2").value) return (err.textContent = "兩次輸入的密碼不一樣");
    if (pw.toLowerCase() === name.toLowerCase()) return (err.textContent = "密碼不能和帳號一樣");
  }
  go.disabled = true;
  const label = go.textContent;
  go.textContent = "處理中…";
  try {
    const key = await derive(name, pw);
    const path = mode === "login" ? "/api/auth/login" : mode === "reset" ? "/api/auth/reset" : "/api/auth/signup";
    const body = mode === "login" ? { username: name, key } : mode === "reset" ? { code, key } : { code, username: name, key };
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "失敗了，請再試一次");
    location.replace("/");
  } catch (e) {
    err.textContent = e.message;
    go.disabled = false;
    go.textContent = label;
  }
});
boot();
</script></body></html>`;

export const authPage = (status = 401) => new Response(PAGE, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
