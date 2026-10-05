// 資料同步：每個請求都只碰得到「自己的」資料列（uid 由登入狀態決定，不信任用戶端送來的任何 uid）。
// 免費方案每個請求 CPU 只有約 10ms、D1 查詢數上限 50，所以：讀取分頁、寫入用 json_each 一條語句寫完一批。
import { json, now } from "./util.js";

const PAGE = 1000;
const MAX_BATCH = 500;
const MAX_INK = 60000; // 一張卡的手寫標記上限（字元數）

export async function staticData(env, uid) {
  const [meta, notetypes, decks, configs, user] = await env.DB.batch([
    env.DB.prepare("SELECT k, v FROM user_meta WHERE uid = ?1").bind(uid),
    env.DB.prepare("SELECT id, name, fields, qfmt, afmt, css, kind, tmpls FROM notetypes WHERE uid = ?1").bind(uid),
    env.DB.prepare("SELECT id, name, config FROM decks WHERE uid = ?1").bind(uid),
    env.DB.prepare("SELECT id, data FROM configs WHERE uid = ?1").bind(uid),
    env.DB.prepare("SELECT static_mod FROM users WHERE id = ?1").bind(uid),
  ]);
  const rows = [...meta.results, { k: "static_mod", v: String(user.results[0]?.static_mod ?? 0) }];
  return json({ meta: rows, notetypes: notetypes.results, decks: decks.results, configs: configs.results });
}

// 以 (mod, id) 為游標分頁，用戶端記住最後一列就能只拉增量。
const PULL = {
  notes: "SELECT id, guid, mid, mod, tags, fields, deleted FROM notes WHERE uid = ?3 AND (mod > ?1 OR (mod = ?1 AND id > ?2)) ORDER BY mod, id LIMIT ?4",
  cards: "SELECT id, nid, did, ord, type, queue, ivl, reps, lapses, left, mod, s, d, lrt, pos, due_ts, due_day, flags, bury_day, deleted FROM cards WHERE uid = ?3 AND (mod > ?1 OR (mod = ?1 AND id > ?2)) ORDER BY mod, id LIMIT ?4",
  // 字典是大家共用的，但只送給「自己有這張筆記」的人
  ink: "SELECT id, mod, data, deleted FROM ink WHERE uid = ?3 AND (mod > ?1 OR (mod = ?1 AND id > ?2)) ORDER BY mod, id LIMIT ?4",
  dict: "SELECT id, mod, data FROM dict WHERE (mod > ?1 OR (mod = ?1 AND id > ?2)) AND id IN (SELECT id FROM notes WHERE uid = ?3) ORDER BY mod, id LIMIT ?4",
};

export async function pull(table, url, env, uid) {
  const mod = Number(url.searchParams.get("mod") || 0);
  const id = Number(url.searchParams.get("id") || 0);
  if (table === "revlog") {
    // 複習紀錄只增不改，游標只要 id（毫秒時間戳）。
    const { results } = await env.DB.prepare(
      "SELECT id, cid, ease, ivl, last_ivl, time, type FROM revlog WHERE uid = ?1 AND id > ?2 ORDER BY id LIMIT ?3"
    ).bind(uid, id, PAGE + 1).all();
    return json({ rows: results.slice(0, PAGE), more: results.length > PAGE });
  }
  const { results } = await env.DB.prepare(PULL[table]).bind(mod, id, uid, PAGE + 1).all();
  return json({ rows: results.slice(0, PAGE), more: results.length > PAGE });
}

// 缺少的欄位用預設值：flags、deleted 是後來才加的，瀏覽器裡的舊資料列可能沒有。
const DEFAULT0 = new Set(["flags", "deleted"]);
const J = (path) => (DEFAULT0.has(path) ? `COALESCE(json_extract(value, '$.${path}'), 0)` : `json_extract(value, '$.${path}')`);
const CARD_COLS = ["id", "nid", "did", "ord", "type", "queue", "ivl", "reps", "lapses", "left", "mod", "s", "d", "lrt", "pos", "due_ts", "due_day", "flags", "bury_day", "deleted"];
const UPSERT = {
  cards: `INSERT INTO cards (uid, ${CARD_COLS.join(", ")})
    SELECT ?2, ${CARD_COLS.map(J).join(", ")}
    FROM json_each(?1) WHERE true
    ON CONFLICT(uid, id) DO UPDATE SET nid = excluded.nid, did = excluded.did, ord = excluded.ord, type = excluded.type, queue = excluded.queue,
      ivl = excluded.ivl, reps = excluded.reps, lapses = excluded.lapses, left = excluded.left, mod = excluded.mod,
      s = excluded.s, d = excluded.d, lrt = excluded.lrt, pos = excluded.pos, due_ts = excluded.due_ts, due_day = excluded.due_day,
      flags = excluded.flags, bury_day = excluded.bury_day, deleted = excluded.deleted
    WHERE excluded.mod > cards.mod`,
  notes: `INSERT INTO notes (uid, id, guid, mid, mod, tags, fields, deleted)
    SELECT ?2, ${["id", "guid", "mid", "mod", "tags", "fields", "deleted"].map(J).join(", ")}
    FROM json_each(?1) WHERE true
    ON CONFLICT(uid, id) DO UPDATE SET mid = excluded.mid, mod = excluded.mod, tags = excluded.tags, fields = excluded.fields, deleted = excluded.deleted
    WHERE excluded.mod > notes.mod`,
  ink: `INSERT INTO ink (uid, id, mod, data, deleted)
    SELECT ?2, ${["id", "mod", "data", "deleted"].map(J).join(", ")}
    FROM json_each(?1) WHERE true
    ON CONFLICT(uid, id) DO UPDATE SET mod = excluded.mod, data = excluded.data, deleted = excluded.deleted
    WHERE excluded.mod > ink.mod`,
  revlog: `INSERT OR IGNORE INTO revlog (uid, id, cid, ease, ivl, last_ivl, time, type)
    SELECT ?2, ${["id", "cid", "ease", "ivl", "last_ivl", "time", "type"].map(J).join(", ")} FROM json_each(?1)`,
};

export async function push(request, env, uid) {
  const body = await request.json();
  const stmts = [];
  for (const table of Object.keys(UPSERT)) {
    const rows = body[table] ?? [];
    if (!Array.isArray(rows) || rows.length > MAX_BATCH) return json({ error: `${table}: 一次最多 ${MAX_BATCH} 筆` }, 400);
    if (table === "ink" && rows.some((r) => typeof r?.data !== "string" || r.data.length > MAX_INK)) return json({ error: "ink: 筆跡資料太大" }, 400);
    if (rows.length) stmts.push(env.DB.prepare(UPSERT[table]).bind(JSON.stringify(rows), uid));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

// 牌組、牌組設定、筆記類型：數量很少，所以整份一次替換（只替換自己的）。
// base 是用戶端這份資料所依據的 static_mod；伺服器上已經更新的話回 409，讓用戶端先重新同步。
const STATIC_REPLACE = {
  decks: ["DELETE FROM decks WHERE uid = ?1", `INSERT INTO decks (uid, id, name, config) SELECT ?1, ${["id", "name", "config"].map(J).join(", ")} FROM json_each(?2)`],
  configs: ["DELETE FROM configs WHERE uid = ?1", "INSERT INTO configs (uid, id, data) SELECT ?1, json_extract(value, '$.id'), value FROM json_each(?2)"],
  notetypes: ["DELETE FROM notetypes WHERE uid = ?1", `INSERT INTO notetypes (uid, id, name, fields, qfmt, afmt, css, kind, tmpls) SELECT ?1, ${["id", "name", "fields", "qfmt", "afmt", "css"].map(J).join(", ")}, COALESCE(json_extract(value, '$.kind'), 'standard'), json_extract(value, '$.tmpls') FROM json_each(?2)`],
};

export async function saveStatic(request, env, uid) {
  const body = await request.json();
  const row = await env.DB.prepare("SELECT static_mod FROM users WHERE id = ?1").bind(uid).first();
  const current = row ? Number(row.static_mod) : 0;
  if (current > Number(body.base ?? 0)) return json({ error: "conflict", static_mod: current }, 409);
  const stmts = [];
  for (const [table, [del, ins]] of Object.entries(STATIC_REPLACE)) {
    const rows = body[table];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) return json({ error: `${table}: 數量不合理` }, 400);
    stmts.push(env.DB.prepare(del).bind(uid), env.DB.prepare(ins).bind(uid, JSON.stringify(rows)));
  }
  if (!stmts.length) return json({ error: "沒有要儲存的資料" }, 400);
  const mod = Math.max(now(), current + 1);
  stmts.push(env.DB.prepare("UPDATE users SET static_mod = ?1 WHERE id = ?2").bind(mod, uid));
  await env.DB.batch(stmts);
  return json({ ok: true, static_mod: mod });
}
