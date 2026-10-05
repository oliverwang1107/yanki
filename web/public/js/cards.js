// 筆記類型與卡片產生：一個筆記會產生幾張卡、填空題與圖片遮蓋的語法、內建的筆記類型範本。
// 規則和 Anki 相同：標準類型每個版型的「正面」有內容就產生一張；填空題每個 {{cN::…}} 編號一張；圖片遮蓋每個遮蓋群組一張。
// 沒有任何畫面相關的程式，Node 也能載入測試。

export const SPECIAL_FIELDS = new Set(["FrontSide", "Tags", "Deck", "Subdeck", "Card", "Type", "CardFlag"]);

export const kindOf = (nt) => nt?.kind ?? "standard";

// 版型清單；舊的筆記類型只有 qfmt／afmt，視為只有一個版型
export function templatesOf(nt) {
  if (Array.isArray(nt?.tmpls) && nt.tmpls.length) return nt.tmpls;
  return [{ name: "卡片 1", qfmt: nt?.qfmt ?? "", afmt: nt?.afmt ?? "" }];
}

// 欄位是否「有內容」：去掉標籤與空白後有文字，或含有圖片／音檔
export function hasContent(value) {
  const v = String(value ?? "");
  if (/<img\b|\[sound:/i.test(v)) return true;
  return v.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s+/g, "").length > 0;
}

// 條件區段：{{#欄位}}…{{/欄位}}（有內容才保留）、{{^欄位}}…{{/欄位}}（沒內容才保留），可以巢狀。
export function expandSections(template, fields) {
  const section = /\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
  let out = template;
  for (let m; (m = section.exec(out)); ) {
    const present = hasContent(fields[m[2]]);
    const keep = m[1] === "#" ? present : !present;
    out = out.slice(0, m.index) + (keep ? m[3] : "") + out.slice(m.index + m[0].length);
  }
  return out;
}

// ---------- 填空題 {{c1::答案::提示}} ----------
export function clozeNumbers(text) {
  const nums = new Set();
  for (const m of String(text ?? "").matchAll(/\{\{c(\d+)::/g)) nums.add(Number(m[1]));
  return [...nums].filter((n) => n >= 1 && n <= 500).sort((a, b) => a - b);
}

// 去掉填空標記，回傳整句（瀏覽器的標題、朗讀用）
export function stripCloze(text) {
  let s = String(text ?? "");
  for (let prev; prev !== s; ) {
    prev = s;
    s = s.replace(/\{\{c\d+::((?:(?!\{\{c\d+::)[\s\S])*?)(?:::[^{}]*?)?\}\}/g, "$1");
  }
  return s;
}

// ---------- 圖片遮蓋 ----------
// Anki 的格式：{{c1::image-occlusion:rect:left=.27:top=.21:width=.1:height=.11:oi=1}}，座標是圖片寬高的比例。
export function parseOcclusion(text) {
  const shapes = [];
  for (const m of String(text ?? "").matchAll(/\{\{c(\d+)::image-occlusion:([a-z]+)((?::[^:{}]+)*)\}\}/g)) {
    const props = {};
    for (const part of m[3].split(":").filter(Boolean)) {
      const i = part.indexOf("=");
      if (i > 0) props[part.slice(0, i)] = part.slice(i + 1).replace(/^"|"$/g, "");
    }
    const num = (k) => Number(props[k]);
    const base = { group: Number(m[1]), kind: m[2], hideAll: props.oi === "1" };
    if (m[2] === "rect" && [num("left"), num("top"), num("width"), num("height")].every(Number.isFinite)) {
      shapes.push({ ...base, x: num("left"), y: num("top"), w: num("width"), h: num("height") });
    } else if (m[2] === "ellipse" && [num("left"), num("top"), num("rx"), num("ry")].every(Number.isFinite)) {
      shapes.push({ ...base, x: num("left"), y: num("top"), rx: num("rx"), ry: num("ry") });
    } else if (m[2] === "polygon" && props.points) {
      const pts = props.points.trim().split(/\s+/).map((p) => p.split(",").map(Number));
      if (pts.length >= 3 && pts.every((p) => p.length === 2 && p.every(Number.isFinite))) shapes.push({ ...base, points: pts });
    }
  }
  return shapes;
}

const r4 = (n) => String(Math.round(n * 10000) / 10000).replace(/^0\./, ".").replace(/^-0\./, "-.");
// 把遮蓋區域轉回欄位文字（每個區域一個標記，用 <br> 分開）
export function stringifyOcclusion(shapes) {
  return shapes
    .map((s) => {
      const oi = s.hideAll === false ? "" : ":oi=1";
      if (s.points) return `{{c${s.group}::image-occlusion:polygon:points="${s.points.map((p) => `${r4(p[0])},${r4(p[1])}`).join(" ")}"${oi}}}`;
      if (s.rx !== undefined) return `{{c${s.group}::image-occlusion:ellipse:left=${r4(s.x)}:top=${r4(s.y)}:rx=${r4(s.rx)}:ry=${r4(s.ry)}${oi}}}`;
      return `{{c${s.group}::image-occlusion:rect:left=${r4(s.x)}:top=${r4(s.y)}:width=${r4(s.w)}:height=${r4(s.h)}${oi}}}`;
    })
    .join("<br>");
}

export const occlusionGroups = (text) => [...new Set(parseOcclusion(text).map((s) => s.group))].sort((a, b) => a - b);

// ---------- 一個筆記會產生哪幾張卡（回傳卡片編號 ord，從 0 開始） ----------
const fieldMap = (nt, values) => Object.fromEntries(nt.fields.map((name, i) => [name, values[i] ?? ""]));

function frontHasContent(qfmt, fields) {
  const s = expandSections(qfmt, fields);
  for (const m of s.matchAll(/\{\{([^}#^/]+?)\}\}/g)) {
    const name = m[1].trim().split(":").pop().trim();
    if (!SPECIAL_FIELDS.has(name) && hasContent(fields[name])) return true;
  }
  return false;
}

export function cardOrds(nt, values) {
  const fields = fieldMap(nt, values);
  const kind = kindOf(nt);
  if (kind === "cloze") {
    const qfmt = templatesOf(nt)[0].qfmt;
    const names = [...qfmt.matchAll(/\{\{cloze:([^}]+?)\}\}/g)].map((m) => m[1].trim());
    const text = (names.length ? names : nt.fields).map((n) => fields[n] ?? "").join("\n");
    return clozeNumbers(text).map((n) => n - 1);
  }
  if (kind === "occlusion") return occlusionGroups(fields["Occlusion"]).map((n) => n - 1);
  return templatesOf(nt).map((t, i) => (frontHasContent(t.qfmt, fields) ? i : -1)).filter((i) => i >= 0);
}

// 沒有任何卡片時，給使用者看得懂的原因
export function noCardsReason(nt) {
  const kind = kindOf(nt);
  if (kind === "cloze") return "填空題至少要有一個填空，例如 {{c1::答案}}";
  if (kind === "occlusion") return "請先加入圖片，並至少畫一個遮蓋區域";
  return "這個筆記不會產生任何卡片：版型正面用到的欄位都是空的";
}

// 瀏覽器、選單裡顯示的筆記標題
export function noteTitle(nt, values) {
  const kind = kindOf(nt);
  const strip = (h) => String(h ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (kind === "occlusion") {
    const header = strip(values[nt.fields.indexOf("Header")]);
    return header || "[圖片遮蓋]";
  }
  if (kind === "cloze") return strip(stripCloze(values[0]));
  return strip(values[0]);
}

// ---------- 內建的筆記類型範本 ----------
export const DEFAULT_CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}
.cloze { font-weight: bold; color: #2563eb; }
.example { color: #666; }`;

const REV = `{{FrontSide}}\n\n<hr id=answer>\n\n`;
export const PRESETS = {
  basic: { label: "基本型 (Basic)", kind: "standard", fields: ["Front", "Back"], tmpls: [{ name: "卡片 1", qfmt: "{{Front}}", afmt: `${REV}{{Back}}` }] },
  reversed: {
    label: "基本型＋反向卡片 (Basic and reversed card)", kind: "standard", fields: ["Front", "Back"],
    tmpls: [{ name: "卡片 1", qfmt: "{{Front}}", afmt: `${REV}{{Back}}` }, { name: "卡片 2", qfmt: "{{Back}}", afmt: `${REV}{{Front}}` }],
  },
  optional: {
    label: "基本型＋可選的反向卡片 (Basic optional reversed)", kind: "standard", fields: ["Front", "Back", "Add Reverse"],
    tmpls: [{ name: "卡片 1", qfmt: "{{Front}}", afmt: `${REV}{{Back}}` }, { name: "卡片 2", qfmt: "{{#Add Reverse}}{{Back}}{{/Add Reverse}}", afmt: `${REV}{{Front}}` }],
  },
  typing: {
    label: "基本型＋輸入答案 (Basic, type in the answer)", kind: "standard", fields: ["Front", "Back"],
    tmpls: [{ name: "卡片 1", qfmt: "{{Front}}\n\n{{type:Back}}", afmt: "{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}" }],
  },
  cloze: {
    label: "填空題 (Cloze)", kind: "cloze", fields: ["Text", "Back Extra"],
    tmpls: [{ name: "填空", qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}<br>\n{{Back Extra}}" }],
  },
  occlusion: {
    label: "圖片遮蓋 (Image Occlusion)", kind: "occlusion", fields: ["Image", "Occlusion", "Header", "Back Extra"],
    tmpls: [{
      name: "圖片遮蓋",
      qfmt: `{{#Header}}<div class="io-header">{{Header}}</div>{{/Header}}{{io:Image}}`,
      afmt: `{{#Header}}<div class="io-header">{{Header}}</div>{{/Header}}{{io:Image}}{{#Back Extra}}<hr id=answer><div class="io-extra">{{Back Extra}}</div>{{/Back Extra}}`,
    }],
  },
};

// 依範本建出一個筆記類型（id 由呼叫端給）
export function presetNoteType(key, id, name) {
  const p = PRESETS[key];
  return {
    id,
    name: name ?? p.label.replace(/ \(.*\)$/, ""),
    kind: p.kind,
    fields: [...p.fields],
    tmpls: p.tmpls.map((t) => ({ ...t })),
    qfmt: p.tmpls[0].qfmt,
    afmt: p.tmpls[0].afmt,
    css: DEFAULT_CSS,
  };
}
