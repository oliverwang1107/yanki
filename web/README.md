# 單字複習（Anki 的 Cloudflare 替代品）

取代 AnkiWeb 與桌面／手機 Anki：一個輕量網頁（可加到 iPhone 主畫面），排程在瀏覽器的 WASM 裡算，
Cloudflare Worker 只負責提供頁面和存資料。全部在免費方案內。

```
瀏覽器 ── sched.wasm（Rust fsrs ＋ Anki 的學習步驟／間隔規則）、fsrs_opt.wasm（參數最佳化，背景執行）
   │      IndexedDB：整份收藏 ＋ 待上傳的紀錄（離線也能複習）
   ▼
Worker（src/worker.js）── 驗證 ── 靜態檔（網頁、wasm）
   ├─ R2 `yanki-media`：音檔與圖片（/media/*，支援 Range）
   └─ D1：notes、cards、revlog、牌組設定
```

## 常用指令

| 目的 | 指令 |
|---|---|
| 從本機 Anki 匯出資料（唯讀副本） | `python tools/export_anki.py --media`（需 `pip install anki`） |
| 把 `public/media/` 的音檔與圖片上傳到 R2（只傳還沒傳過的；`--local` 傳到本機模擬 R2，`--all` 全部重傳）。**音檔不在 git 裡，也不會隨 `wrangler deploy` 上傳，新增音檔後要跑這個** | `node tools/upload_media.mjs` |
| 轉成 D1 的匯入檔 | `node tools/make_seed.mjs` |
| 建表並匯入本機資料庫 | `npx wrangler d1 execute anki-web --local --file=schema.sql`，再 `--file=data/seed.sql`，最後 `node tools/migrate.mjs local` 升到最新版（seed.sql 是舊格式，要先匯入再遷移） |
| 本機執行 | `npx wrangler dev`（登入碼在 `.dev.vars` 的 `AUTH_TOKEN`） |
| **切換用匯入器**：把快照之後在 Anki 的複習與修改合併進網頁版（預設只試跑） | `"C:\Users\yaya\AppData\Local\AnkiProgramFiles\.venv\Scripts\python.exe" tools/sync_from_anki.py`；加 `--apply` 才寫入，`--target local` 對本機，規則見檔案開頭 |
| 套用資料庫遷移（只往前，已套用的不會重跑） | `node tools/migrate.mjs local` 或 `remote`（**套用到正式站前先備份**：`node node_modules/wrangler/bin/wrangler.js d1 export anki-web --remote --output=data/backup.sql`） |
| 建立／更新牌組庫（新同學可複製的牌組，進度全新） | `node tools/seed_library.mjs local` 或 `remote` |
| 帳號管理：邀請連結、重設密碼連結、使用者清單、停用 | `node tools/admin.mjs invite\|reset-link\|users\|disable\|enable local\|remote`（說明見檔案開頭） |
| **FSRS 最佳化**：用 Anki 內建的最佳化工具，從你完整的複習紀錄（Anki + 網頁版）算新參數，並比較各目標記憶率的複習量；加 `--apply` 才寫入牌組設定（舊設定自動備份） | `"C:\Users\yaya\AppData\Local\AnkiProgramFiles\.venv\Scripts\python.exe" tools/fsrs_optimize.py [--retention 0.95] [--override 多益=0.97] [--apply]` |
| 前端單元測試（備份還原、媒體、筆記類型、匯入、最佳化、朗讀都在裡面） | `node --test tests/*.test.mjs` |
| 多使用者端對端測試（對本機 dev server） | `node tools/test_multiuser.mjs`（83 項：登入保護、邀請、牌組庫、資料隔離、失敗限制、停用／重設／改密碼） |
| 重新編譯 WASM | `cd wasm && cargo build --release --target wasm32-unknown-unknown`，再複製到 `public/sched.wasm` |
| 重新編譯最佳化用的 WASM（和 `sched.wasm` 一樣用 getrandom "unsupported" 後端） | `cd fsrs_opt && cargo build --release --target wasm32-unknown-unknown`，再複製到 `public/fsrs_opt.wasm`；`node tools/test_fsrsopt.mjs` 用你的紀錄試跑並和 Anki 的結果比較 |
| 重新產生 .apkg 測試檔（舊／新格式、含媒體、進度、填空、圖片遮蓋） | `"C:UsersyayaAppDataLocalAnkiProgramFiles.venvScriptspython.exe" tools/make_apkg_fixtures.py`（輸出到 `tests/fixtures/`） |
| 更新 `public/vendor/` 的 sql.js、fzstd（匯入 .apkg 用，只在匯入頁面才會載入） | `npm install` 後把 `node_modules/sql.js/dist/sql-wasm-browser.{js,wasm}` 複製成 `public/vendor/sql-wasm.{js,wasm}`、`node_modules/fzstd/esm/index.mjs` 複製成 `public/vendor/fzstd.mjs` |

## 帳號與多使用者

- **每個人一個帳號**（帳號＋密碼），資料用 `uid` 分開：筆記、卡片、複習紀錄、牌組、設定都只有自己看得到、改得到（伺服器用登入狀態決定 uid，不信任用戶端送來的任何 uid）。字典 `dict` 和音檔是大家共用的。
- **邀請制註冊**：擁有者在 App 的「更多 → 邀請同學與使用者管理」產生一次性連結（7 天內有效，只存雜湊）。忘記密碼就在同一頁產生「重設密碼連結」（24 小時內有效）。
- **密碼**在瀏覽器裡先做 PBKDF2（20 萬次），伺服器只收到結果、資料庫存它的 SHA-256；免費方案每個請求 CPU 只有約 10ms，沒辦法在 Worker 裡做重運算。連續輸入錯誤會被鎖 15 分鐘。
- **登入狀態**是簽章過的 cookie（`SESSION_SECRET`），停用帳號、重設或改密碼都會讓舊的登入狀態立刻失效。
- **`AUTH_TOKEN`** 現在只給本機工具程式用（`Authorization: Bearer`，對應擁有者帳號），網頁登入不再用它。放在 `.prod-token` / `.dev.vars`，請當密碼保管。
- **牌組庫**（uid 0）：新同學註冊後從這裡複製牌組（目前只有「多益 900分 ENG-CH」），卡片進度全新、不帶擁有者的個人標籤和 FSRS 參數。要開放別的牌組，改 `tools/seed_library.mjs` 的 `LIBRARY_DECKS` 再執行一次。
- 擁有者（管理員）看得到每個人的卡片數和複習次數，直接查資料庫的話也看得到內容；請跟同學說清楚。
- 免費額度是**整個網站共用**：Worker 每天約 10 萬次請求（音檔也算）、D1 每天約 10 萬次寫入。每位新同學第一次加入牌組會寫入幾千筆。

## 排程正確性怎麼驗證

`tools/make_oracle.py` 用 Anki 自己的後端，對真實卡片算出按四個按鈕後的狀態，存成 `wasm/tests/oracle.json`。

- `cd wasm && cargo test --test oracle`：Rust 排程對照 Anki
- `node tools/test_wasm.mjs`：同一份答案，經過 JS ↔ WASM 介面再比一次

目前 1,692 項全部一致：記憶狀態（穩定度、難度）、學習／重學步驟完全相同；
間隔落在 Anki 的 fuzz 範圍內。沒有複製的部分：Anki 的負載平衡（依當天各日的到期量挑日子）、
學習步驟的隨機延遲，以及「還沒到期就提早複習」的特殊處理。

## 已知限制

- Worker 免費方案：每個請求 CPU 約 10ms、D1 單次呼叫最多 50 條語句，所以讀取分頁、寫入用 `json_each` 一次寫一批。
- 所有檔案（含 mp3）沒登入都拿不到；只有登入頁需要的 `pw.js`、圖示和 manifest 是公開的。
- `vendor/workerd-windows-64.tgz` 是因為這台機器下載大檔常被中斷，改用可續傳的 curl 抓好，
  再由 `package.json` 的 `overrides` 指向它。換網路好的環境可以刪掉它和 `overrides`。

## 進度清單（對照桌面版 Anki）

已完成並部署：
- [x] 複習：FSRS 排程（WASM）、學習／重學步驟、每日上限（含上層牌組）、撤銷、鍵盤快速鍵、音檔
- [x] 離線複習佇列＋同步（IndexedDB ↔ D1）
- [x] 字典（同義、反義、英文釋義、片語、搭配、相關詞）顯示在翻面後；資料用 `tools/make_dict_todo.mjs`、`tools/build_dict_sql.mjs` 管線產生與上傳
- [x] 牌組：新增、改名、刪除（含子牌組）
- [x] 牌組選項：每日上限、步驟、目標記憶率、最長間隔、FSRS 參數、擱置、頑固卡、預設組管理
- [x] 卡片瀏覽器：Anki 搜尋語法、排序、批次操作（暫停、擱置、旗標、標記、標籤、換牌組、改到期日、重設、刪除）
- [x] 新增／編輯／刪除筆記、重複偵測、預覽
- [x] 卡片資訊（含 FSRS 記憶狀態與可提取率、複習紀錄）
- [x] 自訂複習（取代篩選牌組，例如考前掃描）
- [x] 統計與目標進度（取代 `anki_progress.py`）
- [x] 備份下載（JSON）
- [x] 學習體驗：卡片文字大小、朗讀按鈕與自動朗讀（瀏覽器內建語音合成，沒有音檔的單字和例句也能聽）、複習畫面的撤銷鈕、牌組頁的今日進度與連續天數、複習完成的統計
- [x] 快測：用字典內容出同義字、反義字、英文釋義、例句填空的選擇題（干擾項優先同詞性），練習用、不影響排程；邏輯在 `public/js/quizgen.js`，測試在 `tests/quiz.test.mjs`

尚未完成：
- [x] 從 Anki 匯入切換日之前的複習紀錄（`tools/sync_from_anki.py`，已用修改過的收藏副本在本機驗證，試跑正式站結果與 Anki 完全一致）
- [x] 備份還原：JSON 備份（含手寫標記），還原可選「合併」或「完整還原」，只寫有差異的列（`public/js/backup.js`）。同時修好了「刪除的筆記與卡片不會同步」的問題
- [x] 使用者自己的媒體：編輯時加入圖片（自動縮圖）、音檔、錄音，貼上／拖進欄位也行；存在 R2 的 `u<uid>-<雜湊>.<副檔名>`，只有本人讀得到，每人 300MB（`src/media.js`、`public/js/media.js`）
- [x] 筆記類型：正反向卡片、可選的反向卡片、輸入答案、填空題（`{{c1::…::提示}}`，可巢狀）、圖片遮蓋（Anki 相容格式，可用 Apple Pencil／手指／滑鼠在圖片上畫矩形與橢圓）、筆記類型與版型編輯器（欄位改名／搬移／刪除、版型新增／排序／刪除，會一併處理已有的筆記與卡片）、清除空白卡片（`public/js/cards.js`、`notetypes.js`、`views/types.js`、`views/io_editor.js`）
- [x] FSRS 參數最佳化：App 內按一下，在瀏覽器背景用 fsrs crate 計算（`fsrs_opt/`），和預設值與現有設定比較準確度，可套用與還原；另有「分牌組比較」：依頂層牌組或牌組設定各算一組專屬參數，和共用一組比，留 20% 的卡片當沒看過的測試集，差距要超過雜訊才算（`fsrsopt.js` 的 `compareSplit`），只回答「值不值得分開」，不會改任何設定；`tools/fsrs_optimize.py` 仍可在電腦上用 Anki 內建工具跑（還能算目標記憶率的複習量）
- [x] .apkg 匯入：舊格式（anki2／anki21）與新格式（anki21b，zstd），筆記類型、牌組階層、圖片音檔、複習進度（可選）、略過重複（`public/js/apkg.js`、`importer.js`、`views/import.js`）
- [x] 雲端發音備援：瀏覽器沒有英文語音時改用 Workers AI（MeloTTS），念過的句子存在 R2 和這台裝置上（`src/tts.js`）
- [x] 片語例句：加進「字典片語」牌組的片語，用 Workers AI 自動寫一句例句（`src/ai.js`）
- [x] Apple Pencil 手寫標記：複習時在答案面畫螢光、圈選，存在卡片上並同步（`public/js/ink.js`、`views/ink_layer.js`）
- 還沒做：Anki 的負載平衡與學習步驟隨機延遲（見上面「排程正確性」）、`.colpkg`（整份收藏）匯入、`.apkg` 匯出、影片媒體、LaTeX／MathJax

## 測試

- `node --test tests/` 前端邏輯（搜尋、操作、每日規劃）
- `node tools/test_wasm.mjs`、`cd wasm && cargo test --test oracle` 排程對照 Anki
- 資料庫遷移：`node tools/migrate.mjs local|remote`（只新增、不破壞）
