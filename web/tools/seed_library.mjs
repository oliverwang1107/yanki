// 建立／更新「牌組庫」（uid = 0）：新同學註冊後可以從這裡複製牌組，進度全新。
// 內容取自擁有者（uid = 1）目前的筆記，但卡片進度一律重置，個人標籤（marked、leech）和個人的 FSRS 參數不帶過去。
// 可以重複執行（每次都會整份重建牌組庫，不影響任何人已經複製走的資料）。
// 用法：node tools/seed_library.mjs local|remote [--rebuild] [--force]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardRemoteWrites } from "./_quota.mjs";

const target = process.argv[2];
if (!["local", "remote"].includes(target)) throw new Error("用法：node tools/seed_library.mjs local|remote");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

// 要放進牌組庫的牌組：這些名稱本身加上它們底下的所有子牌組（英文單字::L1…L6）。
const LIBRARY_ROOTS = ["多益 900分 ENG-CH", "英文單字", "英文單字-P"];

const config = { id: 1, name: "Default", newPerDay: 20, revPerDay: 200, maxIvl: 365, desiredRetention: 0.9, learnSteps: [1, 10], relearnSteps: [10], minLapseIvl: 1, params: [] };
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const inLibrary = LIBRARY_ROOTS.map((r) => `name = ${q(r)} OR substr(name, 1, ${r.length + 2}) = ${q(r + "::")}`).join(" OR ");

// 預設只補「牌組庫裡還沒有的」（INSERT OR IGNORE），沒有新內容就幾乎不寫入；--rebuild 才會整份刪掉重建
// （正式環境整份重建大約要寫 10 萬次，會直接用光一整天的免費額度，除非真的必要不要用）。
const rebuild = process.argv.includes("--rebuild");
const wipe = ["cards", "notes", "decks", "configs", "notetypes"].map((t) => `DELETE FROM ${t} WHERE uid = 0;`).join("\n");
const sql = `
${rebuild ? wipe : ""}
INSERT OR IGNORE INTO configs (uid, id, data) VALUES (0, 1, ${q(JSON.stringify(config))});
INSERT OR IGNORE INTO notetypes (uid, id, name, fields, qfmt, afmt, css) SELECT 0, id, name, fields, qfmt, afmt, css FROM notetypes WHERE uid = 1;
INSERT OR IGNORE INTO decks (uid, id, name, config) SELECT 0, id, name, 1 FROM decks WHERE uid = 1 AND (${inLibrary});
INSERT OR IGNORE INTO notes (uid, id, guid, mid, mod, tags, fields, deleted)
  SELECT 0, id, guid, mid, mod, TRIM(REPLACE(REPLACE(' ' || tags || ' ', ' marked ', ' '), ' leech ', ' ')), fields, 0
  FROM notes WHERE uid = 1 AND deleted = 0 AND id IN (SELECT nid FROM cards WHERE uid = 1 AND deleted = 0 AND did IN (SELECT id FROM decks WHERE uid = 0));
WITH first_rev AS (SELECT cid, MIN(id) AS t FROM revlog WHERE uid = 1 GROUP BY cid)
INSERT OR IGNORE INTO cards (uid, id, nid, did, ord, type, queue, ivl, reps, lapses, left, mod, s, d, lrt, pos, due_ts, due_day, deleted, flags, bury_day)
  SELECT 0, c.id, c.nid, c.did, c.ord, 0, 0, 0, 0, 0, 0, c.mod, NULL, NULL, NULL,
         ROW_NUMBER() OVER (PARTITION BY c.did ORDER BY (c.pos IS NOT NULL), COALESCE(c.pos, f.t, 0), c.nid), NULL, NULL, 0, 0, NULL
  FROM cards c LEFT JOIN first_rev f ON f.cid = c.id
  WHERE c.uid = 1 AND c.deleted = 0 AND c.did IN (SELECT id FROM decks WHERE uid = 0);
`;
if (target === "remote") await guardRemoteWrites(rebuild ? 110000 : 2000, rebuild ? "整份重建牌組庫" : "補齊牌組庫（只寫新增的）");
const file = join(root, "data", "seed_library.sql");
writeFileSync(file, sql);
const run = (args) =>
  execFileSync(process.execPath, [wrangler, "d1", "execute", "anki-web", `--${target}`, "--yes", "--json", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, maxBuffer: 1 << 26,
  });
run([`--file=${file}`]);
const [r] = JSON.parse(run(["--command=SELECT (SELECT COUNT(*) FROM decks WHERE uid=0) d, (SELECT COUNT(*) FROM notes WHERE uid=0) n, (SELECT COUNT(*) FROM cards WHERE uid=0) c, (SELECT COUNT(*) FROM cards WHERE uid=0 AND type != 0) bad"]));
console.log(`${target} 牌組庫：牌組 ${r.results[0].d}、筆記 ${r.results[0].n}、卡片 ${r.results[0].c}（進度不是全新的卡片：${r.results[0].bad}）`);
