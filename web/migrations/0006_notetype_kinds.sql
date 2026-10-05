-- 0006：筆記類型支援多個版型（正反向卡片）、填空題、圖片遮蓋。
--   kind  'standard'（預設）｜'cloze'｜'occlusion'
--   tmpls 版型清單的 JSON：[{"name":"卡片 1","qfmt":"…","afmt":"…"}, …]；空值代表只有 qfmt／afmt 這一個版型（舊資料）
ALTER TABLE notetypes ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE notetypes ADD COLUMN tmpls TEXT;
