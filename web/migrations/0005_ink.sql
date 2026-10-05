-- 0005：卡片上的手寫標記（Apple Pencil 畫的螢光筆、圈選）。每人每張卡一列，id 就是卡片 id；
-- data 是 JSON 字串（筆畫座標），由用戶端產生，伺服器只限制大小。
CREATE TABLE IF NOT EXISTS ink (
  uid INTEGER NOT NULL,
  id INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS ink_mod ON ink (uid, mod, id);
