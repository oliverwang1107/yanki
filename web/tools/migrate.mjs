// 套用 migrations/NNNN_*.sql（只做新增、不破壞資料），版本記在 meta 的 schema_version。
// 用法：node tools/migrate.mjs local|remote
// schema.sql 是第 2 版（建表）；遷移從 0003 開始。已經套用過的不會重跑。
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardRemoteWrites } from "./_quota.mjs";

const target = process.argv[2];
if (!["local", "remote"].includes(target)) throw new Error("用法：node tools/migrate.mjs local|remote");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const run = (args) =>
  execFileSync(process.execPath, [wrangler, "d1", "execute", "anki-web", `--${target}`, "--yes", "--json", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, maxBuffer: 1 << 26,
  });

const row = JSON.parse(run(["--command=SELECT v FROM meta WHERE k = 'schema_version'"]))[0].results[0];
let version = row ? Number(row.v) : 2;
const pending = readdirSync(join(root, "migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().filter((f) => Number(f.slice(0, 4)) > version);
if (target === "remote" && pending.length) await guardRemoteWrites(60000, `遷移 ${pending.join("、")}（重建資料表時每列約寫 3 次，估計值）`);
for (const f of pending) {
  run([`--file=${join("migrations", f)}`]);
  version = Number(f.slice(0, 4));
  run([`--command=INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', '${version}')`]);
  console.log(`已套用 ${f}`);
}
console.log(pending.length ? `${target} 資料庫現在是第 ${version} 版` : `${target} 資料庫已經是最新（第 ${version} 版）`);
