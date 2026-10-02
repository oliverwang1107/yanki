// 帳號：登入、註冊（邀請制）、重設密碼、改密碼、登入失敗限制。
//
// 密碼在使用者的瀏覽器裡先用 PBKDF2 做 20 萬次運算，伺服器只收到運算後的結果（key），
// 資料庫存的是 key 的 SHA-256。免費方案每個請求 CPU 只有約 10ms，沒辦法在 Worker 裡做 PBKDF2，
// 這樣做也讓密碼明碼從不離開使用者的裝置。
import { b64url, cookie, json, normCode, now, readJson, sameSecret, sha256Hex, enc } from "./util.js";

export const COOKIE = "anki_session";
const SESSION_DAYS = 180;
const WINDOW_MS = 15 * 60 * 1000;
const LIMIT_USER = 10;
const LIMIT_IP = 40;
const KEY_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[A-Za-z0-9_.一-鿿-]{3,20}$/;
const RESERVED = new Set(["library", "admin", "root", "owner", "system"]);

// ---------- 登入狀態（簽章過的 cookie，不需要查資料庫就能驗證） ----------
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg))));
}

async function sessionCookie(env, request, uid, ver) {
  const exp = Math.floor(now() / 1000) + SESSION_DAYS * 86400;
  const body = `${uid}.${ver}.${exp}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${body}.${await hmac(env.SESSION_SECRET, body)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

async function readSession(env, request) {
  if (!env.SESSION_SECRET) return null; // 沒設定祕密值就一律不放行
  const p = cookie(request, COOKIE).split(".");
  if (p.length !== 4) return null;
  const [uid, ver, exp, sig] = p;
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(ver) || !/^\d+$/.test(exp) || Number(exp) < now() / 1000) return null;
  if (!(await sameSecret(sig, await hmac(env.SESSION_SECRET, `${uid}.${ver}.${exp}`)))) return null;
  return { uid: Number(uid), ver: Number(ver) };
}

// 回傳 { uid, user } 或 null。
//  - Authorization: Bearer <AUTH_TOKEN>：給本機的工具程式（匯入器等）用，等同擁有者。
//  - 登入 cookie：一般使用者。API 請求會再查資料庫，確認帳號沒被停用、密碼沒被重設過。
export async function authenticate(request, env, checkDb) {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  if (bearer && env.AUTH_TOKEN && (await sameSecret(bearer[1], env.AUTH_TOKEN))) {
    const user = await env.DB.prepare("SELECT id, username, is_admin FROM users WHERE id = 1").first();
    return user ? { uid: 1, user: { ...user, is_admin: 1 } } : null;
  }
  const s = await readSession(env, request);
  if (!s || s.uid < 1) return null;
  if (!checkDb) return { uid: s.uid, user: null };
  const user = await env.DB.prepare("SELECT id, username, is_admin, disabled, sess_ver FROM users WHERE id = ?1").bind(s.uid).first();
  if (!user || user.disabled || user.sess_ver !== s.ver) return null;
  return { uid: user.id, user };
}

// ---------- 防暴力破解 ----------
async function blocked(env, checks) {
  for (const [key, limit] of checks) {
    const row = await env.DB.prepare("SELECT n, t FROM auth_fail WHERE k = ?1").bind(key).first();
    if (row && now() - row.t < WINDOW_MS && row.n >= limit) return true;
  }
  return false;
}

// 附帶的寫入（失敗次數、最近登入時間）失敗時不能讓登入本身跟著失敗：
// 例如免費方案的每日寫入額度用完時，讀取仍然可以，使用者應該還是能登入看資料。
const bestEffort = async (fn) => {
  try {
    await fn();
  } catch (e) {
    console.error("auth side-write failed:", e?.message ?? e);
  }
};

async function recordFail(env, keys) {
  const t = now();
  await env.DB.batch(keys.map((k) =>
    env.DB.prepare(
      `INSERT INTO auth_fail (k, n, t) VALUES (?1, 1, ?2)
       ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ?2 - t > ?3 THEN 1 ELSE n + 1 END, t = CASE WHEN ?2 - t > ?3 THEN ?2 ELSE t END`
    ).bind(k, t, WINDOW_MS)
  ));
}

const clearFail = (env, key) => env.DB.prepare("DELETE FROM auth_fail WHERE k = ?1").bind(key).run();
const ipOf = (request) => request.headers.get("CF-Connecting-IP") || "local";
const tooMany = () => json({ error: "嘗試次數太多，請 15 分鐘後再試" }, 429);

// ---------- 邀請 ----------
async function findInvite(env, code, kinds) {
  const norm = normCode(code);
  if (norm.length < 20) return null;
  const hash = await sha256Hex(norm);
  const marks = kinds.map((_, i) => `?${i + 3}`).join(",");
  const row = await env.DB.prepare(`SELECT code_hash, kind, uid FROM invites WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND kind IN (${marks})`)
    .bind(hash, now(), ...kinds).first();
  return row ? { ...row, hash } : null;
}

// 一次性使用：用 UPDATE 搶佔，同時有兩個人用同一個連結時只有一個會成功。
async function takeInvite(env, invite) {
  const res = await env.DB.prepare("UPDATE invites SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL").bind(now(), invite.hash).run();
  return res.meta.changes === 1;
}

const releaseInvite = (env, invite) => env.DB.prepare("UPDATE invites SET used_at = NULL, used_by = NULL WHERE code_hash = ?1").bind(invite.hash).run();

// ---------- 端點 ----------
export async function login(request, env) {
  const body = await readJson(request);
  const name = String(body?.username ?? "").trim().toLowerCase();
  const key = String(body?.key ?? "");
  if (!name || name.length > 40 || !KEY_RE.test(key)) return json({ error: "請輸入帳號和密碼" }, 400);
  const ip = `ip:${ipOf(request)}`;
  const uk = `u:${name}`;
  if (await blocked(env, [[uk, LIMIT_USER], [ip, LIMIT_IP]])) return tooMany();

  const u = await env.DB.prepare("SELECT id, pw_hash, disabled, sess_ver FROM users WHERE username = ?1 AND id > 0").bind(name).first();
  // 帳號不存在時也做一次比對，讓回應時間不洩漏帳號是否存在
  const ok = await sameSecret(await sha256Hex(key), u?.pw_hash ?? "x");
  if (!u || !u.pw_hash || u.disabled || !ok) {
    await bestEffort(() => recordFail(env, [uk, ip]));
    return json({ error: "帳號或密碼不對" }, 401);
  }
  await bestEffort(() => clearFail(env, uk));
  await bestEffort(() => env.DB.prepare("UPDATE users SET last_login = ?1 WHERE id = ?2").bind(now(), u.id).run());
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, request, u.id, u.sess_ver) });
}

// 預覽邀請內容（註冊頁用來決定要顯示什麼）。
export async function inviteInfo(request, env, url) {
  const ip = `ip:${ipOf(request)}`;
  if (await blocked(env, [[ip, LIMIT_IP]])) return tooMany();
  const inv = await findInvite(env, url.searchParams.get("code"), ["signup", "reset", "claim"]);
  if (!inv) {
    await recordFail(env, [ip]);
    return json({ error: "這個連結無效或已過期" }, 404);
  }
  const target = inv.uid != null ? await env.DB.prepare("SELECT username FROM users WHERE id = ?1").bind(inv.uid).first() : null;
  return json({ kind: inv.kind, username: target?.username ?? null });
}

export async function signup(request, env) {
  const body = await readJson(request);
  const name = String(body?.username ?? "").trim();
  const key = String(body?.key ?? "");
  if (!NAME_RE.test(name) || RESERVED.has(name.toLowerCase())) return json({ error: "帳號要 3–20 個字，可用中英文、數字、底線、句點和連字號" }, 400);
  if (!KEY_RE.test(key)) return json({ error: "密碼格式不對，請重新整理頁面再試" }, 400);
  const ip = `ip:${ipOf(request)}`;
  if (await blocked(env, [[ip, LIMIT_IP]])) return tooMany();

  const inv = await findInvite(env, body?.code, ["signup", "claim"]);
  if (!inv || !(await takeInvite(env, inv))) {
    await recordFail(env, [ip]);
    return json({ error: "邀請連結無效或已經被用過了" }, 400);
  }
  const pw = await sha256Hex(key);
  try {
    let uid;
    if (inv.kind === "claim") {
      // 認領既有帳號：只允許還沒設定過帳號密碼的那一個
      const res = await env.DB.prepare("UPDATE users SET username = ?1, pw_hash = ?2, last_login = ?4 WHERE id = ?3 AND username IS NULL").bind(name, pw, inv.uid, now()).run();
      if (res.meta.changes !== 1) throw new Error("claimed");
      uid = inv.uid;
    } else {
      const t = now();
      const res = await env.DB.prepare("INSERT INTO users (username, pw_hash, is_admin, static_mod, created_at, last_login) VALUES (?1, ?2, 0, ?3, ?3, ?3)").bind(name, pw, t).run();
      uid = res.meta.last_row_id;
      // 起始資料：預設的牌組設定和筆記類型（從牌組庫複製）
      await env.DB.batch([
        env.DB.prepare("INSERT INTO configs (uid, id, data) SELECT ?1, id, data FROM configs WHERE uid = 0").bind(uid),
        env.DB.prepare("INSERT INTO notetypes (uid, id, name, fields, qfmt, afmt, css) SELECT ?1, id, name, fields, qfmt, afmt, css FROM notetypes WHERE uid = 0").bind(uid),
      ]);
    }
    await env.DB.prepare("UPDATE invites SET used_by = ?1 WHERE code_hash = ?2").bind(uid, inv.hash).run();
    const ver = (await env.DB.prepare("SELECT sess_ver FROM users WHERE id = ?1").bind(uid).first()).sess_ver;
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, request, uid, ver) });
  } catch (e) {
    await releaseInvite(env, inv);
    console.error("signup failed:", e?.message ?? e);
    const taken = /UNIQUE|constraint/i.test(String(e.message)) || e.message === "claimed";
    return json({ error: taken ? "這個帳號名稱已經有人用了" : "註冊失敗，請稍後再試" }, taken ? 409 : 500);
  }
}

export async function reset(request, env) {
  const body = await readJson(request);
  const key = String(body?.key ?? "");
  if (!KEY_RE.test(key)) return json({ error: "密碼格式不對，請重新整理頁面再試" }, 400);
  const ip = `ip:${ipOf(request)}`;
  if (await blocked(env, [[ip, LIMIT_IP]])) return tooMany();
  const inv = await findInvite(env, body?.code, ["reset"]);
  if (!inv || !(await takeInvite(env, inv))) {
    await recordFail(env, [ip]);
    return json({ error: "重設連結無效或已經用過了" }, 400);
  }
  await env.DB.prepare("UPDATE users SET pw_hash = ?1, sess_ver = sess_ver + 1 WHERE id = ?2").bind(await sha256Hex(key), inv.uid).run();
  const u = await env.DB.prepare("SELECT username, sess_ver FROM users WHERE id = ?1").bind(inv.uid).first();
  await env.DB.prepare("DELETE FROM auth_fail WHERE k = ?1").bind(`u:${String(u.username).toLowerCase()}`).run();
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, request, inv.uid, u.sess_ver) });
}

export async function changePassword(request, env, auth) {
  const body = await readJson(request);
  const oldKey = String(body?.oldKey ?? "");
  const newKey = String(body?.newKey ?? "");
  if (!KEY_RE.test(oldKey) || !KEY_RE.test(newKey)) return json({ error: "格式不對" }, 400);
  const u = await env.DB.prepare("SELECT id, pw_hash, username FROM users WHERE id = ?1").bind(auth.uid).first();
  const uk = `u:${String(u.username).toLowerCase()}`;
  if (await blocked(env, [[uk, LIMIT_USER]])) return tooMany();
  if (!u.pw_hash || !(await sameSecret(await sha256Hex(oldKey), u.pw_hash))) {
    await recordFail(env, [uk]);
    return json({ error: "目前的密碼不對" }, 401);
  }
  await env.DB.prepare("UPDATE users SET pw_hash = ?1, sess_ver = sess_ver + 1 WHERE id = ?2").bind(await sha256Hex(newKey), u.id).run();
  const ver = (await env.DB.prepare("SELECT sess_ver FROM users WHERE id = ?1").bind(u.id).first()).sess_ver;
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, request, u.id, ver) });
}
