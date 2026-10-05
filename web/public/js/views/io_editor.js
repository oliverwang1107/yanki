// 圖片遮蓋的編輯器：在圖片上拖曳畫出矩形／橢圓遮蓋區域（Apple Pencil、手指、滑鼠都可以），
// 每個區域屬於一個「群組」，同一個群組會一起遮住、一起揭開，也就是同一張卡。
// 區域存成 Anki 相容的文字（{{c1::image-occlusion:rect:left=…}}），放在筆記的 Occlusion 欄位。
import { parseOcclusion, stringifyOcclusion } from "../cards.js";
import { fixMediaSrc } from "../render.js";
import { esc } from "../ui.js";

const PALETTE = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const MIN = 0.012; // 太小的區域視為誤觸，不建立

const imageSrc = (html) => {
  const m = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/i.exec(html ?? "");
  if (!m) return "";
  return /src\s*=\s*["']([^"']+)["']/i.exec(fixMediaSrc(m[0]))?.[1] ?? "";
};

// host：放編輯器的元素；io：{ image(): Image 欄位的 HTML, read(): Occlusion 欄位文字, write(text) }
export function mountOcclusionEditor(host, io) {
  let shapes = [];
  let tool = "rect"; // rect｜ellipse｜select
  let hideAll = true;
  let together = false; // 新畫的區域併入上一個群組
  let selected = -1;
  let draft = null;
  let loadedSrc = null;

  const lastGroup = () => shapes.reduce((m, s) => Math.max(m, s.group), 0);
  const color = (g) => PALETTE[(g - 1) % PALETTE.length];

  function commit() {
    io.write(stringifyOcclusion(shapes));
    draw();
  }

  function shapeSvg(s, i, isDraft = false) {
    const c = color(s.group);
    const sel = i === selected;
    const style = `fill="${c}" fill-opacity="${isDraft ? 0.25 : 0.4}" stroke="${sel ? "#111" : c}" stroke-width="${sel ? 3 : 1.6}" vector-effect="non-scaling-stroke"${sel ? ` stroke-dasharray="6 3"` : ""}`;
    if (s.points) return `<polygon data-i="${i}" points="${s.points.map((p) => p.join(",")).join(" ")}" ${style}/>`;
    if (s.rx !== undefined) return `<ellipse data-i="${i}" cx="${s.x + s.rx}" cy="${s.y + s.ry}" rx="${s.rx}" ry="${s.ry}" ${style}/>`;
    return `<rect data-i="${i}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" ${style}/>`;
  }
  const center = (s) => (s.points ? [s.points.reduce((a, p) => a + p[0], 0) / s.points.length, s.points.reduce((a, p) => a + p[1], 0) / s.points.length] : s.rx !== undefined ? [s.x + s.rx, s.y + s.ry] : [s.x + s.w / 2, s.y + s.h / 2]);

  function draw() {
    const src = imageSrc(io.image());
    if (!src) {
      host.innerHTML = `<p class="hint">先用上面「圖片」欄位的 🖼 按鈕加入一張圖片，再回來畫遮蓋區域。</p>`;
      loadedSrc = null;
      return;
    }
    const groups = [...new Set(shapes.map((s) => s.group))].sort((a, b) => a - b);
    host.innerHTML = `
      <div class="io-tools">
        <button type="button" data-tool="rect" class="${tool === "rect" ? "sel" : ""}">▭ 矩形</button>
        <button type="button" data-tool="ellipse" class="${tool === "ellipse" ? "sel" : ""}">◯ 橢圓</button>
        <button type="button" data-tool="select" class="${tool === "select" ? "sel" : ""}">☝ 選取</button>
        <button type="button" data-act="del" ${selected < 0 ? "disabled" : ""}>刪除</button>
        <button type="button" data-act="clear" ${shapes.length ? "" : "disabled"}>全部清除</button>
      </div>
      <div class="io-tools">
        <label class="check"><input type="checkbox" data-opt="together" ${together ? "checked" : ""}>新區域併入上一組（同一張卡）</label>
        <label class="check"><input type="checkbox" data-opt="hideAll" ${hideAll ? "checked" : ""}>隱藏全部、猜一個</label>
        ${selected >= 0 ? `<label class="check">這個區域的組別 <input type="number" min="1" max="99" value="${shapes[selected].group}" data-group style="width:4em"></label>` : ""}
      </div>
      <div class="io-edit-stage" style="touch-action:none">
        <img src="${esc(src)}" draggable="false" alt="">
        <svg viewBox="0 0 1 1" preserveAspectRatio="none">${shapes.map((s, i) => shapeSvg(s, i)).join("")}${draft ? shapeSvg(draft, -1, true) : ""}</svg>
        ${shapes.map((s) => { const [cx, cy] = center(s); return `<span class="io-badge" style="left:${cx * 100}%;top:${cy * 100}%;background:${color(s.group)}">${s.group}</span>`; }).join("")}
      </div>
      <p class="hint">${groups.length ? `共 ${shapes.length} 個區域、${groups.length} 張卡片。` : "在圖片上拖曳畫出要遮住的區域。"}每個組別會產生一張卡片。</p>`;
    loadedSrc = src;
  }

  const frac = (e, stage) => {
    const r = stage.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  let start = null;

  host.addEventListener("pointerdown", (e) => {
    const stage = e.target.closest(".io-edit-stage");
    if (!stage) return;
    if (tool === "select") {
      const hit = e.target.closest("[data-i]");
      selected = hit ? Number(hit.dataset.i) : -1;
      draw();
      return;
    }
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有對應的指標 */ }
    start = frac(e, stage);
    draft = null;
  });
  host.addEventListener("pointermove", (e) => {
    const stage = e.target.closest(".io-edit-stage");
    if (!start || !stage) return;
    const [x, y] = frac(e, stage);
    const [x0, y0] = start;
    const left = Math.min(x, x0), top = Math.min(y, y0), w = Math.abs(x - x0), h = Math.abs(y - y0);
    const group = together && shapes.length ? lastGroup() : lastGroup() + 1;
    draft = tool === "ellipse" ? { group, hideAll, x: left, y: top, rx: w / 2, ry: h / 2 } : { group, hideAll, x: left, y: top, w, h };
    const svg = stage.querySelector("svg");
    svg.querySelector("[data-draft]")?.remove();
    svg.insertAdjacentHTML("beforeend", shapeSvg(draft, -1, true).replace(" data-i=\"-1\"", " data-draft"));
  });
  const finish = () => {
    if (!start) return;
    start = null;
    const d = draft;
    draft = null;
    if (d && (d.rx !== undefined ? d.rx * 2 > MIN && d.ry * 2 > MIN : d.w > MIN && d.h > MIN)) {
      shapes.push(d);
      selected = -1;
      commit();
    } else draw();
  };
  host.addEventListener("pointerup", finish);
  host.addEventListener("pointercancel", finish);

  host.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tool],[data-act]");
    if (!t) return;
    if (t.dataset.tool) { tool = t.dataset.tool; if (tool !== "select") selected = -1; draw(); }
    else if (t.dataset.act === "del" && selected >= 0) { shapes.splice(selected, 1); selected = -1; commit(); }
    else if (t.dataset.act === "clear") { shapes = []; selected = -1; commit(); }
  });
  host.addEventListener("change", (e) => {
    if (e.target.dataset.opt === "together") together = e.target.checked;
    else if (e.target.dataset.opt === "hideAll") {
      hideAll = e.target.checked;
      shapes.forEach((s) => (s.hideAll = hideAll));
      commit();
    } else if ("group" in e.target.dataset && selected >= 0) {
      shapes[selected].group = Math.max(1, Math.min(99, Number(e.target.value) || 1));
      commit();
    }
  });

  return {
    // 欄位被改過（換圖片、手動改遮蓋資料）時重新讀取
    refresh() {
      const parsed = parseOcclusion(io.read());
      if (stringifyOcclusion(parsed) !== stringifyOcclusion(shapes)) {
        shapes = parsed;
        if (selected >= shapes.length) selected = -1;
        if (shapes.length) hideAll = shapes[0].hideAll !== false;
      }
      if (imageSrc(io.image()) !== loadedSrc || !host.firstChild) draw();
    },
  };
}
