// Anki 搜尋語法的子集：空白 = 且、or、-否定、括號、"引號"、* 與 _ 萬用字元，
// deck: tag: is: flag: card: note: preset: nid: cid: added: edited: introduced: rated: prop: re: w:，以及「欄位名:內容」。
import { cfgOf, dayOf, index, nowSec, stripHtml, store, today } from "./core.js";
import { tagList } from "./ops.js";

export class SearchError extends Error {}

// ---------- 詞法與語法 ----------
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(" || ch === ")") { tokens.push({ t: ch }); i++; continue; }
    if (ch === "-" && i + 1 < src.length && !/\s/.test(src[i + 1])) { tokens.push({ t: "not" }); i++; continue; }
    let word = "";
    let quoted = false;
    while (i < src.length && !/\s/.test(src[i]) && src[i] !== ")" && !(src[i] === "(" && word === "")) {
      if (src[i] === "\\" && i + 1 < src.length) { word += src[i] + src[i + 1]; i += 2; continue; }
      if (src[i] === '"') {
        quoted = true;
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\" && i + 1 < src.length) { word += src[i] + src[i + 1]; i += 2; continue; }
          word += src[i++];
        }
        if (i >= src.length) throw new SearchError("引號沒有結尾");
        i++;
        continue;
      }
      word += src[i++];
    }
    if (!quoted && /^or$/i.test(word)) tokens.push({ t: "or" });
    else if (!quoted && /^and$/i.test(word)) tokens.push({ t: "and" });
    else tokens.push({ t: "word", v: word });
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const orExpr = () => {
    const args = [andExpr()];
    while (peek()?.t === "or") { pos++; args.push(andExpr()); }
    return args.length === 1 ? args[0] : { op: "or", args };
  };
  const andExpr = () => {
    const args = [unary()];
    while (peek() && peek().t !== "or" && peek().t !== ")") {
      if (peek().t === "and") pos++;
      args.push(unary());
    }
    return args.length === 1 ? args[0] : { op: "and", args };
  };
  const unary = () => {
    const tok = peek();
    if (!tok) throw new SearchError("搜尋條件不完整");
    if (tok.t === "not") { pos++; return { op: "not", arg: unary() }; }
    if (tok.t === "(") {
      pos++;
      const e = orExpr();
      if (peek()?.t !== ")") throw new SearchError("括號沒有成對");
      pos++;
      return e;
    }
    if (tok.t === "word") { pos++; return { op: "term", raw: tok.v }; }
    throw new SearchError("搜尋條件的位置不對");
  };
  if (!tokens.length) return { op: "all" };
  const ast = orExpr();
  if (pos < tokens.length) throw new SearchError(tokens[pos].t === ")" ? "多了一個右括號" : "搜尋條件不完整");
  return ast;
}

// ---------- 比對工具 ----------
const unescape = (s) => s.replace(/\\(.)/g, "$1");

// 把含 * _ 的字串轉成正則；anchored 為 true 時要整串吻合
function glob(raw, anchored) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) { out += raw[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "*") out += ".*";
    else if (c === "_") out += ".";
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${out}$` : out, "is");
}

const CMP = { "=": (a, b) => a === b, "!=": (a, b) => a !== b, ">": (a, b) => a > b, "<": (a, b) => a < b, ">=": (a, b) => a >= b, "<=": (a, b) => a <= b };

function numeric(spec, what) {
  const m = /^([a-z]+)(>=|<=|!=|=|>|<)(-?\d+(?:\.\d+)?)$/i.exec(spec);
  if (!m) throw new SearchError(`prop:${spec} 的格式不對，例如 prop:ivl>=10`);
  return { key: m[1].toLowerCase(), cmp: CMP[m[2]], value: Number(m[3]) };
}

function retrievability(card) {
  if (!card.s || !card.lrt) return null;
  const decay = cfgOf(card.did)?.params?.[20] ?? 0.1542;
  const factor = 0.9 ** (-1 / decay) - 1;
  const days = Math.max(0, today() - dayOf(card.lrt));
  return (1 + (factor * days) / card.s) ** -decay;
}

// ---------- 編譯 ----------
export function compile(query) {
  const ast = parse(tokenize(query));
  const cache = {
    texts: new Map(), // nid -> 各欄位去掉 HTML 的文字
    rated: new Map(), // "N:ease" -> Set(cid)
    first: null, // cid -> 第一次複習的時間
    deckNames: new Map(),
  };
  const fieldsOf = (note) => {
    let t = cache.texts.get(note.id);
    if (!t) cache.texts.set(note.id, (t = note.fields.map(stripHtml)));
    return t;
  };
  const deckPath = (did) => {
    let p = cache.deckNames.get(did);
    if (!p) {
      const name = index.deckById.get(did)?.name ?? "";
      const parts = name.split("::");
      p = parts.map((_, i) => parts.slice(0, i + 1).join("::"));
      cache.deckNames.set(did, p);
    }
    return p;
  };
  const ratedSet = (spec) => {
    let s = cache.rated.get(spec);
    if (!s) {
      const [n, ease] = spec.split(":");
      const days = Number(n);
      if (!Number.isFinite(days) || days < 1) throw new SearchError("rated: 後面要接天數，例如 rated:7");
      const since = today() - days + 1;
      s = new Set();
      for (const r of store.revlog.values()) {
        if (dayOf(r.id / 1000) >= since && (ease === undefined || r.ease === Number(ease))) s.add(r.cid);
      }
      cache.rated.set(spec, s);
    }
    return s;
  };
  const firstReview = () => {
    if (!cache.first) {
      cache.first = new Map();
      for (const r of store.revlog.values()) {
        const cur = cache.first.get(r.cid);
        if (cur === undefined || r.id < cur) cache.first.set(r.cid, r.id);
      }
    }
    return cache.first;
  };

  const term = (raw) => {
    const colon = raw.search(/(?<!\\):/);
    if (colon <= 0) {
      const re = glob(raw, false);
      return (c, n) => fieldsOf(n).some((f) => re.test(f));
    }
    const key = raw.slice(0, colon).toLowerCase();
    const val = raw.slice(colon + 1);
    const plain = unescape(val);
    switch (key) {
      case "deck": {
        if (val.toLowerCase() === "filtered") return () => false;
        const re = glob(val, true);
        return (c) => deckPath(c.did).some((p) => re.test(p));
      }
      case "tag": {
        if (val.toLowerCase() === "none") return (c, n) => tagList(n).length === 0;
        const re = glob(val, true);
        return (c, n) => tagList(n).some((t) => re.test(t) || t.toLowerCase().startsWith(plain.toLowerCase() + "::"));
      }
      case "is":
        switch (plain.toLowerCase()) {
          case "new": return (c) => c.type === 0;
          case "learn": return (c) => c.type === 1 || c.type === 3;
          case "review": return (c) => c.type === 2 || c.type === 3;
          case "due": {
            const t = today();
            const now = nowSec();
            return (c) => (c.queue === 2 && c.due_day <= t) || (c.queue === 1 && c.due_ts <= now + 1200);
          }
          case "suspended": return (c) => c.queue === -1;
          case "buried": return (c) => c.queue === -2 || c.queue === -3;
          case "marked": return (c, n) => tagList(n).includes("marked");
          case "leech": return (c, n) => tagList(n).includes("leech");
          default: throw new SearchError(`is:${plain} 不是有效的條件（new、learn、review、due、suspended、buried、marked、leech）`);
        }
      case "flag": {
        const f = Number(plain);
        if (!Number.isInteger(f) || f < 0 || f > 7) throw new SearchError("flag: 後面要接 0 到 7");
        return (c) => c.flags === f;
      }
      case "card": {
        const o = Number(plain);
        if (!Number.isInteger(o) || o < 1) throw new SearchError("card: 後面要接卡片編號（從 1 開始）");
        return (c) => c.ord + 1 === o;
      }
      case "note": {
        const re = glob(val, true);
        return (c, n) => re.test(index.noteTypeById.get(n.mid)?.name ?? "");
      }
      case "preset": {
        const re = glob(val, true);
        return (c) => re.test(cfgOf(c.did)?.name ?? "");
      }
      case "nid": { const ids = new Set(plain.split(",").map(Number)); return (c) => ids.has(c.nid); }
      case "cid": { const ids = new Set(plain.split(",").map(Number)); return (c) => ids.has(c.id); }
      case "added": {
        const days = Number(plain);
        if (!Number.isFinite(days) || days < 1) throw new SearchError("added: 後面要接天數");
        const since = today() - days + 1;
        return (c, n) => dayOf(n.id / 1000) >= since;
      }
      case "edited": {
        const days = Number(plain);
        if (!Number.isFinite(days) || days < 1) throw new SearchError("edited: 後面要接天數");
        const since = today() - days + 1;
        return (c, n) => dayOf((n.mod ?? 0) / 1000) >= since;
      }
      case "introduced": {
        const days = Number(plain);
        if (!Number.isFinite(days) || days < 1) throw new SearchError("introduced: 後面要接天數");
        const since = today() - days + 1;
        return (c) => {
          const first = firstReview().get(c.id);
          return first !== undefined && dayOf(first / 1000) >= since;
        };
      }
      case "rated": {
        if (!/^\d+(:[0-4])?$/.test(plain)) throw new SearchError("rated: 的格式是 rated:天數 或 rated:天數:按鈕(1-4)");
        const set = ratedSet(plain);
        return (c) => set.has(c.id);
      }
      case "prop": {
        const { key: k, cmp, value } = numeric(plain);
        const t = today();
        const getters = {
          ivl: (c) => (c.type === 2 ? c.ivl : null),
          due: (c) => (c.queue === 2 || (c.queue < 0 && c.type === 2) ? c.due_day - t : null),
          reps: (c) => c.reps,
          lapses: (c) => c.lapses,
          pos: (c) => (c.type === 0 ? c.pos : null),
          s: (c) => c.s ?? null, stability: (c) => c.s ?? null,
          d: (c) => (c.d == null ? null : (c.d - 1) / 9), difficulty: (c) => (c.d == null ? null : (c.d - 1) / 9),
          r: retrievability, retrievability,
        };
        const get = getters[k];
        if (!get) throw new SearchError(`prop:${k} 不支援（ivl、due、reps、lapses、pos、s、d、r）`);
        return (c) => {
          const v = get(c);
          return v !== null && v !== undefined && cmp(v, value);
        };
      }
      case "re": {
        let re;
        try { re = new RegExp(plain, "i"); } catch { throw new SearchError("正規表示式不合法"); }
        return (c, n) => fieldsOf(n).some((f) => re.test(f));
      }
      case "w": {
        const word = plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, "iu");
        return (c, n) => fieldsOf(n).some((f) => re.test(f));
      }
      default: {
        // 其他的「名稱:內容」一律當成欄位搜尋，整個欄位要吻合；用 * 做部分比對
        const re = glob(val, true);
        return (c, n) => {
          const nt = index.noteTypeById.get(n.mid);
          const i = nt ? nt.fields.findIndex((f) => f.toLowerCase() === key) : -1;
          return i >= 0 && re.test(fieldsOf(n)[i] ?? "");
        };
      }
    }
  };

  const build = (node) => {
    switch (node.op) {
      case "all": return () => true;
      case "term": return term(node.raw);
      case "not": { const f = build(node.arg); return (c, n) => !f(c, n); }
      case "and": { const fs = node.args.map(build); return (c, n) => fs.every((f) => f(c, n)); }
      case "or": { const fs = node.args.map(build); return (c, n) => fs.some((f) => f(c, n)); }
    }
  };
  const test = build(ast);
  return (card) => {
    const note = store.notes.get(card.nid);
    return Boolean(note) && test(card, note);
  };
}

// 回傳符合的卡片陣列。查詢有錯會丟出 SearchError（訊息是中文，可以直接顯示）。
export function search(query) {
  const match = compile(query);
  return [...store.cards.values()].filter(match);
}
