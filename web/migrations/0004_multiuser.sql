-- 0004：多使用者。每個人的資料用 uid 區分：
--   uid = 1  原本的擁有者（現有的所有資料都歸他）
--   uid = 0  「牌組庫」，新同學加入牌組時從這裡複製（內容由 tools/seed_library.mjs 產生，進度全新）
-- 資料表需要把主鍵改成 (uid, id)，所以用「建新表 → 複製 → 換名」重建；字典 dict 與音檔是大家共用的，不動。
-- 套用前請先備份：node node_modules/wrangler/bin/wrangler.js d1 export anki-web --remote --output=data/backup.sql

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE,
  pw_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  sess_ver INTEGER NOT NULL DEFAULT 0,
  static_mod INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
INSERT INTO users (id, username, pw_hash, is_admin, disabled, static_mod, created_at) VALUES (0, NULL, NULL, 0, 1, 0, 0);
INSERT INTO users (id, username, pw_hash, is_admin, disabled, static_mod, created_at)
  VALUES (1, NULL, NULL, 1, 0, COALESCE((SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'static_mod'), 0), CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 邀請與重設連結：只存雜湊，連結本身只在產生時顯示一次。
CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- signup：新同學註冊；reset：重設某人的密碼；claim：認領既有帳號（只用在第一次）
  uid INTEGER,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER
);
-- 登入失敗次數（防暴力破解）：k 是 u:<帳號> 或 ip:<位址>，t 是目前這個時間窗的起點。
CREATE TABLE auth_fail (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL);

-- 每人一份的設定值（原本整個網站共用的 meta 拆開；meta 之後只留 schema_version）。
CREATE TABLE user_meta (uid INTEGER NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (uid, k));
INSERT INTO user_meta (uid, k, v) SELECT 1, k, v FROM meta WHERE k NOT IN ('schema_version', 'static_mod');
DELETE FROM meta WHERE k NOT IN ('schema_version');

CREATE TABLE notetypes_new (uid INTEGER NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL, fields TEXT NOT NULL, qfmt TEXT NOT NULL, afmt TEXT NOT NULL, css TEXT NOT NULL, PRIMARY KEY (uid, id));
INSERT INTO notetypes_new (uid, id, name, fields, qfmt, afmt, css) SELECT 1, id, name, fields, qfmt, afmt, css FROM notetypes;
DROP TABLE notetypes;
ALTER TABLE notetypes_new RENAME TO notetypes;

CREATE TABLE decks_new (uid INTEGER NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL, config INTEGER NOT NULL, PRIMARY KEY (uid, id));
INSERT INTO decks_new (uid, id, name, config) SELECT 1, id, name, config FROM decks;
DROP TABLE decks;
ALTER TABLE decks_new RENAME TO decks;

CREATE TABLE configs_new (uid INTEGER NOT NULL, id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (uid, id));
INSERT INTO configs_new (uid, id, data) SELECT 1, id, data FROM configs;
DROP TABLE configs;
ALTER TABLE configs_new RENAME TO configs;

CREATE TABLE notes_new (
  uid INTEGER NOT NULL, id INTEGER NOT NULL, guid TEXT NOT NULL, mid INTEGER NOT NULL, mod INTEGER NOT NULL,
  tags TEXT NOT NULL, fields TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, id)
);
INSERT INTO notes_new (uid, id, guid, mid, mod, tags, fields, deleted) SELECT 1, id, guid, mid, mod, tags, fields, deleted FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;
CREATE INDEX notes_mod ON notes (uid, mod, id);

CREATE TABLE cards_new (
  uid INTEGER NOT NULL, id INTEGER NOT NULL, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL,
  type INTEGER NOT NULL, queue INTEGER NOT NULL, ivl INTEGER NOT NULL, reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL, left INTEGER NOT NULL DEFAULT 0, mod INTEGER NOT NULL, s REAL, d REAL, lrt INTEGER,
  pos INTEGER, due_ts INTEGER, due_day INTEGER, deleted INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, bury_day INTEGER,
  PRIMARY KEY (uid, id)
);
INSERT INTO cards_new (uid, id, nid, did, ord, type, queue, ivl, reps, lapses, left, mod, s, d, lrt, pos, due_ts, due_day, deleted, flags, bury_day)
  SELECT 1, id, nid, did, ord, type, queue, ivl, reps, lapses, left, mod, s, d, lrt, pos, due_ts, due_day, deleted, flags, bury_day FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX cards_mod ON cards (uid, mod, id);

CREATE TABLE revlog_new (uid INTEGER NOT NULL, id INTEGER NOT NULL, cid INTEGER NOT NULL, ease INTEGER NOT NULL, ivl INTEGER NOT NULL, last_ivl INTEGER NOT NULL, time INTEGER NOT NULL, type INTEGER NOT NULL, PRIMARY KEY (uid, id));
INSERT INTO revlog_new (uid, id, cid, ease, ivl, last_ivl, time, type) SELECT 1, id, cid, ease, ivl, last_ivl, time, type FROM revlog;
DROP TABLE revlog;
ALTER TABLE revlog_new RENAME TO revlog;
CREATE INDEX revlog_cid ON revlog (uid, cid);
