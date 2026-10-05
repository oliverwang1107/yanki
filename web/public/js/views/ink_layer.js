// 複習畫面的手寫層：疊在答案面上的畫布，Apple Pencil（或滑鼠）畫，手指仍可捲動、點按鈕。
// 平常畫布不攔截點擊（只負責顯示舊筆跡），按「✎」進入手寫模式後才接管 Pencil。
import { TOOLS, hits, saveStrokes, simplify, strokesOf } from "../ink.js";
import { toast } from "../ui.js";

let lastTool = "h"; // 記住上次的筆種，換下一張卡不用重選

export function mountInk(cardEl, card) {
  const body = cardEl.querySelector(".card-body");
  if (!body) return null;
  const strokes = strokesOf(card.id);
  const canvas = document.createElement("canvas");
  canvas.className = "ink-canvas";
  body.append(canvas);
  const bar = document.createElement("div");
  bar.className = "ink-bar";
  cardEl.append(bar);
  const ctx = canvas.getContext("2d");
  let on = false;
  let tool = lastTool; // h / r / b / e（橡皮擦）
  let current = null;
  let timer = 0;
  let dirty = false;
  let width = 1;

  const toPx = (v) => (v / 1000) * width;
  function drawStroke(s) {
    const t = TOOLS[s.k];
    ctx.strokeStyle = t.color;
    ctx.lineWidth = t.width;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    const p = s.p;
    ctx.moveTo(toPx(p[0]), toPx(p[1]));
    if (p.length === 2) ctx.lineTo(toPx(p[0]) + 0.1, toPx(p[1]));
    for (let i = 2; i < p.length - 2; i += 2) {
      // 以相鄰兩點的中點為終點畫二次曲線，線條會比較圓滑
      ctx.quadraticCurveTo(toPx(p[i]), toPx(p[i + 1]), toPx((p[i] + p[i + 2]) / 2), toPx((p[i + 1] + p[i + 3]) / 2));
    }
    if (p.length > 2) ctx.lineTo(toPx(p[p.length - 2]), toPx(p[p.length - 1]));
    ctx.stroke();
  }
  function redraw() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    for (const s of strokes) drawStroke(s);
    if (current && !current.erase) drawStroke(current);
  }
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    width = body.clientWidth || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(body.scrollHeight * dpr);
    canvas.style.height = `${body.scrollHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(body);

  async function flush() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    try {
      await saveStrokes(card.id, strokes);
    } catch (err) {
      toast(err.message);
    }
  }
  const touched = () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 1200); // 停筆一下才存，避免每一劃都寫一次
    renderBar();
  };

  // 座標以「內容寬度的千分之一」為單位
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / width) * 1000), Math.round(((e.clientY - r.top) / width) * 1000)];
  }
  const usable = (e) => e.pointerType !== "touch"; // 手指只負責捲動和點按，掌心碰到也不會亂畫

  function erase(x, y) {
    const keep = strokes.filter((s) => !hits(s, x, y, 14));
    if (keep.length === strokes.length) return;
    strokes.splice(0, strokes.length, ...keep);
    touched();
    redraw();
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!on || !usable(e)) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有對應的指標 */ }
    const [x, y] = point(e);
    if (tool === "e") {
      current = { erase: true };
      erase(x, y);
    } else {
      current = { k: tool, p: [x, y] };
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!current || !usable(e)) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = point(ev);
      if (current.erase) erase(x, y);
      else current.p.push(x, y);
    }
    if (!current.erase) redraw();
  });
  const finishStroke = () => {
    if (!current) return;
    if (!current.erase) {
      current.p = simplify(current.p);
      strokes.push(current);
      touched();
    }
    current = null;
    redraw();
  };
  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  // Safari 把 Pencil 的拖曳當成捲動；只擋 Pencil（stylus）的觸控事件，手指照常捲動。
  const blockStylus = (e) => {
    if (on && [...e.changedTouches].some((t) => t.touchType === "stylus")) e.preventDefault();
  };
  canvas.addEventListener("touchstart", blockStylus, { passive: false });
  canvas.addEventListener("touchmove", blockStylus, { passive: false });

  function setOn(v) {
    on = v;
    canvas.classList.toggle("on", on);
    cardEl.classList.toggle("inking", on);
    if (!on) flush();
    renderBar();
  }
  function renderBar() {
    if (!on) {
      bar.innerHTML = `<button type="button" data-ink="start" title="用 Apple Pencil 在卡片上畫螢光、圈選">✎ 手寫標記${strokes.length ? `（${strokes.length}）` : ""}</button>`;
      return;
    }
    const pick = (id, label) => `<button type="button" data-ink="${id}" class="${tool === id ? "sel" : ""}" aria-pressed="${tool === id}">${label}</button>`;
    bar.innerHTML = [
      ...Object.entries(TOOLS).map(([k, t]) => pick(k, t.label)),
      pick("e", "橡皮擦"),
      `<button type="button" data-ink="undo"${strokes.length ? "" : " disabled"}>↶</button>`,
      `<button type="button" data-ink="clear"${strokes.length ? "" : " disabled"}>清除</button>`,
      `<button type="button" data-ink="done">完成</button>`,
    ].join("");
  }
  bar.addEventListener("click", (e) => {
    const id = e.target.closest("[data-ink]")?.dataset.ink;
    if (!id) return;
    e.stopPropagation();
    if (id === "start") setOn(true);
    else if (id === "done") setOn(false);
    else if (id === "undo") {
      strokes.pop();
      touched();
      redraw();
    } else if (id === "clear") {
      strokes.length = 0;
      touched();
      redraw();
      toast("已清除這張卡的手寫標記");
    } else {
      tool = lastTool = id;
      renderBar();
    }
  });

  resize();
  renderBar();
  return {
    flush,
    destroy() {
      ro.disconnect();
      return flush();
    },
  };
}
