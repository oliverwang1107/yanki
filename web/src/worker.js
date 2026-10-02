// Worker 負責：登入與帳號、靜態檔、對 D1 存取「每個人自己的」資料。所有排程運算都在瀏覽器的 WASM 裡。
// 免費方案每個請求 CPU 只有約 10ms，所以密碼的重運算（PBKDF2）放在瀏覽器，這裡只做雜湊比對。
import { COOKIE, authenticate, changePassword, clearCookie, inviteInfo, login, reset, signup } from "./auth.js";
import { createInvite, joinLibrary, listLibrary, listUsers, setDisabled } from "./admin.js";
import { pull, push, saveStatic, staticData } from "./data.js";
import { authPage } from "./pages.js";
import { json } from "./util.js";

// 這幾個檔案不含任何祕密，登入頁和「加到主畫面」需要在登入前取得。
const PUBLIC_FILES = new Set(["/js/pw.js", "/icon.svg", "/manifest.webmanifest"]);

// 靜態資源不一定支援 Range，而 iOS Safari 播放音檔需要 206；音檔都很小，直接在這裡切。
async function media(request, env) {
  const plain = new Request(request.url, { headers: new Headers([...request.headers].filter(([k]) => k.toLowerCase() !== "range")) });
  const res = await env.ASSETS.fetch(plain);
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
  if (!res.ok || !range || (!range[1] && !range[2])) {
    const headers = new Headers(res.headers);
    headers.set("Accept-Ranges", "bytes");
    return new Response(res.body, { status: res.status, headers });
  }
  const buf = await res.arrayBuffer();
  const start = range[1] ? Number(range[1]) : Math.max(0, buf.byteLength - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), buf.byteLength - 1) : buf.byteLength - 1;
  if (start > end || start >= buf.byteLength) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${buf.byteLength}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400",
    },
  });
}

// 資料庫暫時不能用（例如免費方案的每日寫入額度用完）時，回一個前端看得懂的 503，並讓重試有依據。
function failure(request, e) {
  console.error("unhandled:", e?.stack ?? e);
  const isApi = new URL(request.url).pathname.startsWith("/api/");
  const message = "伺服器暫時無法處理（可能是 Cloudflare 免費額度用完，台灣時間每天早上 8 點重置）。資料先存在這台裝置，之後會自動同步。";
  return isApi ? json({ error: message, busy: true }, 503, { "Retry-After": "600" }) : new Response(message, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "600" } });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return failure(request, e);
    }
  },
};

async function handle(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const post = request.method === "POST";

    // 寫入類請求必須來自本站（SameSite=Strict 之外再加一道）
    if (post) {
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return json({ error: "forbidden" }, 403);
    }

    // ----- 不需要登入 -----
    if (path === "/api/auth/login" && post) return login(request, env);
    if (path === "/api/auth/signup" && post) return signup(request, env);
    if (path === "/api/auth/reset" && post) return reset(request, env);
    if (path === "/api/auth/invite") return inviteInfo(request, env, url);
    if ((path === "/logout" || path === "/api/auth/logout") && post) return new Response(null, { status: 204, headers: { "Set-Cookie": clearCookie() } });
    if (path === "/signup" || path === "/reset") return authPage(200);
    if (PUBLIC_FILES.has(path) && request.method === "GET") return env.ASSETS.fetch(request);

    // ----- 需要登入 -----
    const isApi = path.startsWith("/api/");
    const auth = await authenticate(request, env, isApi);
    if (!auth) return isApi ? json({ error: "unauthorized" }, 401) : authPage(401);
    const uid = auth.uid;

    if (isApi) {
      if (path === "/api/me") return json({ id: uid, username: auth.user?.username ?? null, is_admin: auth.user?.is_admin ? 1 : 0 });
      if (path === "/api/auth/password" && post) return changePassword(request, env, auth);
      if (path === "/api/static") return post ? saveStatic(request, env, uid) : staticData(env, uid);
      if (path === "/api/push" && post) return push(request, env, uid);
      const m = path.match(/^\/api\/pull\/(notes|cards|revlog|dict)$/);
      if (m) return pull(m[1], url, env, uid);
      if (path === "/api/library") return listLibrary(env, uid);
      if (path === "/api/library/join" && post) return joinLibrary(request, env, uid);

      if (path.startsWith("/api/admin/")) {
        if (!auth.user?.is_admin) return json({ error: "forbidden" }, 403);
        if (path === "/api/admin/invites" && post) return createInvite(request, env, auth);
        if (path === "/api/admin/users") return listUsers(env);
        const d = path.match(/^\/api\/admin\/users\/(\d+)\/disabled$/);
        if (d && post) return setDisabled(request, env, auth, Number(d[1]));
      }
      return json({ error: "not found" }, 404);
    }

    if (path.startsWith("/media/")) return media(request, env);
    return env.ASSETS.fetch(request);
}
