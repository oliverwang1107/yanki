// 把 data/export.json 轉成 data/seed.sql（資料表另放在 schema.sql）。
// 用法：node tools/make_seed.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "data", "export.json"), "utf8"));

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const out = [];

// D1 單一語句上限約 100KB，所以每批只放少量列。
function insert(table, cols, rows, perStatement = 20) {
  for (let i = 0; i < rows.length; i += perStatement) {
    const values = rows.slice(i, i + perStatement).map((r) => `(${r.map(q).join(",")})`);
    out.push(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")};`);
  }
}

insert("meta", ["k", "v"], Object.entries(data.meta).map(([k, v]) => [k, String(v)]));
insert("notetypes", ["id", "name", "fields", "qfmt", "afmt", "css"],
  data.notetypes.map((n) => [n.id, n.name, JSON.stringify(n.fields), n.qfmt, n.afmt, n.css]));
insert("decks", ["id", "name", "config"], data.decks.map((d) => [d.id, d.name, d.config]));
insert("configs", ["id", "data"], data.configs.map((c) => [c.id, JSON.stringify(c)]));
insert("notes", ["id", "guid", "mid", "mod", "tags", "fields"],
  data.notes.map((n) => [n.id, n.guid, n.mid, n.mod * 1000, n.tags, JSON.stringify(n.fields)]));
insert("cards", ["id", "nid", "did", "ord", "type", "queue", "ivl", "reps", "lapses", "left", "mod", "s", "d", "lrt", "pos", "due_ts", "due_day"],
  data.cards.map((c) => [c.id, c.nid, c.did, c.ord, c.type, c.queue, c.ivl, c.reps, c.lapses, c.left, c.mod * 1000,
    c.s ?? null, c.d ?? null, c.lrt ?? null, c.pos ?? null, c.dueTs ?? null, c.dueDay ?? null]), 50);
insert("revlog", ["id", "cid", "ease", "ivl", "last_ivl", "time", "type"],
  data.revlog.map((r) => [r.id, r.cid, r.ease, r.ivl, r.lastIvl, r.time, r.type]), 100);

writeFileSync(join(root, "data", "seed.sql"), out.join("\n") + "\n");
console.log(`${out.length} 條語句 -> data/seed.sql`);
