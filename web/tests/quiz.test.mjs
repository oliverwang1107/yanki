import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildQuiz, cloze, shuffle } from "../public/js/quizgen.js";

// 固定亂數：每次結果一樣，測試才不會偶爾失敗
const seeded = (seed = 1) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const items = [
  { nid: 1, word: "abandon", zh: "拋棄", example: "The company decided to abandon the failed project.", dict: { syn: ["desert", "forsake"], ant: ["keep", "retain"], en: "to leave someone or something completely and for ever" } },
  { nid: 2, word: "mitigate", zh: "減輕", example: "The policy aims to mitigate climate change.", dict: { syn: ["alleviate", "lessen"], ant: ["aggravate", "worsen"], en: "to make something less severe, serious or painful" } },
  { nid: 3, word: "reliable", zh: "可靠的", example: "He is a reliable worker who is never late.", dict: { syn: ["dependable", "steady"], ant: ["unreliable", "erratic"], en: "able to be trusted or depended on; working well and consistently" } },
  { nid: 4, word: "scarce", zh: "稀少的", example: "Fresh water is becoming scarce in many parts of the world.", dict: { syn: ["rare", "sparse"], ant: ["plentiful", "ample"], en: "not available in large enough amounts to satisfy demand" } },
  { nid: 5, word: "tighten", zh: "勒緊", example: "The government decided to tighten security at the airport.", dict: { syn: ["tense", "stiffen"], ant: ["loosen", "relax"], en: "to make something tighter; to become tighter or stricter" } },
  { nid: 6, word: "bare", zh: "赤裸的", dict: {} },
];

describe("cloze 例句挖空", () => {
  it("挖掉原形和變化形", () => {
    assert.deepEqual(cloze("They abandoned the plan.", "abandon"), { text: "They ＿＿＿＿ the plan.", form: "abandoned" });
    assert.equal(cloze("The company decided to abandon it.", "abandon").form, "abandon");
  });
  it("找不到、片語、非英文都回 null", () => {
    assert.equal(cloze("Nothing here.", "abandon"), null);
    assert.equal(cloze("He took up the offer.", "take up"), null);
    assert.equal(cloze(null, "abandon"), null);
    assert.equal(cloze("這是中文", "中文"), null);
  });
  it("短單字不會挖到別的字的一部分", () => {
    assert.equal(cloze("This is a barefoot walk near the barn.", "bare"), null);
    assert.equal(cloze("He bares his soul.", "bare").form, "bares");
  });
});

describe("buildQuiz 出題", () => {
  const quiz = buildQuiz(items, 10, seeded(7));

  it("題數不超過 count，也不超過能出題的字數", () => {
    assert.ok(quiz.length > 0 && quiz.length <= 5);
    assert.equal(buildQuiz(items, 2, seeded(3)).length, 2);
  });
  it("每題 4 個不同的選項，答案索引正確且在選項裡", () => {
    for (const q of quiz) {
      assert.equal(q.options.length, 4);
      assert.equal(new Set(q.options.map((o) => o.toLowerCase())).size, 4, q.prompt);
      assert.ok(q.answer >= 0 && q.answer < 4);
      assert.ok(q.prompt.length > 0 && q.explain.length > 0);
    }
  });
  it("同義字題的答案真的是這個字的同義字，干擾項不是", () => {
    for (let seed = 1; seed < 40; seed++) {
      for (const q of buildQuiz(items, 5, seeded(seed)).filter((x) => x.kind === "syn")) {
        const src = items.find((i) => i.nid === q.nid);
        assert.ok(src.dict.syn.includes(q.options[q.answer]));
        q.options.forEach((o, i) => i !== q.answer && assert.ok(!src.dict.syn.includes(o) && !src.dict.ant.includes(o) && o !== src.word, `${src.word}: ${o}`));
      }
    }
  });
  it("反義字題會放一個同義字當陷阱，且答案是真的反義字", () => {
    let seen = 0;
    for (let seed = 1; seed < 60; seed++) {
      for (const q of buildQuiz(items, 5, seeded(seed)).filter((x) => x.kind === "ant")) {
        const src = items.find((i) => i.nid === q.nid);
        assert.ok(src.dict.ant.includes(q.options[q.answer]));
        assert.ok(q.options.some((o) => src.dict.syn.includes(o)), "要有一個同義字陷阱");
        seen++;
      }
    }
    assert.ok(seen > 0);
  });
  it("釋義題和填空題的答案就是那個單字", () => {
    let seen = 0;
    for (let seed = 1; seed < 60; seed++) {
      for (const q of buildQuiz(items, 5, seeded(seed)).filter((x) => x.kind === "def" || x.kind === "cloze")) {
        assert.equal(q.options[q.answer], items.find((i) => i.nid === q.nid).word);
        if (q.kind === "cloze") assert.match(q.prompt, /＿＿＿＿/);
        seen++;
      }
    }
    assert.ok(seen > 0);
  });
  it("沒有字典內容的字不會出題；字太少湊不出選項就不出", () => {
    assert.ok(!buildQuiz(items, 10, seeded(5)).some((q) => q.nid === 6));
    assert.equal(buildQuiz(items.slice(0, 2), 5, seeded(1)).filter((q) => q.kind === "def" || q.kind === "cloze").length, 0);
    assert.deepEqual(buildQuiz([], 5), []);
  });
  it("相鄰題目盡量不同題型", () => {
    let same = 0, total = 0;
    for (let seed = 1; seed < 50; seed++) {
      const q = buildQuiz(items, 5, seeded(seed));
      for (let i = 1; i < q.length; i++) { total++; if (q[i].kind === q[i - 1].kind) same++; }
    }
    assert.ok(same / total < 0.4, `${same}/${total}`);
  });
});

describe("干擾項優先同詞性", () => {
  const mk = (word, pos) => ({ nid: word.length * 100 + word.charCodeAt(0), word, pos, zh: `${pos}. x`, dict: { en: "a definition that is long enough to be used" } });
  const pool = [mk("run", "v"), mk("walk", "v"), mk("jump", "v"), mk("swim", "v"), mk("table", "n"), mk("chair", "n"), mk("happy", "a"), mk("quick", "a")];
  it("有足夠的同詞性字時，3 個干擾項全是同詞性", () => {
    for (let seed = 1; seed < 30; seed++) {
      for (const q of buildQuiz(pool, 8, seeded(seed)).filter((x) => x.kind === "def")) {
        const src = pool.find((i) => i.nid === q.nid);
        if (src.pos !== "v") continue;
        q.options.forEach((o) => assert.equal(pool.find((i) => i.word === o).pos, "v", `${src.word}: ${o}`));
      }
    }
  });
  it("同詞性不夠時用別的詞性補滿", () => {
    const q = buildQuiz(pool, 8, seeded(4)).find((x) => x.kind === "def" && pool.find((i) => i.nid === x.nid).pos === "a");
    if (q) assert.equal(q.options.length, 4);
  });
});

describe("shuffle", () => {
  it("不改動原陣列，結果是同一批元素", () => {
    const a = [1, 2, 3, 4, 5];
    const b = shuffle(a, seeded(2));
    assert.deepEqual(a, [1, 2, 3, 4, 5]);
    assert.deepEqual([...b].sort(), a);
  });
});
