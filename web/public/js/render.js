// 卡片版型：支援 {{欄位}}、{{FrontSide}}、{{#欄位}}…{{/欄位}}、{{^欄位}}…{{/欄位}}、
// 過濾器 {{cloze:欄位}} {{text:欄位}} {{hint:欄位}} {{type:欄位}}，特殊欄位 {{Tags}} {{Deck}} {{Card}} {{Type}}，
// 以及圖片遮蓋（{{io:Image}}）；並把 [sound:檔名] 換成播放鈕。欄位內容是 HTML，輸出前先過濾。
import { expandSections, hasContent, kindOf, parseOcclusion, templatesOf } from "./cards.js";

const BLOCKED = "script,iframe,object,embed,link,meta,base,form,style";

export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}`, "text/html");
  doc.querySelectorAll(BLOCKED).forEach((el) => el.remove());
  for (const el of doc.body.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const v = attr.value.trim().toLowerCase();
      if (attr.name.startsWith("on") || v.startsWith("javascript:") || v.startsWith("data:text/html")) el.removeAttribute(attr.name);
    }
  }
  return doc.body.innerHTML;
}

// 匯入的卡片常用「<img src="檔名.jpg">」這種相對路徑；統一改成 /media/檔名（已經是網址或 data: 的不動）。
export function fixMediaSrc(html) {
  return html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi, (all, head, q, src) => {
    if (!src || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src)) return all;
    let name = src;
    try { name = decodeURIComponent(src); } catch { /* 保持原樣 */ }
    return `${head}${q}/media/${encodeURIComponent(name)}${q}`;
  });
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const plain = (html) =>
  String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();

// ---------- 填空題：{{c1::答案::提示}}，可以巢狀 ----------
function splitHint(body) {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < body.length - 1; i++) {
    if (body.startsWith("{{", i)) { depth++; i++; }
    else if (body.startsWith("}}", i)) { depth--; i++; }
    else if (depth === 0 && body.startsWith("::", i)) cut = i;
  }
  return cut < 0 ? { answer: body, hint: "" } : { answer: body.slice(0, cut), hint: body.slice(cut + 2) };
}

// active：要考的填空編號。問題面把它換成 […]（有提示就顯示提示），答案面用強調顯示答案；其他填空直接顯示文字。
export function renderCloze(text, active, side) {
  const s = String(text ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("{{c", i);
    if (open < 0) { out += s.slice(i); break; }
    const m = /^\{\{c(\d+)::/.exec(s.slice(open));
    if (!m) { out += s.slice(i, open + 3); i = open + 3; continue; }
    let depth = 1;
    let j = open + m[0].length;
    while (j < s.length && depth > 0) {
      if (s.startsWith("{{", j)) { depth++; j += 2; }
      else if (s.startsWith("}}", j)) { depth--; j += 2; }
      else j++;
    }
    if (depth !== 0) { out += s.slice(i); break; } // 括號沒配對好，原樣顯示
    out += s.slice(i, open);
    const { answer, hint } = splitHint(s.slice(open + m[0].length, j - 2));
    const inner = renderCloze(answer, active, side);
    if (Number(m[1]) === active) {
      out += side === "q" ? `<span class="cloze">[${hint ? esc(plain(hint)) : "..."}]</span>` : `<span class="cloze">${inner}</span>`;
    } else out += inner;
    i = j;
  }
  return out;
}

// ---------- 圖片遮蓋 ----------
// 形狀座標是圖片寬高的比例，疊一層 viewBox 0..1 的 SVG 就能對齊，圖片縮放時遮罩跟著縮放。
export function renderOcclusion(imageHtml, occlusionText, active, side) {
  const els = [];
  for (const s of parseOcclusion(occlusionText)) {
    const isActive = s.group === active;
    if (!isActive && !s.hideAll) continue; // 「只遮一個」模式：其他區域不顯示
    const style = isActive
      ? side === "q" ? `fill="#ff8e8e" stroke="#212121"` : `fill="rgba(34,197,94,0.14)" stroke="#16a34a" stroke-dasharray="6 4"`
      : `fill="#ffeba2" stroke="#212121"`;
    const common = `${style} stroke-width="${isActive && side === "a" ? 2 : 1.2}" vector-effect="non-scaling-stroke"`;
    if (s.points) els.push(`<polygon points="${s.points.map((p) => p.join(",")).join(" ")}" ${common}/>`);
    else if (s.rx !== undefined) els.push(`<ellipse cx="${s.x + s.rx}" cy="${s.y + s.ry}" rx="${s.rx}" ry="${s.ry}" ${common}/>`);
    else els.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" ${common}/>`);
  }
  return `<div class="io-stage">${imageHtml}<svg class="io-svg" viewBox="0 0 1 1" preserveAspectRatio="none">${els.join("")}</svg></div>`;
}

// ---------- {{type:欄位}}：輸入答案，翻面後對照 ----------
function typeAnswer(value, ctx) {
  if (ctx.stripType) return "";
  const expected = plain(value);
  if (ctx.side === "q") return `<input type="text" class="typeans" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="輸入答案">`;
  const typed = (ctx.typed ?? "").trim();
  if (!typed) return `<div class="typeres"><span class="typeok">${esc(expected)}</span></div>`;
  if (typed === expected) return `<div class="typeres"><span class="typeok">${esc(expected)}</span></div>`;
  return `<div class="typeres"><span class="typebad">${esc(typed)}</span><br><span class="typeok">${esc(expected)}</span></div>`;
}

function applyFilter(filter, value, name, ctx) {
  switch (filter) {
    case "cloze": return renderCloze(value, ctx.ord + 1, ctx.side);
    case "text": return esc(plain(value));
    case "hint": return hasContent(value) ? `<details class="hint"><summary>${esc(name)}</summary>${value}</details>` : "";
    case "type": return typeAnswer(value, ctx);
    case "io": return renderOcclusion(value, ctx.fields["Occlusion"], ctx.ord + 1, ctx.side);
    default: return value; // 不認得的過濾器（furigana、tts…）原樣輸出欄位內容
  }
}

function expandTemplate(template, ctx) {
  const withSections = expandSections(template, ctx.fields);
  return withSections.replace(/\{\{\s*([^}#^/][^}]*?)\s*\}\}/g, (_, expr) => {
    const parts = expr.split(":").map((p) => p.trim());
    const name = parts.pop();
    let value;
    switch (name) {
      case "FrontSide": value = ctx.frontSide; break;
      case "Tags": value = esc(ctx.tags); break;
      case "Deck": value = esc(ctx.deck); break;
      case "Subdeck": value = esc(ctx.deck.split("::").pop()); break;
      case "Card": value = esc(ctx.cardName); break;
      case "Type": value = esc(ctx.typeName); break;
      default: value = ctx.fields[name] ?? "";
    }
    for (const f of parts.reverse()) value = applyFilter(f, value, name, ctx);
    return value;
  });
}

// 回傳 { html, sounds }：html 已過濾並加上播放鈕，sounds 是這一面的音檔清單。
// ord：這是筆記的第幾張卡（標準類型決定用哪個版型；填空題與圖片遮蓋決定考哪一個編號）。
// ctx：{ tags, deck, typed }，給 {{Tags}}、{{Deck}}、{{type:…}} 用。
export function renderSide(noteType, fieldValues, side, ord = 0, ctx = {}) {
  const fields = Object.fromEntries(noteType.fields.map((name, i) => [name, fieldValues[i] ?? ""]));
  const tmpls = templatesOf(noteType);
  const t = tmpls[kindOf(noteType) === "standard" ? Math.min(ord, tmpls.length - 1) : 0];
  const base = { fields, ord, tags: ctx.tags ?? "", deck: ctx.deck ?? "", cardName: t.name, typeName: noteType.name, typed: ctx.typed };
  const front = expandTemplate(t.qfmt, { ...base, side: "q", frontSide: "" });
  let raw = front;
  if (side !== "q") {
    // 答案面的 {{FrontSide}} 不要再出現輸入框
    const frontForAnswer = /\{\{\s*type:/.test(t.qfmt) ? expandTemplate(t.qfmt, { ...base, side: "q", frontSide: "", stripType: true }) : front;
    raw = expandTemplate(t.afmt, { ...base, side: "a", frontSide: frontForAnswer });
  }
  const sounds = [];
  const withButtons = raw.replace(/\[sound:([^\]]+)\]/g, (_, file) => {
    sounds.push(file);
    return `<button type="button" class="snd" data-file="${file.replace(/"/g, "&quot;")}" aria-label="播放">▶</button>`;
  });
  return { html: sanitize(fixMediaSrc(withButtons)), sounds };
}

// 沒有 FrontSide 分隔線時，答案面只顯示新增的部分（Anki 的 <hr id=answer>）。
export function answerOnly(html) {
  const i = html.indexOf('<hr id="answer">');
  return i === -1 ? html : html.slice(i);
}

// ---------- 字典：同義字、反義字、英文釋義、片語、搭配詞、相關字、例句 ----------
const list = (items) => items.map(esc).join(" · ");

export function renderDict(entry) {
  if (!entry) return "";
  const rows = [];
  const add = (label, html) => html && rows.push(`<div class="dict-row"><b>${label}</b><span>${html}</span></div>`);
  if (entry.syn?.length) add("同義", list(entry.syn));
  if (entry.ant?.length) add("反義", list(entry.ant));
  add("釋義", entry.en ? esc(entry.en) : "");
  if (entry.ph?.length) add("片語", entry.ph.map(([en, zh]) => `${esc(en)} <i>${esc(zh)}</i> <button type="button" class="ph-add" data-en="${esc(en)}" data-zh="${esc(zh)}" aria-label="把「${esc(en)}」加入片語牌組" title="加入片語牌組一起背">＋</button>`).join("<br>"));
  if (entry.col?.length) add("搭配", entry.col.map((c) => `${esc(c)} <button type="button" class="ph-add" data-en="${esc(c)}" data-zh="" aria-label="把「${esc(c)}」加入片語牌組" title="加入片語牌組一起背">＋</button>`).join(" · "));
  if (entry.rel?.length) add("相關", entry.rel.map(([w, pos, zh]) => `${esc(w)} <i>${esc(pos)} ${esc(zh)}</i>`).join(" · "));
  if (entry.ex) add("例句", `${esc(entry.ex[0])}<br><i>${esc(entry.ex[1] ?? "")}</i>`);
  return rows.length ? `<div class="dict">${rows.join("")}</div>` : "";
}

