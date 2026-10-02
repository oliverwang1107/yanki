# anki_deck

背單字用的個人工具：

- [`web/`](web/README.md)：自己部署在 Cloudflare 的 Anki 替代品（免費方案的 Worker + D1 + 靜態檔，排程用 Rust 編成的 WASM），含多使用者帳號、字典、快測。**詳細說明、常用指令、已知限制都在 [`web/README.md`](web/README.md)。**
- `anki_progress.py`、`查看進度.bat`：讀本機 Anki 收藏，算讀卡進度的小工具（產生的 HTML 報告含個人進度，不進版本控制）。
- `複習計畫.md`：各目標的截止日與每日進度規劃。

## 這個儲存庫**沒有**的東西（在新電腦上要自己補）

為了安全和大小，下面這些被 `.gitignore` 擋在外面：

| 不在儲存庫裡 | 為什麼 | 怎麼取得 |
|---|---|---|
| `web/.dev.vars`、`web/.prod-token` | 登入用的祕密值 | 本機自己建（`AUTH_TOKEN`、`SESSION_SECRET`，格式見 `web/README.md` 的「帳號與多使用者」）；正式站的祕密值在 Cloudflare 的 secrets 裡 |
| `web/data/`（除了 `data/dict/*.jsonl`） | 你的 Anki 匯出、資料庫備份、種子檔，含個人資料 | `python tools/export_anki.py`、`node tools/make_seed.mjs` 等重新產生 |
| `web/public/media/` | 幾千個音檔（111 MB，來自你的牌組） | `python tools/export_anki.py --media` 從 Anki 複製 |
| `web/vendor/`、`node_modules/` | 33 MB 的 workerd 備份檔與套件 | `npm install`（`package.json` 的 `overrides` 指向 `vendor/`，網路正常的環境直接刪掉 `overrides` 就好） |
| `web/wasm/target/`、`web/wasm/tests/oracle.json` | 編譯產物、用你收藏產生的對照答案 | `cd web/wasm && cargo build --release --target wasm32-unknown-unknown`、`python tools/make_oracle.py` |

## 保密提醒

- 這是**私有**儲存庫。裡面沒有任何祕密值；`web/data/dict/` 是我替你的單字產生的字典內容。
- 不要把 `.dev.vars`、`.prod-token`、`data/` 加進版本控制。新增這類檔案時先確認 `.gitignore` 有擋住。
- Cloudflare 的帳號、資料庫 ID 出現在 `web/wrangler.jsonc` 和 `web/tools/_quota.mjs`，它們不是祕密（沒有登入權限就用不了）。

## 部署

```bash
cd web
node node_modules/wrangler/bin/wrangler.js deploy
```

資料庫遷移與大量寫入請先看 `web/README.md` 的免費額度說明（每天寫入上限約 10 萬列，台灣時間早上 8 點重置）。
