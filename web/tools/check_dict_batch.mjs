// 核對 data/dict/NNNN.jsonl 和 data/dict_todo/NNNN.txt 的編號是否完全一致（沒有漏、沒有多、沒有重複）。
// 用法：node tools/check_dict_batch.mjs 5 6 7   或   node tools/check_dict_batch.mjs all
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const names = args[0] === "all"
  ? readdirSync(join(root, "data", "dict")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, 4))
  : args.map((n) => String(n).padStart(4, "0"));
let bad = 0;
for (const n of names) {
  const todoPath = join(root, "data", "dict_todo", `${n}.txt`);
  const outPath = join(root, "data", "dict", `${n}.jsonl`);
  if (!existsSync(todoPath) || !existsSync(outPath)) { console.log(`${n}: 缺檔`); bad++; continue; }
  const want = readFileSync(todoPath, "utf8").split("\n").filter(Boolean).map((l) => ({ id: Number(l.split(" | ")[0]), word: l.split(" | ")[1] }));
  const rows = readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const got = rows.map((r) => r.id);
  const wantSet = new Set(want.map((w) => w.id));
  const seen = new Set();
  const problems = [];
  for (const id of got) {
    if (!wantSet.has(id)) problems.push(`多出 ${id}`);
    if (seen.has(id)) problems.push(`重複 ${id}`);
    seen.add(id);
  }
  rows.forEach((r, i) => {
    const bad = (k, n, strs) => Array.isArray(r[k]) && r[k].some((t) => !Array.isArray(t) || t.length !== n || t.some((x) => typeof x !== "string"));
    if (bad("ph", 2)) problems.push(`第 ${i + 1} 筆 ph 必須是 [片語,中文] 兩元素`);
    if (bad("rel", 3)) problems.push(`第 ${i + 1} 筆 rel 必須是 [字,詞性,中文] 三元素`);
    for (const k of ["syn", "ant", "col"]) if (r[k] && (!Array.isArray(r[k]) || r[k].some((x) => typeof x !== "string"))) problems.push(`第 ${i + 1} 筆 ${k} 必須是字串陣列`);
    if (r.ex && (!Array.isArray(r.ex) || r.ex.length !== 2)) problems.push(`第 ${i + 1} 筆 ex 必須是 [英文,中文]`);
    if (Array.isArray(r.syn) && new Set(r.syn).size !== r.syn.length) problems.push(`第 ${i + 1} 筆 syn 重複`);
  });
  for (const w of want) if (!seen.has(w.id)) problems.push(`漏掉 ${w.id} (${w.word})`);
  if (problems.length) { bad++; console.log(`${n}: ${problems.join("；")}`); }
  else console.log(`${n}: 正確（${got.length} 筆）`);
}
process.exit(bad ? 1 : 0);
