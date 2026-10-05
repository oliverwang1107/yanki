// 卡片版型：支援 {{欄位}}、{{FrontSide}}、{{#欄位}}…{{/欄位}}、{{^欄位}}…{{/欄位}}，
// 並把 [sound:檔名] 換成播放鈕。欄位內容是 HTML，輸出前先過濾。

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

function expand(template, fields, frontSide) {
  const section = /\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
  let out = template;
  for (let m; (m = section.exec(out)); ) {
    const present = (fields[m[2]] ?? "").trim() !== "";
    const keep = m[1] === "#" ? present : !present;
    out = out.slice(0, m.index) + (keep ? m[3] : "") + out.slice(m.index + m[0].length);
  }
  return out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name) => (name === "FrontSide" ? frontSide : fields[name] ?? ""));
}

// 回傳 { html, sounds }：html 已過濾並加上播放鈕，sounds 是這一面的音檔清單。
export function renderSide(noteType, fieldValues, side) {
  const fields = Object.fromEntries(noteType.fields.map((name, i) => [name, fieldValues[i] ?? ""]));
  const front = expand(noteType.qfmt, fields, "");
  const raw = side === "q" ? front : expand(noteType.afmt, fields, front);
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
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
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
