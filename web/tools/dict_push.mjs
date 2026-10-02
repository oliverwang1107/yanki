// 檢查字典內容、轉成 SQL、上傳到正式環境（或 --local 本機），成功後記錄為已上傳。
// 用法：node tools/dict_push.mjs [--local]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardRemoteWrites } from "./_quota.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv.includes("--local") ? "--local" : "--remote";
const node = (args) => execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, maxBuffer: 1 << 26 });

const flags = process.argv.includes("--local") ? ["--local"] : [];
const built = node([join("tools", "build_dict_sql.mjs"), ...flags]).trim();
console.log(built);
const count = Number(/本次要上傳 (\d+) 個/.exec(built)?.[1] ?? 0);
const sql = join(root, "data", "dict.sql");
if (!existsSync(sql) || !readFileSync(sql, "utf8").trim()) { console.log("沒有新的內容要上傳"); process.exit(0); }
// 每個單字寫 dict 一列，加上主鍵與 dict_mod 索引，約 3 次寫入
if (target === "--remote") await guardRemoteWrites(count * 3, "字典上傳");
node([join("node_modules", "wrangler", "bin", "wrangler.js"), "d1", "execute", "anki-web", target, "--yes", `--file=${join("data", "dict.sql")}`]);
console.log(node([join("tools", "build_dict_sql.mjs"), "--commit", ...flags]).trim().split("\n").pop());
console.log(`已上傳到 ${target === "--local" ? "本機" : "正式環境"}`);
