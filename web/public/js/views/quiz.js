// 快測：用字典內容出選擇題（同義字、反義字、英文釋義、例句填空），練習用，不會改動複習排程。
// 目的是用不同的角度再看一次單字，補強只靠「看中文想英文」記不牢的部分。
import { index, inTree, shortName, store, stripHtml } from "../core.js";
import { addTags } from "../ops.js";
import { buildQuiz } from "../quizgen.js";
import { englishOf, speak, ttsAvailable } from "../tts.js";
import { esc, setHeader, toast } from "../ui.js";

const KIND_LABEL = { syn: "同義字", ant: "反義字", def: "英文釋義", cloze: "例句填空" };
const MIN_ITEMS = 6;

// 從牌組裡挑出「有字典內容」的單字。learnedOnly：只要學過的（不是全新卡）。
function collect(deckId, learnedOnly) {
  const root = deckId ? index.deckById.get(deckId) : null;
  const inScope = (did) => !root || inTree(index.deckById.get(did) ?? { name: "" }, root);
  const seen = new Set();
  const items = [];
  for (const card of store.cards.values()) {
    if (card.deleted || !inScope(card.did) || (learnedOnly && card.type === 0)) continue;
    const dict = store.dict.get(card.nid);
    const note = store.notes.get(card.nid);
    if (!dict || !note) continue;
    const word = englishOf(note.fields[0]).trim();
    if (!word || word.length > 30 || word.split(/\s+/).length > 3 || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    const nt = index.noteTypeById.get(note.mid);
    const exIndex = nt?.fields.indexOf("例句") ?? -1;
    const example = (exIndex >= 0 ? englishOf(note.fields[exIndex]) : "") || dict.ex?.[0] || "";
    const zh = stripHtml(note.fields[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    items.push({ nid: card.nid, word, zh, example, dict, pos: /^([a-z]+)\./i.exec(zh)?.[1]?.toLowerCase() ?? "" });
  }
  return items;
}

export function mount(el, params) {
  setHeader({ title: "快測", back: "#/" });
  let settings = { deck: Number(params?.get("deck")) || 0, count: 10, learnedOnly: true };
  let cleanup = () => {};

  function start() {
    cleanup();
    const optionRow = (d) => {
      const n = collect(d.id, false).length;
      return n ? `<option value="${d.id}"${settings.deck === d.id ? " selected" : ""}>${"　".repeat(d.name.split("::").length - 1)}${esc(shortName(d))}（${n} 個字）</option>` : "";
    };
    const avail = collect(settings.deck, settings.learnedOnly).length;
    el.innerHTML = `<div class="card-box">
        <h3 style="margin-bottom:4px">用字典出題，快速測自己</h3>
        <p class="hint" style="margin:0 0 10px">同義字、反義字、英文釋義、例句填空，每題 4 個選項。只是練習，不會影響複習排程。</p>
        <label for="q-deck">範圍</label>
        <select id="q-deck"><option value="0">全部牌組</option>${index.decks.map(optionRow).join("")}</select>
        <label for="q-count">題數</label>
        <select id="q-count">${[10, 20, 30].map((n) => `<option value="${n}"${settings.count === n ? " selected" : ""}>${n} 題</option>`).join("")}</select>
        <label class="check"><input type="checkbox" id="q-learned"${settings.learnedOnly ? " checked" : ""}>只考我學過的字</label>
        <p class="hint" id="q-info">${avail >= MIN_ITEMS ? `可以出題的字有 ${avail} 個。` : `可以出題的字只有 ${avail} 個，至少要 ${MIN_ITEMS} 個。${settings.learnedOnly ? "先多複習幾張，或取消「只考我學過的字」。" : "字典內容還不夠多。"}`}</p>
        <button class="btn primary-btn" id="q-go" style="width:100%;margin-top:12px;min-height:48px"${avail >= MIN_ITEMS ? "" : " disabled"}>開始</button>
      </div>`;
    const read = () => {
      settings = { deck: Number(el.querySelector("#q-deck").value), count: Number(el.querySelector("#q-count").value), learnedOnly: el.querySelector("#q-learned").checked };
    };
    el.querySelectorAll("select, input").forEach((x) => (x.onchange = () => (read(), start())));
    el.querySelector("#q-go").onclick = () => {
      read();
      const quiz = buildQuiz(collect(settings.deck, settings.learnedOnly), settings.count);
      if (quiz.length < 3) return toast("字典內容不夠，湊不出題目");
      run(quiz);
    };
  }

  function run(quiz) {
    let i = 0;
    let right = 0;
    const missed = [];
    let answered = false;

    const onKey = (e) => {
      if (e.target instanceof Element && e.target.closest("input,textarea,select")) return;
      if (/^[1-4]$/.test(e.key) && !answered) choose(Number(e.key) - 1);
      else if ((e.key === " " || e.key === "Enter") && answered) (e.preventDefault(), next());
    };
    document.addEventListener("keydown", onKey);
    cleanup = () => document.removeEventListener("keydown", onKey);

    function show() {
      answered = false;
      const q = quiz[i];
      el.innerHTML = `<div class="quiz-top"><span>${i + 1} / ${quiz.length}</span><div class="progress"><div style="width:${(i / quiz.length) * 100}%"></div></div><span>答對 ${right}</span></div>
        <div class="card-body quiz-q"><div class="quiz-kind">${KIND_LABEL[q.kind]}</div><div class="quiz-prompt">${esc(q.prompt)}</div></div>
        <div class="quiz-opts">${q.options.map((o, k) => `<button class="opt" data-i="${k}"><kbd>${k + 1}</kbd><span>${esc(o)}</span></button>`).join("")}</div>
        <div id="fb" hidden></div>`;
      el.querySelector(".quiz-opts").onclick = (e) => {
        const b = e.target.closest(".opt");
        if (b && !answered) choose(Number(b.dataset.i));
      };
    }

    function choose(k) {
      answered = true;
      const q = quiz[i];
      const good = k === q.answer;
      if (good) right++;
      else missed.push(q);
      el.querySelectorAll(".opt").forEach((b, n) => {
        b.disabled = true;
        if (n === q.answer) b.classList.add("ok");
        else if (n === k) b.classList.add("bad");
      });
      const fb = el.querySelector("#fb");
      fb.hidden = false;
      fb.innerHTML = `<div class="quiz-fb ${good ? "ok" : "bad"}"><b>${good ? "答對了" : "答錯了"}</b><div>${esc(q.explain)}</div>
        <div class="row" style="margin-top:10px">${ttsAvailable() ? `<button class="btn" id="say">🔊 ${esc(q.word)}</button>` : ""}<span class="grow"></span><button class="btn primary-btn" id="next" style="min-height:44px">${i + 1 < quiz.length ? "下一題" : "看結果"}</button></div></div>`;
      fb.querySelector("#next").onclick = next;
      fb.querySelector("#say")?.addEventListener("click", () => speak(q.word));
      fb.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    function next() {
      if (++i < quiz.length) show();
      else summary();
    }

    function summary() {
      cleanup();
      const pct = Math.round((right / quiz.length) * 100);
      el.innerHTML = `<div class="card-box" style="text-align:center">
          <div style="font-size:44px;font-weight:700">${right} / ${quiz.length}</div>
          <div class="muted">${pct >= 90 ? "太強了！" : pct >= 70 ? "不錯喔，再接再厲" : "沒關係，錯的字再看一次就會記得"}</div></div>
        ${missed.length ? `<h2>答錯的字（${missed.length}）</h2>${missed.map((q) => `<div class="card-box"><b>${esc(q.word)}</b> <span class="muted">${esc(q.zh)}</span><div class="muted small" style="margin-top:4px">${esc(q.explain)}</div></div>`).join("")}` : ""}
        <div class="row" style="flex-wrap:wrap;margin-top:12px">
          <button class="btn primary-btn" id="again" style="min-height:44px">再測一次</button>
          ${missed.length ? `<button class="btn" id="tag" style="min-height:44px">標記答錯的字</button>` : ""}
          <button class="btn" id="back" style="min-height:44px">回牌組</button></div>
        ${missed.length ? `<p class="hint">「標記」會替這些筆記加上 quiz-miss 標籤，之後可以在瀏覽頁搜尋 <code>tag:quiz-miss</code> 集中複習。</p>` : ""}`;
      el.querySelector("#again").onclick = start;
      el.querySelector("#back").onclick = () => (location.hash = "#/");
      el.querySelector("#tag")?.addEventListener("click", async (e) => {
        const notes = [...new Set(missed.map((q) => store.notes.get(q.nid)).filter(Boolean))];
        await addTags(notes, "quiz-miss");
        e.target.disabled = true;
        toast(`已標記 ${notes.length} 個字`);
      });
    }

    show();
  }

  start();
  return () => cleanup();
}
