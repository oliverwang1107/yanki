// Worker 負責：登入與帳號、靜態檔、對 D1 存取「每個人自己的」資料。所有排程運算都在瀏覽器的 WASM 裡。
// 免費方案每個請求 CPU 只有約 10ms，所以密碼的重運算（PBKDF2）放在瀏覽器，這裡只做雜湊比對。
import { COOKIE, authenticate, changePassword, clearCookie, inviteInfo, login, reset, signup } from "./auth.js";
import { createInvite, joinLibrary, listLibrary, listUsers, setDisabled } from "./admin.js";
import { pull, push, saveStatic, staticData } from "./data.js";
import { authPage } from "./pages.js";
import { json } from "./util.js";

// 這幾個檔案不含任何祕密，登入頁和「加到主畫面」需要在登入前取得。
const PUBLIC_FILES = new Set(["/js/pw.js", "/icon.svg", "/manifest.webmanifest"]);

// 音檔與圖片放在 R2（MEDIA 綁定），不放在靜態資源裡，這樣 git 上不用存 111MB 的檔案。
// iOS Safari 播放音檔一定要 Range / 206，R2 本身支援，這裡只負責把標頭轉成 Response。
const MEDIA_TYPES = { mp3: "audio/mpeg", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
async function media(request, env, path) {
  let key;
  try {
    key = decodeURIComponent(path.slice("/media/".length));
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!key || (request.method !== "GET" && request.method !== "HEAD")) return new Response("not found", { status: 404 });
  const ranged = request.headers.has("Range");
  let obj;
  try {
    obj = await env.MEDIA.get(key, ranged ? { range: request.headers } : {});
  } catch {
    return new Response(null, { status: 416 }); // 範圍標頭格式錯誤或超出檔案大小
  }
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.get("Content-Type")) headers.set("Content-Type", MEDIA_TYPES[key.split(".").pop().toLowerCase()] ?? "application/octet-stream");
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=86400");
  let status = 200;
  let length = obj.size;
  const start = /^bytes=(\d+)-/.exec(request.headers.get("Range") ?? "")?.[1];
  if (start !== undefined && Number(start) >= obj.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${obj.size}` } });
  if (ranged && obj.range) {
    const r = obj.range;
    const offset = "suffix" in r ? Math.max(0, obj.size - r.suffix) : r.offset ?? 0;
    if (offset >= obj.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${obj.size}` } });
    length = Math.min("suffix" in r ? r.suffix : r.length ?? obj.size - offset, obj.size - offset);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    status = 206;
  }
  headers.set("Content-Length", String(length));
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
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

    if (path.startsWith("/media/")) return media(request, env, path);
    return env.ASSETS.fetch(request);
}
