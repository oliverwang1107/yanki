// 新增與編輯筆記：頁面版（#/add、#/edit/ID）和對話框版（複習、瀏覽器裡直接編輯）共用同一個表單。
// 支援加入圖片／音檔／錄音、填空題（{{c1::…}}）、圖片遮蓋的繪製，並預覽這個筆記會產生的每一張卡。
import { cardOrds, clozeNumbers, kindOf, noCardsReason, templatesOf } from "../cards.js";
import { cardsOfNote, index, shortName, store } from "../core.js";
import { startRecording, uploadFile } from "../media.js";
import * as ops from "../ops.js";
import { renderSide } from "../render.js";
import { confirmBox, esc, openDialog, setHeader, toast } from "../ui.js";
import { mountOcclusionEditor } from "./io_editor.js";

const noteTypes = () => store.static.notetypes;
const deckLabel = (d) => d.name.replaceAll("::", " › ");

function insertAtCursor(textarea, text) {
  const { selectionStart: a, selectionEnd: b, value } = textarea;
  textarea.value = value.slice(0, a) + text + value.slice(b);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = a + text.length;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// 把檔案（圖片或音檔）上傳後插進欄位
async function attach(textarea, file) {
  toast("上傳中…", 20000);
  try {
    insertAtCursor(textarea, await uploadFile(file));
    toast("已加入");
  } catch (err) {
    toast(err.message, 5000);
  }
}

function recordDialog(textarea) {
  const d = openDialog(`<h3>錄音</h3><p id="rec-msg" class="muted">準備麥克風…</p><div class="dialog-actions"><button id="rec-cancel">取消</button><button id="rec-stop" class="primary-btn" disabled>停止並加入</button></div>`);
  let rec;
  const msg = (t) => (d.el.querySelector("#rec-msg").textContent = t);
  d.el.querySelector("#rec-cancel").onclick = () => { rec?.cancel(); d.close(); };
  startRecording().then((r) => {
    rec = r;
    msg("錄音中… 說完請按「停止並加入」");
    const stop = d.el.querySelector("#rec-stop");
    stop.disabled = false;
    stop.onclick = async () => {
      stop.disabled = true;
      msg("上傳中…");
      try {
        const file = await rec.stop();
        d.close();
        await attach(textarea, file);
      } catch (err) {
        msg(err.message);
      }
    };
  }).catch((err) => msg(err.name === "NotAllowedError" ? "沒有麥克風權限，請在瀏覽器設定允許" : err.message));
}

function wrapSelection(textarea, before, after) {
  const { selectionStart: a, selectionEnd: b, value } = textarea;
  textarea.value = value.slice(0, a) + before + value.slice(a, b) + after + value.slice(b);
  textarea.focus();
  textarea.selectionStart = a + before.length;
  textarea.selectionEnd = b + before.length;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// 把選取的文字包成填空：new＝下一個新編號，same＝沿用目前最大的編號
function clozeWrap(textarea, which) {
  const nums = clozeNumbers(textarea.value);
  const n = which === "same" ? Math.max(1, nums.at(-1) ?? 1) : (nums.at(-1) ?? 0) + 1;
  wrapSelection(textarea, `{{c${n}::`, "}}");
}

const toolbar = (i, kind) =>
  `<div class="toolbar"><button type="button" data-wrap="b">B</button><button type="button" data-wrap="i"><i>I</i></button><button type="button" data-wrap="u"><u>U</u></button><button type="button" data-br>換行</button><button type="button" data-file="image" title="加入圖片">🖼</button><button type="button" data-file="audio" title="加入音檔">🔊</button><button type="button" data-rec title="錄音">🎤</button>${
    kind === "cloze" && i === 0
      ? `<button type="button" data-cloze="new" title="把選取的文字變成填空（Ctrl+Shift+C）">[…] 填空</button><button type="button" data-cloze="same" title="同一個編號再加一個填空（Alt+Shift+C）">[…] 同號</button>`
      : ""
  }</div>`;

// 表單本體。mode 是 "add" 或 "edit"；回傳讀取目前輸入值的方法。
function buildForm(root, { mode, note, mid, did, tags = "", onChange }) {
  const nt = index.noteTypeById.get(mid);
  const kind = kindOf(nt);
  const fieldValues = note ? note.fields : nt.fields.map(() => "");
  const decks = index.decks;
  const fieldBox = (f, i) => `<div class="fieldbox"><label>${esc(f)}</label>${toolbar(i, kind)}
      <textarea data-field="${i}" rows="${i === 0 && kind !== "occlusion" ? 2 : 3}">${esc(fieldValues[i] ?? "")}</textarea></div>`;
  root.innerHTML = `
    ${mode === "add" ? `<div class="optgrid"><div><label>筆記類型</label><select id="f-type">${noteTypes().map((t) => `<option value="${t.id}"${t.id === mid ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <div><label>牌組</label><select id="f-deck">${decks.map((d) => `<option value="${d.id}"${d.id === did ? " selected" : ""}>${esc(deckLabel(d))}</option>`).join("")}</select></div></div>` : ""}
    ${nt.fields.map((f, i) => {
      if (kind === "occlusion" && f === "Image") return `${fieldBox(f, i)}<div id="io-editor" class="fieldbox"></div>`;
      if (kind === "occlusion" && f === "Occlusion") return `<details class="fieldbox"><summary class="small muted">進階：遮蓋資料（Occlusion 欄位，一般不用改）</summary>${fieldBox(f, i)}</details>`;
      return fieldBox(f, i);
    }).join("")}
    <div id="dup" class="hint"></div>
    <label>標籤（用空白分隔）</label><input id="f-tags" value="${esc(tags)}" autocapitalize="none" autocomplete="off">
    <details class="preview"><summary class="small muted" style="margin-top:14px;cursor:pointer">預覽 <span id="card-count"></span></summary><div id="preview"></div></details>
    <div id="form-error" class="error" hidden></div>`;

  let ioEditor = null;
  const fields = () => [...root.querySelectorAll("[data-field]")].map((t) => t.value);
  const refresh = () => {
    const vals = fields();
    const first = vals[0]?.trim();
    const dups = first && kind !== "occlusion" ? ops.findDuplicates(mid, first, note?.id) : [];
    root.querySelector("#dup").innerHTML = dups.length ? `<span class="pill warn">已經有 ${dups.length} 張相同的「${esc(nt.fields[0])}」</span>` : "";
    const ords = cardOrds(nt, vals);
    const tmpls = templatesOf(nt);
    const ctx = { tags: root.querySelector("#f-tags")?.value ?? "" };
    root.querySelector("#preview").innerHTML = ords.length
      ? ords.slice(0, 8).map((ord) => {
          const q = renderSide(nt, vals, "q", ord, ctx);
          const a = renderSide(nt, vals, "a", ord, ctx);
          const label = kind === "standard" ? (tmpls.length > 1 ? `卡片 ${ord + 1} · ${esc(tmpls[ord]?.name ?? "")}` : "") : `卡片 ${ord + 1}`;
          return `${label ? `<div class="small muted" style="margin-top:10px">${label}</div>` : ""}<div class="card-body">${q.html}</div><div class="card-body" style="margin-top:8px">${a.html}</div>`;
        }).join("") + (ords.length > 8 ? `<p class="hint">…還有 ${ords.length - 8} 張卡片</p>` : "")
      : `<p class="hint">${esc(noCardsReason(nt))}</p>`;
    root.querySelector("#card-count").textContent = ords.length > 1 ? `· 會產生 ${ords.length} 張卡片` : "";
    ioEditor?.refresh();
    onChange?.();
  };
  root.oninput = refresh;
  root.addEventListener("keydown", (e) => {
    if (kind !== "cloze" || !e.target.matches?.("[data-field='0']") || !e.shiftKey || e.key.toLowerCase() !== "c") return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); clozeWrap(e.target, "new"); }
    else if (e.altKey) { e.preventDefault(); clozeWrap(e.target, "same"); }
  });
  // 貼上圖片（截圖、複製的圖）或把檔案拖進欄位，直接上傳並插入
  root.addEventListener("paste", (e) => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/") || f.type.startsWith("audio/"));
    if (file && e.target.matches("textarea")) { e.preventDefault(); attach(e.target, file); }
  });
  root.addEventListener("dragover", (e) => e.target.matches?.("textarea") && e.dataTransfer?.types.includes("Files") && e.preventDefault());
  root.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && e.target.matches?.("textarea")) { e.preventDefault(); attach(e.target, file); }
  });
  root.onclick = (e) => {
    const t = e.target.closest("[data-wrap],[data-br],[data-file],[data-rec],[data-cloze]");
    if (!t) return;
    const area = t.closest(".fieldbox").querySelector("textarea");
    if (t.dataset.file) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = t.dataset.file === "image" ? "image/*" : "audio/*";
      input.onchange = () => input.files[0] && attach(area, input.files[0]);
      input.click();
    } else if ("rec" in t.dataset) recordDialog(area);
    else if (t.dataset.cloze) clozeWrap(area, t.dataset.cloze);
    else if (t.dataset.wrap) wrapSelection(area, `<${t.dataset.wrap}>`, `</${t.dataset.wrap}>`);
    else wrapSelection(area, "<br>", "");
  };
  if (kind === "occlusion") {
    const areas = [...root.querySelectorAll("[data-field]")];
    const at = (name) => areas[nt.fields.indexOf(name)];
    ioEditor = mountOcclusionEditor(root.querySelector("#io-editor"), {
      image: () => at("Image")?.value ?? "",
      read: () => at("Occlusion")?.value ?? "",
      write: (text) => {
        const a = at("Occlusion");
        if (a) { a.value = text; a.dispatchEvent(new Event("input", { bubbles: true })); }
      },
    });
  }
  refresh();
  return {
    fields,
    tags: () => root.querySelector("#f-tags").value,
    typeId: () => Number(root.querySelector("#f-type")?.value ?? mid),
    deckId: () => Number(root.querySelector("#f-deck")?.value ?? did),
    error: (msg) => {
      const el = root.querySelector("#form-error");
      el.textContent = msg ?? "";
      el.hidden = !msg;
    },
    clear: () => {
      // 連續新增時：圖片遮蓋保留不動太麻煩，全部清空；填空題與一般類型也是
      root.querySelectorAll("[data-field]").forEach((t) => (t.value = ""));
      refresh();
      root.querySelector("[data-field]").focus();
    },
  };
}

// ---------- 頁面：新增 ----------
export function mountAdd(el, params) {
  const last = JSON.parse(localStorage.getItem("add-defaults") ?? "{}");
  const mid = Number(params.get("mid")) || (index.noteTypeById.has(last.mid) ? last.mid : noteTypes()[0]?.id);
  const did = Number(params.get("deck")) || (index.deckById.has(last.did) ? last.did : index.decks.find((d) => d.id !== 1)?.id ?? index.decks[0]?.id);
  if (!mid || !did) {
    el.innerHTML = `<p class="muted">還沒有資料，請先同步。</p>`;
    setHeader({ title: "新增卡片" });
    return;
  }
  setHeader({ title: "新增卡片" });
  let state = { mid, did, tags: last.tags ?? "" };
  const draw = () => {
    el.innerHTML = `<div id="form"></div><div class="row" style="margin-top:16px"><button class="btn primary" id="add">新增</button><span class="muted small">會依筆記類型的版型自動產生卡片</span><a class="small" href="#/more/types" style="margin-left:auto">管理筆記類型</a></div>`;
    const form = buildForm(el.querySelector("#form"), { mode: "add", ...state });
    el.querySelector("#f-type").onchange = () => ((state = { ...state, mid: form.typeId(), did: form.deckId(), tags: form.tags() }), draw());
    el.querySelector("#add").onclick = async () => {
      try {
        form.error("");
        state = { mid: form.typeId(), did: form.deckId(), tags: form.tags() };
        const { cards } = await ops.addNote({ mid: state.mid, did: state.did, fields: form.fields(), tags: state.tags });
        localStorage.setItem("add-defaults", JSON.stringify(state));
        toast(cards.length > 1 ? `已新增（${cards.length} 張卡片）` : "已新增");
        form.clear();
      } catch (err) {
        form.error(err.message);
      }
    };
  };
  draw();
}

// ---------- 對話框：編輯既有的筆記 ----------
export function openNoteDialog(note, { onSaved, onDeleted } = {}) {
  const nt = index.noteTypeById.get(note.mid);
  const cards = cardsOfNote(note.id);
  const d = openDialog(`<h3>編輯筆記</h3><div id="dlg-form"></div>
    <p class="hint">${esc(nt.name)} · ${cards.map((c) => esc(shortName(index.deckById.get(c.did) ?? { name: "?" }))).join("、")}</p>
    <div class="dialog-actions"><button id="dlg-del" class="danger-text" style="margin-right:auto">刪除</button><button data-close>取消</button><button id="dlg-save" class="primary-btn">儲存</button></div>`);
  const form = buildForm(d.el.querySelector("#dlg-form"), { mode: "edit", note, mid: note.mid, did: cards[0]?.did, tags: note.tags });
  d.el.querySelector("[data-close]").onclick = () => d.close();
  d.el.querySelector("#dlg-save").onclick = async () => {
    try {
      const { added } = await ops.editNote(note, { fields: form.fields(), tags: form.tags() });
      d.close();
      toast(added ? `已儲存，並新增 ${added} 張卡片` : "已儲存");
      onSaved?.(note);
    } catch (err) {
      form.error(err.message);
    }
  };
  d.el.querySelector("#dlg-del").onclick = async () => {
    d.close();
    if (!(await confirmBox(`刪除這張筆記和它的 ${cards.length} 張卡片？`, { ok: "刪除", danger: true }))) return;
    await ops.deleteNotes([note]);
    toast("已刪除");
    onDeleted?.(note);
  };
}

// ---------- 頁面：編輯（直接用網址進來時） ----------
export function mountEdit(el, nid) {
  const note = store.notes.get(nid);
  setHeader({ title: "編輯筆記", back: "#/browse" });
  if (!note) {
    el.innerHTML = `<p class="muted">找不到這張筆記。</p>`;
    return;
  }
  el.innerHTML = `<div id="form"></div><div class="row" style="margin-top:16px"><button class="btn primary" id="save">儲存</button><button class="btn" id="del">刪除</button></div>`;
  const form = buildForm(el.querySelector("#form"), { mode: "edit", note, mid: note.mid, did: cardsOfNote(nid)[0]?.did, tags: note.tags });
  el.querySelector("#save").onclick = async () => {
    try {
      await ops.editNote(note, { fields: form.fields(), tags: form.tags() });
      toast("已儲存");
      history.back();
    } catch (err) {
      form.error(err.message);
    }
  };
  el.querySelector("#del").onclick = async () => {
    if (await confirmBox("刪除這張筆記和它的所有卡片？", { ok: "刪除", danger: true })) {
      await ops.deleteNotes([note]);
      toast("已刪除");
      history.back();
    }
  };
}
