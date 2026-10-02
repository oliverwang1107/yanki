// 畫面共用的小工具：選取元素、跳脫文字、提示訊息、標題列、對話框。
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function toast(msg, ms = 2500) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

// 標題列：標題、返回鈕、這個畫面專屬的按鈕
export function setHeader({ title, back = null, actions = [] }) {
  $("#title").textContent = title;
  const backBtn = $("#back");
  backBtn.hidden = !back;
  backBtn.onclick = back ? () => (typeof back === "function" ? back() : (location.hash = back)) : null;
  const box = $("#actions");
  box.replaceChildren(
    ...actions.map((a) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = a.label;
      if (a.title) b.title = a.title;
      b.onclick = a.onClick;
      return b;
    })
  );
}

// 對話框：內容用 HTML 字串，回傳 { el, close }。按 Esc 或點背景可以關閉。
// onClose 一定只會呼叫一次：自己呼叫 close() 時立刻呼叫，按 Esc 時靠 close 事件補上。
export function openDialog(content, { onClose } = {}) {
  const dlg = $("#dialog");
  dlg.innerHTML = `<div class="dialog-body">${content}</div>`;
  let finished = false;
  const finish = (value) => {
    if (finished) return;
    finished = true;
    onClose?.(value);
  };
  const close = (value = "") => {
    if (dlg.open) dlg.close(value);
    finish(value);
  };
  // 前一個對話框遲到的 close 事件可能在新的已經打開之後才來，要忽略
  dlg.onclose = () => !dlg.open && finish(dlg.returnValue);
  dlg.onclick = (e) => {
    if (e.target === dlg) close("");
  };
  dlg.showModal();
  return { el: dlg, close };
}

export function confirmBox(message, { ok = "確定", danger = false } = {}) {
  return new Promise((resolve) => {
    const d = openDialog(
      `<p>${esc(message)}</p><div class="dialog-actions"><button data-v="">取消</button><button data-v="ok" class="${danger ? "danger" : "primary-btn"}">${esc(ok)}</button></div>`,
      { onClose: (v) => resolve(v === "ok") }
    );
    d.el.querySelectorAll("button[data-v]").forEach((b) => (b.onclick = () => d.close(b.dataset.v)));
  });
}

export function promptBox({ title, label = "", value = "", placeholder = "", multiline = false, ok = "確定", hint = "" }) {
  return new Promise((resolve) => {
    const field = multiline ? `<textarea id="prompt-input" rows="6" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="prompt-input" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    const d = openDialog(
      `<h3>${esc(title)}</h3>${label ? `<label>${esc(label)}</label>` : ""}${field}${hint ? `<p class="hint">${esc(hint)}</p>` : ""}<div class="dialog-actions"><button data-v="">取消</button><button data-v="ok" class="primary-btn">${esc(ok)}</button></div>`,
      { onClose: (v) => resolve(v === "ok" ? $("#prompt-input").value : null) }
    );
    d.el.querySelectorAll("button[data-v]").forEach((b) => (b.onclick = () => d.close(b.dataset.v)));
    const input = $("#prompt-input");
    input.focus();
    if (!multiline) input.onkeydown = (e) => e.key === "Enter" && d.close("ok");
  });
}

// 選單：items 是 [{label, onClick, danger?}]，從底部彈出
export function actionSheet(items, title = "") {
  const d = openDialog(
    `${title ? `<h3>${esc(title)}</h3>` : ""}<div class="sheet">${items.map((it, i) => (it.separator ? "<hr>" : `<button data-i="${i}" class="${it.danger ? "danger-text" : ""}">${esc(it.label)}</button>`)).join("")}</div>`
  );
  d.el.querySelectorAll("button[data-i]").forEach((b) => (b.onclick = () => {
    d.close();
    items[Number(b.dataset.i)].onClick();
  }));
  return d;
}

export const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const fmtDays = (d) => (d < 30 ? `${d}天` : d < 365 ? `${(d / 30).toFixed(1)}月` : `${(d / 365).toFixed(1)}年`);
