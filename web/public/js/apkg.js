// 讀 Anki 的 .apkg 套件：解壓、解開資料庫（舊格式 JSON 或新格式 protobuf）、整理成和版本無關的結構。
// 支援三種套件版本：1（collection.anki2）、2（collection.anki21）、3（collection.anki21b，zstd 壓縮，含 meta）。
// SQLite 用 sql.js、zstd 用 fzstd；兩者都由呼叫端傳進來（瀏覽器載入 /vendor/ 裡的，測試載入 node_modules 裡的）。
import { readZip } from "./zip.js";

// ---------- 極簡 protobuf 讀取：只需要字串、整數、巢狀訊息 ----------
function varint(buf, pos) {
  let result = 0;
  let mul = 1;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if (!(b & 0x80)) return [result, pos];
    mul *= 128;
    if (mul > 2 ** 70) throw new Error("protobuf 格式錯誤"); // 最多 10 個位元組（大整數會失去精度，這裡用不到）
  }
}

// 回傳 Map<欄位編號, (number | Uint8Array)[]>
export function parseProto(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = varint(buf, pos);
    const [num, wire] = [Math.floor(tag / 8), tag % 8];
    let value;
    if (wire === 0) [value, pos] = varint(buf, pos);
    else if (wire === 2) {
      let len;
      [len, pos] = varint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 1) { value = 0; pos += 8; }
    else if (wire === 5) { value = 0; pos += 4; }
    else throw new Error("protobuf 格式錯誤");
    if (!fields.has(num)) fields.set(num, []);
    fields.get(num).push(value);
  }
  return fields;
}
const text = (bytes) => new TextDecoder().decode(bytes);
const str = (m, n) => (m.get(n)?.[0] ? text(m.get(n)[0]) : "");
const int = (m, n) => m.get(n)?.[0] ?? 0;

const rows = (db, sql) => {
  const res = db.exec(sql)[0];
  if (!res) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
};

// 欄位名稱判斷圖片遮蓋類型（新版 Anki 內建的「Image Occlusion」）
const isOcclusion = (fields) => fields.includes("Occlusion") && fields.includes("Image");

// ---------- 主程式 ----------
// source：File／Blob。deps：{ SQL（sql.js 初始化後的物件）, zstd（(Uint8Array) => Uint8Array）}
export async function readPackage(source, deps) {
  const zip = await readZip(source);
  let version = 1;
  if (zip.has("meta")) version = int(parseProto(await zip.read("meta")), 1) || 1;
  const entry = version >= 3 && zip.has("collection.anki21b") ? "collection.anki21b" : zip.has("collection.anki21") ? "collection.anki21" : "collection.anki2";
  if (!zip.has(entry)) throw new Error("這個檔案裡沒有 Anki 收藏（不是 .apkg？）");
  let bytes = await zip.read(entry);
  if (entry.endsWith(".anki21b")) {
    if (!deps.zstd) throw new Error("缺少 zstd 解壓縮");
    bytes = deps.zstd(bytes);
  }
  const db = new deps.SQL.Database(bytes);
  try {
    const col = rows(db, "select crt, mod from col")[0] ?? { crt: 0, mod: 0 };
    const tables = rows(db, "select name from sqlite_master where type='table'").map((r) => r.name);
    const isNew = tables.includes("notetypes");
    let notetypes;
    let decks;
    if (isNew) {
      const fields = rows(db, "select ntid, ord, name from fields order by ntid, ord");
      const templates = rows(db, "select ntid, ord, name, config from templates order by ntid, ord");
      notetypes = rows(db, "select id, name, config from notetypes").map((nt) => {
        const cfg = parseProto(nt.config);
        const fieldNames = fields.filter((f) => f.ntid === nt.id).map((f) => f.name);
        const kind = int(cfg, 1) === 1 ? "cloze" : "standard";
        return {
          srcId: nt.id,
          name: nt.name,
          kind: isOcclusion(fieldNames) ? "occlusion" : kind,
          fields: fieldNames,
          css: str(cfg, 3),
          tmpls: templates.filter((t) => t.ntid === nt.id).map((t) => {
            const c = parseProto(t.config);
            return { name: t.name, qfmt: str(c, 1), afmt: str(c, 2) };
          }),
        };
      });
      decks = rows(db, "select id, name from decks").map((d) => ({ srcId: d.id, name: String(d.name).replaceAll("\x1f", "::") }));
    } else {
      const c = db.exec("select models, decks from col")[0].values[0];
      const models = JSON.parse(c[0]);
      notetypes = Object.values(models).map((m) => {
        const fieldNames = [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name);
        return {
          srcId: Number(m.id),
          name: m.name,
          kind: isOcclusion(fieldNames) ? "occlusion" : m.type === 1 ? "cloze" : "standard",
          fields: fieldNames,
          css: m.css ?? "",
          tmpls: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
        };
      });
      decks = Object.values(JSON.parse(c[1])).map((d) => ({ srcId: Number(d.id), name: String(d.name).replaceAll("\x1f", "::") }));
    }
    const notes = rows(db, "select id, guid, mid, mod, tags, flds from notes").map((n) => ({
      srcId: n.id, guid: n.guid, mid: n.mid, mod: n.mod, tags: String(n.tags).trim().split(/\s+/).filter(Boolean), fields: String(n.flds).split("\x1f"),
    }));
    const cards = rows(db, "select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, data from cards").map((c) => {
      let data = {};
      try { data = c.data ? JSON.parse(c.data) : {}; } catch { /* 舊格式不是 JSON */ }
      // 篩選牌組裡的卡片：原本的牌組與到期日在 odid／odue
      const filtered = c.odid && c.odid !== 0;
      return { ...c, did: filtered ? c.odid : c.did, due: filtered && c.odue ? c.odue : c.due, data };
    });
    const revlog = rows(db, "select id, cid, ease, ivl, lastIvl, factor, time, type from revlog");

    // 媒體：舊版是 JSON { "0": "檔名" }；新版是（zstd 壓縮的）protobuf，每個檔案本身也用 zstd 壓縮
    let mediaNames = new Map(); // zip 內檔名 → 原始檔名
    if (zip.has("media")) {
      const raw = await zip.read("media");
      if (version >= 3) {
        const list = parseProto(deps.zstd(raw)).get(1) ?? [];
        list.forEach((e, i) => mediaNames.set(String(i), str(parseProto(e), 1)));
      } else {
        mediaNames = new Map(Object.entries(JSON.parse(text(raw))));
      }
    }
    const byName = new Map([...mediaNames].map(([zipName, name]) => [name, zipName]));
    const media = {
      names: [...byName.keys()],
      size: (name) => zip.size(byName.get(name)),
      read: async (name) => {
        const zipName = byName.get(name);
        if (zipName === undefined || !zip.has(zipName)) return null;
        const data = await zip.read(zipName);
        return version >= 3 ? deps.zstd(data) : data;
      },
    };
    // 匯出當下的「今天」（收藏建立日起算的天數），用來把複習卡的到期日換算成相對天數
    const today = Math.max(0, Math.floor((col.mod / 1000 - col.crt) / 86400));
    return { version, notetypes, decks, notes, cards, revlog, media, today, exportedAt: col.mod };
  } finally {
    db.close();
  }
}
