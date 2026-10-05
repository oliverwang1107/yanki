// 筆記類型管理：新增（內建範本或複製）、改名、欄位（新增／改名／換順序／刪除）、版型（正反向卡片）、樣式 CSS，
// 以及即時預覽。改欄位、版型時會一併處理已有的筆記與卡片（先顯示會動到多少，確認後才套用）。
import { PRESETS, kindOf, presetNoteType, templatesOf } from "../cards.js";
import { cardsOfNote, index, store, uid } from "../core.js";
import * as nts from "../notetypes.js";
import * as ops from "../ops.js";
import { renderSide } from "../render.js";
import { confirmBox, esc, setHeader, toast, actionSheet, promptBox } from "../ui.js";

const KIND_LABEL = { standard: "標準", cloze: "填空題", occlusion: "圖片遮蓋" };
const SPECIALS = ["FrontSide", "Tags", "Deck", "Card", "Type"];

export function mount(el) {
  let draft = null; // 正在編輯的草稿；null 表示在列表頁
  let isNew = false;
  let tIdx = 0;

  // ---------- 列表 ----------
  function drawList() {
    setHeader({ title: "筆記類型", back: "#/more" });
    draft = null;
    const rows = store.static.notetypes.map((nt) => {
      const n = nts.notesOfType(nt.id).length;
      return `<div class="card-box"><div class="row"><div class="grow"><b>${esc(nt.name)}</b> <span class="pill">${KIND_LABEL[kindOf(nt)]}</span>
        <div class="muted small">${nt.fields.length} 個欄位 · ${templatesOf(nt).length} 個版型 · ${n} 筆筆記</div></div></div>
        <div class="row" style="margin-top:8px;flex-wrap:wrap"><button class="btn" data-edit="${nt.id}">編輯</button><button class="btn" data-copy="${nt.id}">複製</button><button class="btn danger-text" data-del="${nt.id}">刪除</button></div></div>`;
    }).join("");
    el.innerHTML = `${rows}
      <div class="row" style="margin:14px 0"><button class="btn primary" id="t-new">＋ 新增筆記類型</button><button class="btn" id="t-empty">清除空白卡片</button></div>
      <p class="hint">「基本型＋反向卡片」每個筆記會有正反兩張卡；「填空題」每個 {{c1::…}} 一張；「圖片遮蓋」在圖片上畫區域，每組一張。空白卡片是筆記內容已經不會再產生的卡片（例如刪掉某個填空）。</p>`;
  }

  // ---------- 編輯 ----------
  const fieldLocked = (i) => (draft.kind === "cloze" && i === 0) || (draft.kind === "occlusion" && ["Image", "Occlusion"].includes(draft.fields[i].name));
  const tmplLocked = () => draft.kind !== "standard";

  function drawEdit() {
    setHeader({ title: isNew ? "新增筆記類型" : "編輯筆記類型", back: () => drawList() });
    const t = draft.tmpls[tIdx];
    const chips = [...draft.fields.map((f) => f.name), ...SPECIALS].map((n) => `<button type="button" class="chip" data-chip="${esc(n)}">${esc(n)}</button>`).join("");
    el.innerHTML = `
      <label>名稱</label><input id="t-name" value="${esc(draft.name)}">
      <p class="muted small">類型：${KIND_LABEL[draft.kind]}（建立後不能更改）</p>
      <h2>欄位</h2>
      ${draft.fields.map((f, i) => `<div class="row" style="margin:6px 0"><input data-f="${i}" value="${esc(f.name)}" class="grow"${fieldLocked(i) ? " disabled" : ""}>
        <button class="btn" data-fup="${i}"${i === 0 || fieldLocked(i) ? " disabled" : ""} aria-label="上移">↑</button>
        <button class="btn" data-fdown="${i}"${i === draft.fields.length - 1 || fieldLocked(i) ? " disabled" : ""} aria-label="下移">↓</button>
        <button class="btn danger-text" data-fdel="${i}"${draft.fields.length < 2 || fieldLocked(i) ? " disabled" : ""} aria-label="刪除">✕</button></div>`).join("")}
      <button class="btn" id="f-add">＋ 欄位</button>
      <h2>版型（每個版型產生一張卡）</h2>
      <div class="row" style="flex-wrap:wrap;gap:6px">${draft.tmpls.map((x, i) => `<button class="btn${i === tIdx ? " primary" : ""}" data-tab="${i}">${esc(x.name || "（未命名）")}</button>`).join("")}${tmplLocked() ? "" : `<button class="btn" id="t-add">＋ 版型</button>`}</div>
      <label>版型名稱</label><input id="tm-name" value="${esc(t.name)}">
      <label>正面</label><textarea id="tm-q" rows="5" spellcheck="false">${esc(t.qfmt)}</textarea>
      <label>背面</label><textarea id="tm-a" rows="6" spellcheck="false">${esc(t.afmt)}</textarea>
      <div class="muted small" style="margin-top:6px">點一下插入欄位：</div><div class="row" style="flex-wrap:wrap;gap:6px;margin:6px 0">${chips}</div>
      <div class="row" style="flex-wrap:wrap">${tmplLocked() ? "" : `<button class="btn" id="t-up"${tIdx === 0 ? " disabled" : ""}>版型上移</button><button class="btn danger-text" id="t-del"${draft.tmpls.length < 2 ? " disabled" : ""}>刪除這個版型</button>`}</div>
      <h2>樣式 (CSS)</h2><textarea id="t-css" rows="7" spellcheck="false">${esc(draft.css)}</textarea>
      <h2>預覽</h2><div id="t-preview"></div>
      <p class="error" id="t-err" hidden></p>
      <div class="row" style="margin-top:16px"><button class="btn primary" id="t-save">儲存</button><button class="btn" id="t-cancel">取消</button></div>`;
    preview();
  }

  let focused = null; // 最後一個選取的版型文字框，插入欄位用
  function preview() {
    const box = el.querySelector("#t-preview");
    if (!box) return;
    if (draft.kind === "occlusion") { box.innerHTML = `<p class="hint">圖片遮蓋的預覽請在「新增卡片」選這個類型後查看。</p>`; return; }
    try {
      const nt = nts.buildNoteType({ ...draft, tmpls: draft.tmpls.map((t) => ({ ...t })) });
      const vals = nts.sampleValues({ ...nt, id: draft.id });
      const ord = draft.kind === "standard" ? tIdx : 0;
      const q = renderSide(nt, vals, "q", ord);
      const a = renderSide(nt, vals, "a", ord);
      // 把使用者的 CSS 限定在預覽區，不會影響整個 App 的外觀
      const css = draft.css
        .replace(/</g, "")
        .replace(/\.card\b/g, ".card-body")
        .replace(/([^{}@]+)\{/g, (m, sel) => sel.split(",").map((s) => `#t-preview ${s.trim()}`).join(",") + "{");
      box.innerHTML = `<style>${css}</style><div class="card-body">${q.html}</div><div class="card-body" style="margin-top:8px">${a.html}</div>`;
    } catch (err) {
      box.innerHTML = `<p class="hint">預覽失敗：${esc(err.message)}</p>`;
    }
  }

  function renameCommit(i) {
    const f = draft.fields[i];
    const name = f.name.trim();
    if (!name || name === f.committed) return;
    for (const t of draft.tmpls) {
      t.qfmt = nts.renameInTemplate(t.qfmt, f.committed, name);
      t.afmt = nts.renameInTemplate(t.afmt, f.committed, name);
    }
    f.committed = name;
  }

  async function save() {
    const err = nts.validateDraft(draft, store.static.notetypes);
    const errEl = el.querySelector("#t-err");
    if (err) { errEl.textContent = err; errEl.hidden = false; return; }
    errEl.hidden = true;
    const old = isNew ? null : index.noteTypeById.get(draft.id);
    const notes = old ? nts.notesOfType(old.id) : [];
    const cards = notes.flatMap((n) => cardsOfNote(n.id));
    const plan = old ? nts.planChange(old, draft, notes, cards) : { noteChanges: [], droppedFields: [], drop: [], remap: [], addedTemplates: false };
    const notices = [];
    if (plan.droppedFields.length) notices.push(`欄位「${plan.droppedFields.join("、")}」的內容會被刪除`);
    if (plan.drop.length) notices.push(`會刪除 ${plan.drop.length} 張卡片（被移除的版型產生的）`);
    if (plan.noteChanges.length) notices.push(`會更新 ${plan.noteChanges.length} 筆筆記（欄位順序或數量改變）`);
    if (plan.addedTemplates && notes.length) notices.push("新版型會替現有的筆記產生新卡片");
    if (notices.length && !(await confirmBox(`${notices.join("；")}。繼續嗎？`, { ok: "儲存", danger: plan.drop.length > 0 || plan.droppedFields.length > 0 }))) return;
    el.querySelector("#t-save").disabled = true;
    try {
      await nts.applyChange(draft, plan, (msg) => toast(msg, 3000));
      toast("已儲存");
      drawList();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.hidden = false;
      el.querySelector("#t-save").disabled = false;
    }
  }

  async function removeType(id) {
    const nt = index.noteTypeById.get(id);
    if (store.static.notetypes.length < 2) return toast("至少要保留一個筆記類型");
    const notes = nts.notesOfType(id);
    if (!(await confirmBox(notes.length ? `「${nt.name}」底下有 ${notes.length} 筆筆記，會一併刪除（連同它們的卡片）。確定嗎？` : `刪除筆記類型「${nt.name}」？`, { ok: "刪除", danger: true }))) return;
    try {
      if (notes.length) await ops.deleteNotes(notes);
      const { saveStatic } = await import("../core.js");
      await saveStatic({ notetypes: store.static.notetypes.filter((n) => n.id !== id) });
      toast("已刪除");
      drawList();
    } catch (e) {
      toast(e.message, 5000);
    }
  }

  // ---------- 事件 ----------
  el.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (!draft) {
      if (d.edit) { isNew = false; draft = nts.draftOf(index.noteTypeById.get(Number(d.edit))); tIdx = 0; drawEdit(); }
      else if (d.copy) {
        const src = index.noteTypeById.get(Number(d.copy));
        const name = await promptBox({ title: "複製筆記類型", value: `${src.name} 副本`, ok: "複製" });
        if (!name?.trim()) return;
        if (store.static.notetypes.some((n) => n.name === name.trim())) return toast("已經有同名的筆記類型了");
        try {
          await nts.addNoteType({ ...JSON.parse(JSON.stringify(src)), id: uid(), name: name.trim(), tmpls: templatesOf(src).map((t) => ({ ...t })) });
          toast("已複製");
          drawList();
        } catch (err) { toast(err.message, 5000); }
      } else if (d.del) removeType(Number(d.del));
      else if (b.id === "t-new") {
        actionSheet(Object.entries(PRESETS).map(([key, p]) => ({
          label: p.label,
          onClick: () => {
            isNew = true;
            const nt = presetNoteType(key, uid(), p.label.replace(/ \(.*\)$/, ""));
            let name = nt.name, n = 2;
            while (store.static.notetypes.some((x) => x.name === name)) name = `${nt.name} ${n++}`;
            draft = nts.draftOf({ ...nt, name });
            draft.fields.forEach((f) => (f.orig = null));
            draft.tmpls.forEach((t) => (t.orig = null));
            tIdx = 0;
            drawEdit();
          },
        })), "從範本建立");
      } else if (b.id === "t-empty") {
        const empty = ops.findEmptyCards();
        if (!empty.length) return toast("沒有空白卡片");
        if (!(await confirmBox(`找到 ${empty.length} 張空白卡片（筆記內容已經不會再產生它們）。刪除嗎？`, { ok: "刪除", danger: true }))) return;
        const r = await ops.deleteEmptyCards();
        toast(r.skipped ? `已刪除 ${r.deleted} 張；另有 ${r.skipped} 張所屬筆記完全沒有內容，已保留` : `已刪除 ${r.deleted} 張空白卡片`, 4000);
        drawList();
      }
      return;
    }
    // 編輯畫面
    if (d.fup !== undefined || d.fdown !== undefined) {
      const i = Number(d.fup ?? d.fdown), j = d.fup !== undefined ? i - 1 : i + 1;
      [draft.fields[i], draft.fields[j]] = [draft.fields[j], draft.fields[i]];
      drawEdit();
    } else if (d.fdel !== undefined) {
      draft.fields.splice(Number(d.fdel), 1);
      drawEdit();
    } else if (b.id === "f-add") {
      let n = draft.fields.length + 1, name = `欄位 ${n}`;
      while (draft.fields.some((f) => f.name === name)) name = `欄位 ${++n}`;
      draft.fields.push({ name, orig: null, committed: name });
      drawEdit();
    } else if (d.tab !== undefined) { tIdx = Number(d.tab); drawEdit(); }
    else if (b.id === "t-add") {
      const first = draft.fields[0].name;
      draft.tmpls.push({ name: `卡片 ${draft.tmpls.length + 1}`, qfmt: `{{${first}}}`, afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n${draft.fields[1] ? `{{${draft.fields[1].name}}}` : ""}`, orig: null });
      tIdx = draft.tmpls.length - 1;
      drawEdit();
    } else if (b.id === "t-del") { draft.tmpls.splice(tIdx, 1); tIdx = Math.max(0, tIdx - 1); drawEdit(); }
    else if (b.id === "t-up") { [draft.tmpls[tIdx - 1], draft.tmpls[tIdx]] = [draft.tmpls[tIdx], draft.tmpls[tIdx - 1]]; tIdx--; drawEdit(); }
    else if (d.chip !== undefined) {
      const area = focused ?? el.querySelector("#tm-q");
      const { selectionStart: a, selectionEnd: z, value } = area;
      const text = `{{${d.chip}}}`;
      area.value = value.slice(0, a) + text + value.slice(z);
      area.focus();
      area.selectionStart = area.selectionEnd = a + text.length;
      area.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (b.id === "t-save") save();
    else if (b.id === "t-cancel") drawList();
  };
  el.onfocusin = (e) => { if (e.target.matches?.("#tm-q,#tm-a")) focused = e.target; };
  el.oninput = (e) => {
    if (!draft) return;
    const t = e.target;
    if (t.id === "t-name") draft.name = t.value;
    else if (t.dataset.f !== undefined) draft.fields[Number(t.dataset.f)].name = t.value;
    else if (t.id === "tm-name") draft.tmpls[tIdx].name = t.value;
    else if (t.id === "tm-q") draft.tmpls[tIdx].qfmt = t.value;
    else if (t.id === "tm-a") draft.tmpls[tIdx].afmt = t.value;
    else if (t.id === "t-css") draft.css = t.value;
    preview();
  };
  el.onchange = (e) => {
    if (draft && e.target.dataset.f !== undefined) {
      renameCommit(Number(e.target.dataset.f));
      drawEdit();
    }
  };
  drawList();
}
