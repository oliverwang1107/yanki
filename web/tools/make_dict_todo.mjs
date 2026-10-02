// 從 data/export.json 產生「字典待產生清單」：data/dict_todo/NNNN.txt，每批 BATCH 個單字。
// 每行格式：id | 單字 | 詞性與中文釋義 [| 例句]；多益優先，其餘依牌組與新卡順序。
// 已有結果的單字（data/dict/*.jsonl 裡出現過的 id）會被跳過，所以可以重複執行。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BATCH = Number(process.argv[2] || 40);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "data", "export.json"), "utf8"));

const text = (html) =>
  html
    .replace(/\[sound:[^\]]*\]/g, "")
    .replace(/<span[^>]*#777[^>]*>.*?<\/span>/g, "") // 音標
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const done = new Set();
const dictDir = join(root, "data", "dict");
let finished = 0; // 已有結果的批數，新清單的編號從這裡接續，才不會蓋掉舊結果檔
if (existsSync(dictDir)) {
  for (const f of readdirSync(dictDir).filter((n) => n.endsWith(".jsonl"))) {
    finished = Math.max(finished, Number(f.slice(0, 4)));
    for (const line of readFileSync(join(dictDir, f), "utf8").split("\n")) {
      if (line.trim()) done.add(JSON.parse(line).id);
    }
  }
}

const deckName = new Map(data.decks.map((d) => [d.id, d.name]));
const firstCard = new Map();
for (const c of data.cards) {
  const cur = firstCard.get(c.nid);
  if (!cur || (c.pos ?? 1e9) < (cur.pos ?? 1e9)) firstCard.set(c.nid, c);
}
const toeic = data.notetypes.find((n) => n.fields[0] === "正面")?.id;

const rows = data.notes.map((n) => {
  const card = firstCard.get(n.id);
  const deck = deckName.get(card.did);
  const [front, back, example] = n.fields;
  return { id: n.id, deck, pos: card.pos ?? 1e9, toeic: n.mid === toeic, line: [n.id, text(front), text(back), ...(example ? [text(example).slice(0, 120)] : [])].join(" | ") };
});
// 多益 → L3–L6（還在學／還沒學的）→ L1–L2 → 其他（片語牌組 P）
const rank = (r) => (r.toeic ? 0 : /::L[3-6]$/.test(r.deck) ? 1 : /::L[12]$/.test(r.deck) ? 2 : 3);
rows.sort((a, b) => rank(a) - rank(b) || a.deck.localeCompare(b.deck) || a.pos - b.pos || a.id - b.id);

const todo = rows.filter((r) => !done.has(r.id));
const outDir = join(root, "data", "dict_todo");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (let i = 0; i * BATCH < todo.length; i++) {
  const part = todo.slice(i * BATCH, (i + 1) * BATCH);
  writeFileSync(join(outDir, String(finished + i + 1).padStart(4, "0") + ".txt"), part.map((r) => r.line).join("\n") + "\n");
}
console.log(`下一批編號 ${String(finished + 1).padStart(4, "0")}`);
console.log(`總共 ${rows.length} 個單字，已完成 ${done.size}，待產生 ${todo.length}（${Math.ceil(todo.length / BATCH)} 批，每批 ${BATCH}）`);
console.log(`其中多益 ${todo.filter((r) => r.toeic).length}`);
