-- 刪除用軟刪除（讓其他裝置同步時也能移除）；flags 是旗標顏色 0–7；bury_day 是被擱置的學習日，隔天自動解除。
ALTER TABLE notes ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN bury_day INTEGER;
