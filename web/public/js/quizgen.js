// 快測的出題邏輯（純函式，不碰畫面和資料庫，所以可以用 node 測試）。
// 題型都從字典內容出：同義字、反義字、英文釋義選單字、例句填空。每題 4 個選項。

const norm = (s) => String(s).toLowerCase().trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pick = (list, rand) => list[Math.floor(rand() * list.length)];

// 從 pool 裡挑 k 個互不相同、且不在 forbidden 裡的；湊不滿就回 null（這個題型就不出）。
function distractors(pool, forbidden, k, rand, ordered = false) {
  const seen = new Set(forbidden.map(norm));
  const out = [];
  for (const w of ordered ? pool : shuffle(pool, rand)) {
    if (seen.has(norm(w))) continue;
    seen.add(norm(w));
    out.push(w);
    if (out.length === k) return out;
  }
  return null;
}

// 把例句裡的目標字挖空。單字可能變化（abandon → abandoned），所以比對字根；挖不到就回 null。
export function cloze(sentence, word) {
  if (!sentence || !/^[A-Za-z][A-Za-z' -]*$/.test(word) || word.includes(" ")) return null;
  // 長單字比對字根（abandon → abandoned）；短單字只接受常見字尾，免得 bare 挖到 barn、barefoot
  const re = word.length <= 4 ? `\\b${esc(word)}(?:s|es|ed|d|ing)?\\b` : `\\b${esc(word.slice(0, word.length - 2))}[A-Za-z]*`;
  const m = new RegExp(re, "i").exec(sentence);
  if (!m) return null;
  return { text: sentence.slice(0, m.index) + "＿＿＿＿" + sentence.slice(m.index + m[0].length), form: m[0] };
}

// 干擾的單字優先挑同詞性的（動詞題配動詞），比隨便挑的字難，也比較像真的考試。
function sameKindFirst(items, it, rand) {
  const others = items.filter((x) => x.word !== it.word);
  const same = (x) => x.pos && x.pos === it.pos;
  return [...shuffle(others.filter(same), rand), ...shuffle(others.filter((x) => !same(x)), rand)].map((x) => x.word);
}

const TYPES = {
  syn: {
    ok: (it) => it.dict?.syn?.length > 0,
    make(it, ctx, rand) {
      const correct = pick(it.dict.syn, rand);
      const bad = distractors(ctx.relatedPool, [it.word, ...it.dict.syn, ...(it.dict.ant ?? [])], 3, rand);
      return bad && { prompt: `「${it.word}」的同義字是？`, correct, bad, explain: `${it.word} ≈ ${it.dict.syn.join("、")}` };
    },
  },
  ant: {
    ok: (it) => it.dict?.ant?.length > 0,
    make(it, ctx, rand) {
      const correct = pick(it.dict.ant, rand);
      const forbidden = [it.word, ...it.dict.ant, ...(it.dict.syn ?? [])];
      // 放一個同義字當陷阱，才真的測得出有沒有搞懂「相反」
      const trap = it.dict.syn?.length ? [pick(it.dict.syn, rand)] : [];
      const rest = distractors(ctx.relatedPool, forbidden, 3 - trap.length, rand);
      return rest && { prompt: `「${it.word}」的反義字是？`, correct, bad: [...trap, ...rest], explain: `${it.word} ↔ ${it.dict.ant.join("、")}` };
    },
  },
  def: {
    ok: (it) => (it.dict?.en ?? "").length >= 12 && (it.dict.en ?? "").length <= 220,
    make(it, ctx, rand) {
      const bad = distractors(sameKindFirst(ctx.items, it, rand), [it.word], 3, rand, true);
      return bad && { prompt: `哪個字的意思是：${it.dict.en}`, correct: it.word, bad, explain: `${it.word}：${it.zh}` };
    },
  },
  cloze: {
    ok: (it) => !!cloze(it.example, it.word),
    make(it, ctx, rand) {
      const c = cloze(it.example, it.word);
      const bad = distractors(sameKindFirst(ctx.items, it, rand), [it.word], 3, rand, true);
      return bad && { prompt: `選出適合填入空格的字：${c.text}`, correct: it.word, bad, explain: `${it.example}${it.zh ? `（${it.word}：${it.zh}）` : ""}` };
    },
  },
};

// items：[{ nid, word, zh, example, dict }]；回傳最多 count 題。
export function buildQuiz(items, count, rand = Math.random) {
  const relatedPool = [...new Set(items.flatMap((i) => [...(i.dict?.syn ?? []), ...(i.dict?.ant ?? [])]))];
  const out = [];
  let last = null;
  for (const it of shuffle(items, rand)) {
    if (out.length >= count) break;
    // 相鄰兩題盡量不同題型；某個題型湊不出選項就換下一個
    const kinds = shuffle(Object.keys(TYPES), rand).sort((a, b) => (a === last) - (b === last));
    for (const kind of kinds) {
      if (!TYPES[kind].ok(it)) continue;
      const q = TYPES[kind].make(it, { items, relatedPool }, rand);
      if (!q) continue;
      const options = shuffle([q.correct, ...q.bad], rand);
      out.push({ nid: it.nid, word: it.word, zh: it.zh, kind, prompt: q.prompt, options, answer: options.indexOf(q.correct), explain: q.explain });
      last = kind;
      break;
    }
  }
  return out;
}
