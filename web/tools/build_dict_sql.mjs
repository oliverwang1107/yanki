// 把 data/dict/*.jsonl（每行一個單字的字典內容）檢查後轉成 data/dict.sql。
// 只輸出「還沒上傳過、或內容有變」的單字（對照 data/dict_uploaded.json），
// 這樣裝置只需要重新下載有變動的列。上傳成功後加上 --commit 把這次的內容記成已上傳。
// 用法：node tools/build_dict_sql.mjs [--commit] [--local]（本機與正式環境各自記錄已上傳的內容）
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const commit = process.argv.includes("--commit");
const manifestPath = join(root, "data", process.argv.includes("--local") ? "dict_uploaded.local.json" : "dict_uploaded.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const noteIds = new Set(JSON.parse(readFileSync(join(root, "data", "export.json"), "utf8")).notes.map((n) => n.id));

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const strs = (v) => Array.isArray(v) && v.every(isStr);
const triples = (v, n) => Array.isArray(v) && v.every((t) => Array.isArray(t) && t.length === n && t.every(isStr));

const errors = [];
const entries = new Map();
const dictDir = join(root, "data", "dict");
for (const f of readdirSync(dictDir).filter((n) => n.endsWith(".jsonl")).sort()) {
  readFileSync(join(dictDir, f), "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${f}:${i + 1}`;
    let e;
    try { e = JSON.parse(line); } catch { return errors.push(`${where} 不是合法的 JSON`); }
    if (!noteIds.has(e.id)) return errors.push(`${where} 找不到 note ${e.id}`);
    const bad = [];
    if (e.syn !== undefined && !strs(e.syn)) bad.push("syn");
    if (e.ant !== undefined && !strs(e.ant)) bad.push("ant");
    if (e.col !== undefined && !strs(e.col)) bad.push("col");
    if (e.en !== undefined && !isStr(e.en)) bad.push("en");
    if (e.ph !== undefined && !triples(e.ph, 2)) bad.push("ph");
    if (e.rel !== undefined && !triples(e.rel, 3)) bad.push("rel");
    if (e.ex !== undefined && !triples([e.ex], 2)) bad.push("ex");
    const known = new Set(["id", "syn", "ant", "en", "ph", "col", "rel", "ex"]);
    for (const k of Object.keys(e)) if (!known.has(k)) bad.push(`未知欄位 ${k}`);
    if (!e.syn && !e.en && !e.ph && !e.col && !e.rel) bad.push("內容是空的");
    if (bad.length) return errors.push(`${where} 欄位格式錯誤：${bad.join(", ")}`);
    if (entries.has(e.id)) errors.push(`${where} note ${e.id} 重複出現`);
    entries.set(e.id, e);
  });
}
if (errors.length) {
  console.error(errors.slice(0, 20).join("\n") + (errors.length > 20 ? `\n…共 ${errors.length} 個問題` : ""));
  process.exit(1);
}

const q = (s) => `'${s.replaceAll("'", "''")}'`;
const now = Date.now();
const rows = [];
const next = { ...manifest };
for (const [id, e] of entries) {
  const { id: _, ...body } = e;
  const data = JSON.stringify(body);
  const hash = createHash("sha1").update(data).digest("hex").slice(0, 12);
  if (manifest[id] === hash) continue;
  rows.push(`(${id},${now},${q(data)})`);
  next[id] = hash;
}
const sql = [];
for (let i = 0; i < rows.length; i += 25) sql.push(`INSERT OR REPLACE INTO dict (id, mod, data) VALUES ${rows.slice(i, i + 25).join(",")};`);
writeFileSync(join(root, "data", "dict.sql"), sql.join("\n") + (sql.length ? "\n" : ""));
console.log(`共 ${entries.size} 個單字有字典內容，本次要上傳 ${rows.length} 個 -> data/dict.sql`);
if (commit) { writeFileSync(manifestPath, JSON.stringify(next)); console.log("已記錄為已上傳"); }
