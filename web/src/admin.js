// 管理（只有 is_admin 的帳號可用）與「牌組庫」（所有人都可以加入）。
import { json, now, randomCode, normCode, readJson, sha256Hex } from "./util.js";

const HOUR = 3600 * 1000;

// ---------- 免費額度保護 ----------
// D1 免費方案每天只能寫入約 10 萬列（UTC 午夜，台灣時間早上 8 點重置），而且「索引」也算寫入：
// 加入牌組時每個單字會寫 notes 和 cards 兩列，各自連同主鍵與 mod 索引，約 6 次寫入。
// 全站加入牌組一天最多用掉 JOIN_BUDGET 次寫入，剩下的留給大家平常的複習與同步；
// 當天第一次加入不受限（讓一個人可以一口氣加入整個牌組庫）。
export const WRITES_PER_WORD = 6;
export const JOIN_BUDGET = 50000;
const budgetKey = () => `joinwrites:${new Date().toISOString().slice(0, 10)}`;

async function joinWritesToday(env) {
  const row = await env.DB.prepare("SELECT v FROM user_meta WHERE uid = -1 AND k = ?1").bind(budgetKey()).first();
  return Number(row?.v ?? 0);
}

// ---------- 邀請與重設連結 ----------
export async function createInvite(request, env, auth) {
  const body = await readJson(request);
  const kind = body?.kind;
  if (kind !== "signup" && kind !== "reset") return json({ error: "kind 必須是 signup 或 reset" }, 400);
  let uid = null;
  if (kind === "reset") {
    uid = Number(body.uid);
    const u = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?1 AND id > 0").bind(uid).first();
    if (!u || !u.username) return json({ error: "找不到這位使用者" }, 404);
  }
  const hours = Math.min(Math.max(Number(body.hours) || (kind === "signup" ? 7 * 24 : 24), 1), 30 * 24);
  const code = randomCode();
  const t = now();
  await env.DB.prepare("INSERT INTO invites (code_hash, kind, uid, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(await sha256Hex(normCode(code)), kind, uid, auth.uid, t, t + hours * HOUR).run();
  return json({ code, kind, expires_at: t + hours * HOUR });
}

export async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.is_admin, u.disabled, u.created_at, u.last_login,
       (SELECT COUNT(*) FROM cards c WHERE c.uid = u.id AND c.deleted = 0) AS cards,
       (SELECT COUNT(*) FROM revlog r WHERE r.uid = u.id) AS reviews
     FROM users u WHERE u.id > 0 AND u.username IS NOT NULL ORDER BY u.id`
  ).all();
  return json({ users: results });
}

export async function setDisabled(request, env, auth, id) {
  const body = await readJson(request);
  if (id === auth.uid) return json({ error: "不能停用自己" }, 400);
  const res = await env.DB.prepare("UPDATE users SET disabled = ?1, sess_ver = sess_ver + 1 WHERE id = ?2 AND id > 0").bind(body?.disabled ? 1 : 0, id).run();
  return res.meta.changes ? json({ ok: true }) : json({ error: "找不到這位使用者" }, 404);
}

// ---------- 牌組庫 ----------
// 牌組庫清單：每個牌組一列（子牌組也各自一列，可以單獨加入）。cards 是這個牌組含子牌組的卡片總數，
// have 是你已經有的卡片數（含你刪掉的，那些不會再被補回來）；have >= cards 就是「已加入」，介於中間是「部分」。
export async function listLibrary(env, uid) {
  const [lib, libCards, mine] = await env.DB.batch([
    env.DB.prepare("SELECT id, name FROM decks WHERE uid = 0 ORDER BY name"),
    env.DB.prepare("SELECT did, COUNT(*) AS n FROM cards WHERE uid = 0 AND deleted = 0 GROUP BY did"),
    env.DB.prepare("SELECT did, COUNT(*) AS n FROM cards WHERE uid = ?1 GROUP BY did").bind(uid),
  ]);
  const libN = new Map(libCards.results.map((r) => [r.did, r.n]));
  const myN = new Map(mine.results.map((r) => [r.did, r.n]));
  const inTree = (d, root) => d.name === root.name || d.name.startsWith(`${root.name}::`);
  const used = await joinWritesToday(env);
  const decks = lib.results.map((root) => {
    const tree = lib.results.filter((d) => inTree(d, root));
    const cards = tree.reduce((s, d) => s + (libN.get(d.id) ?? 0), 0);
    const have = tree.reduce((s, d) => s + Math.min(myN.get(d.id) ?? 0, libN.get(d.id) ?? 0), 0);
    return { id: root.id, name: root.name, depth: root.name.split("::").length - 1, cards, have, state: have >= cards ? "joined" : have > 0 ? "partial" : "none" };
  });
  // 依樹狀順序排：子牌組緊接在上層牌組後面（單純照名稱排的話 "-P" 會夾進 "::L1" 前面）
  const path = (d) => d.name.split("::");
  decks.sort((a, b) => {
    const [x, y] = [path(a), path(b)];
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length - y.length;
  });
  return json({ decks, budget: { used, limit: JOIN_BUDGET, perWord: WRITES_PER_WORD } });
}

// 把牌組庫裡的牌組複製給這個人：卡片進度全新；已經有的資料列不會被覆蓋（OR IGNORE），重複加入也安全。
export async function joinLibrary(request, env, uid) {
  const body = await readJson(request);
  const did = Number(body?.deck);
  const root = await env.DB.prepare("SELECT id, name FROM decks WHERE uid = 0 AND id = ?1").bind(did).first();
  if (!root) return json({ error: "牌組庫裡沒有這個牌組" }, 404);
  const t = now();
  // 要複製的牌組：自己、底下的子牌組（連同卡片），以及上層牌組（只放空的架子，樹狀才完整）
  const withCards = "SELECT id FROM decks WHERE uid = 0 AND (name = ?2 OR substr(name, 1, length(?2) + 2) = ?2 || '::')";
  const withParents = `SELECT id FROM decks WHERE uid = 0 AND (name = ?2 OR substr(name, 1, length(?2) + 2) = ?2 || '::' OR substr(?2, 1, length(name) + 2) = name || '::')`;
  // 還沒有的單字才會寫入，重複加入不花額度
  const fresh = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards WHERE uid = 0 AND deleted = 0 AND did IN (${withCards}) AND id NOT IN (SELECT id FROM cards WHERE uid = ?1)`).bind(uid, root.name).first()).n;
  const cost = fresh * WRITES_PER_WORD;
  const used = await joinWritesToday(env);
  if (cost > 0 && used > 0 && used + cost > JOIN_BUDGET) {
    return json({ error: `今天全站加入牌組的免費額度用完了（資料庫每天有寫入上限，台灣時間早上 8 點重置）。請明天早上 8 點後再加入「${root.name}」。`, busy: true }, 429);
  }
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO configs (uid, id, data) SELECT ?1, id, data FROM configs WHERE uid = 0").bind(uid),
    env.DB.prepare("INSERT OR IGNORE INTO notetypes (uid, id, name, fields, qfmt, afmt, css, kind, tmpls) SELECT ?1, id, name, fields, qfmt, afmt, css, kind, tmpls FROM notetypes WHERE uid = 0").bind(uid),
    env.DB.prepare(`INSERT OR IGNORE INTO decks (uid, id, name, config) SELECT ?1, id, name, config FROM decks WHERE uid = 0 AND id IN (${withParents})`).bind(uid, root.name),
    env.DB.prepare(`INSERT OR IGNORE INTO notes (uid, id, guid, mid, mod, tags, fields, deleted) SELECT ?1, id, guid, mid, ?3, tags, fields, 0 FROM notes WHERE uid = 0 AND deleted = 0 AND id IN (SELECT nid FROM cards WHERE uid = 0 AND deleted = 0 AND did IN (${withCards}))`).bind(uid, root.name, t),
    env.DB.prepare(
      `INSERT OR IGNORE INTO cards (uid, id, nid, did, ord, type, queue, ivl, reps, lapses, left, mod, s, d, lrt, pos, due_ts, due_day, deleted, flags, bury_day)
       SELECT ?1, id, nid, did, ord, 0, 0, 0, 0, 0, 0, ?3, NULL, NULL, NULL, pos, NULL, NULL, 0, 0, NULL FROM cards WHERE uid = 0 AND deleted = 0 AND did IN (${withCards})`
    ).bind(uid, root.name, t),
    env.DB.prepare("UPDATE users SET static_mod = MAX(?2, static_mod + 1) WHERE id = ?1").bind(uid, t),
    env.DB.prepare("INSERT INTO user_meta (uid, k, v) VALUES (-1, ?1, ?2) ON CONFLICT(uid, k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + ?3 AS TEXT)").bind(budgetKey(), String(cost), cost),
  ]);
  return json({ ok: true });
}
