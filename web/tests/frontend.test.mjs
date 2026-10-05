// 前端邏輯的單元測試：node --test tests/
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as core from "../public/js/core.js";
import * as ops from "../public/js/ops.js";
import { plan } from "../public/js/plan.js";
import { SearchError, search } from "../public/js/search.js";

const { store, index, persist } = core;
const saved = { cards: 0, notes: 0 };
Object.assign(persist, {
  cards: async (rows) => void (saved.cards += rows.length),
  notes: async (rows) => void (saved.notes += rows.length),
  revlog: async () => {},
  removeRevlog: async () => {},
  static: async () => {},
});

const NT_BASIC = 1;
const NT_PLUS = 2;
let seq = 1000;

function resetCollection() {
  store.notes.clear(); store.cards.clear(); store.revlog.clear(); store.dict.clear();
  store.static = {
    meta: {},
    notetypes: [
      { id: NT_BASIC, name: "Basic", fields: ["Front", "Back"], qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}", css: "" },
      { id: NT_PLUS, name: "基本型+", fields: ["正面", "背面", "例句"], qfmt: "{{正面}}", afmt: "{{FrontSide}}<hr id=answer>{{背面}}", css: "" },
    ],
    decks: [
      { id: 10, name: "英文單字", config: 100 },
      { id: 11, name: "英文單字::L1", config: 101 },
      { id: 12, name: "英文單字::L2", config: 101 },
      { id: 13, name: "英文單字-P", config: 100 },
      { id: 14, name: "多益", config: 102 },
    ],
    configs: [
      { id: 100, name: "Default", newPerDay: 100, revPerDay: 1000, maxIvl: 100, desiredRetention: 0.9, learnSteps: [1, 10], relearnSteps: [10], minLapseIvl: 1, params: [] },
      { id: 101, name: "L1-L4", newPerDay: 3, revPerDay: 1000, maxIvl: 45, desiredRetention: 0.9, learnSteps: [1, 10], relearnSteps: [10], minLapseIvl: 1, params: [] },
      { id: 102, name: "TOEIC", newPerDay: 80, revPerDay: 800, maxIvl: 10, desiredRetention: 0.92, learnSteps: [1, 10], relearnSteps: [10], minLapseIvl: 1, params: [] },
    ],
  };
  saved.cards = saved.notes = 0;
  core.indexStatic();
}

function makeCard(fields, patch = {}, noteExtra = {}) {
  const nid = Date.now() + ++seq; // 真實的筆記編號是毫秒時間戳，added: 靠它判斷日期
  const mid = noteExtra.mid ?? NT_BASIC;
  store.notes.set(nid, { id: nid, guid: "g" + nid, mid, mod: Date.now(), tags: noteExtra.tags ?? "", fields, deleted: 0 });
  const card = {
    id: ++seq, nid, did: 11, ord: 0, type: 0, queue: 0, ivl: 0, reps: 0, lapses: 0, left: 0, mod: 0,
    s: null, d: null, lrt: null, pos: seq, due_ts: null, due_day: null, flags: 0, bury_day: null, deleted: 0, ...patch,
  };
  store.cards.set(card.id, card);
  return card;
}

const reviewCard = (fields, dueOffset, patch = {}, note = {}) =>
  makeCard(fields, { type: 2, queue: 2, ivl: 10, s: 10, d: 5, reps: 3, lrt: core.nowSec() - 86400 * 10, due_day: core.today() + dueOffset, ...patch }, note);

describe("search", () => {
  beforeEach(resetCollection);
  const ids = (q) => search(q).map((c) => c.id).sort();

  test("純文字、大小寫、HTML 與詞組", () => {
    const a = makeCard(["Remuneration", "報酬<br><span style='color:#777'>x</span>"]);
    const b = makeCard(["fair play", "公平"]);
    assert.deepEqual(ids("remun"), [a.id]);
    assert.deepEqual(ids("報酬"), [a.id]);
    assert.deepEqual(ids('"fair play"'), [b.id]);
    assert.deepEqual(ids("fair play"), [b.id]);
    assert.deepEqual(ids("fair remun"), []);
    assert.deepEqual(ids("span"), []); // 不會比對到 HTML 標籤
  });

  test("deck 含子牌組與萬用字元，且不誤傷 英文單字-P", () => {
    const l1 = makeCard(["a", "1"], { did: 11 });
    const l2 = makeCard(["b", "2"], { did: 12 });
    const p = makeCard(["c", "3"], { did: 13 });
    assert.deepEqual(ids("deck:英文單字"), [l1.id, l2.id]);
    assert.deepEqual(ids('deck:"英文單字::L1"'), [l1.id]);
    assert.deepEqual(ids("deck:英文單字*"), [l1.id, l2.id, p.id].sort());
    assert.deepEqual(ids("-deck:英文單字 deck:*P"), [p.id]);
  });

  test("tag、is:、flag、card、note", () => {
    const a = makeCard(["a", "1"], {}, { tags: "marked leech noun" });
    const b = makeCard(["b", "2"], { type: 1, queue: 1, due_ts: core.nowSec() - 5, flags: 3 });
    const c = reviewCard(["c", "3"], -2, { queue: -1 });
    const d = makeCard(["d", "4"], { queue: -3, bury_day: core.today() });
    assert.deepEqual(ids("tag:marked"), [a.id]);
    assert.deepEqual(ids("tag:noun is:marked"), [a.id]);
    assert.deepEqual(ids("tag:none"), ids("-tag:marked -tag:leech").filter((x) => x !== a.id));
    assert.deepEqual(ids("is:learn"), [b.id]);
    assert.deepEqual(ids("is:suspended"), [c.id]);
    assert.deepEqual(ids("is:buried"), [d.id]);
    assert.deepEqual(ids("is:new"), [a.id, d.id].sort());
    assert.deepEqual(ids("flag:3"), [b.id]);
    assert.deepEqual(ids("note:Basic card:1").length, 4);
    assert.deepEqual(ids("note:基本*"), []);
  });

  test("or、否定與括號", () => {
    const a = makeCard(["apple", "蘋果"]);
    const b = makeCard(["banana", "香蕉"]);
    const c = makeCard(["cherry", "櫻桃"]);
    assert.deepEqual(ids("apple or banana"), [a.id, b.id]);
    assert.deepEqual(ids("-apple -banana"), [c.id]);
    assert.deepEqual(ids("(apple or banana) -banana"), [a.id]);
    assert.deepEqual(ids("apple OR  cherry"), [a.id, c.id]);
    assert.deepEqual(ids('-"apple"'), [b.id, c.id]);
  });

  test("prop:、is:due、rated:、introduced:、added:", () => {
    const due = reviewCard(["due", "d"], 0, { ivl: 30 });
    const later = reviewCard(["later", "l"], 5, { ivl: 3 });
    const overdue = reviewCard(["over", "o"], -4, { ivl: 12, lapses: 2 });
    assert.deepEqual(ids("is:due"), [due.id, overdue.id].sort());
    assert.deepEqual(ids("prop:ivl>=12"), [due.id, overdue.id].sort());
    assert.deepEqual(ids("prop:due<0"), [overdue.id]);
    assert.deepEqual(ids("prop:due=5"), [later.id]);
    assert.deepEqual(ids("prop:lapses>0"), [overdue.id]);
    assert.deepEqual(ids("prop:ivl!=3 prop:due>=0"), [due.id]);
    const t = Date.now();
    store.revlog.set(t, { id: t, cid: due.id, ease: 1, ivl: 1, last_ivl: 0, time: 1, type: 1 });
    store.revlog.set(t - 3 * 86400000, { id: t - 3 * 86400000, cid: later.id, ease: 3, ivl: 1, last_ivl: 0, time: 1, type: 1 });
    assert.deepEqual(ids("rated:1"), [due.id]);
    assert.deepEqual(ids("rated:5"), [due.id, later.id].sort());
    assert.deepEqual(ids("rated:5:1"), [due.id]);
    assert.deepEqual(ids("introduced:1"), [due.id]);
    assert.equal(search("added:1").length, 3);
    assert.equal(search("prop:r<0.99").length, 3); // 有記憶狀態的卡都算得出可提取率
    assert.ok(search("prop:d>=0").length === 3);
  });

  test("欄位搜尋與 re:、w:", () => {
    const a = makeCard(["dog", "狗"], {}, { mid: NT_BASIC });
    const b = makeCard(["hotdog", "熱狗"]);
    const c = makeCard(["cat", "貓", "A cat sat."], {}, { mid: NT_PLUS });
    assert.deepEqual(ids("front:dog"), [a.id]);
    assert.deepEqual(ids("front:*dog"), [a.id, b.id].sort());
    assert.deepEqual(ids("正面:cat"), [c.id]);
    assert.deepEqual(ids("例句:*sat*"), [c.id]);
    assert.deepEqual(ids("nofield:dog"), []);
    assert.deepEqual(ids("re:^h.t"), [b.id]);
    assert.deepEqual(ids("w:dog"), [a.id]);
  });

  test("錯誤要給中文訊息", () => {
    for (const q of ["(apple", "apple)", '"abc', "is:nope", "prop:ivl", "prop:xyz>1", "rated:x", "flag:9"]) {
      assert.throws(() => search(q), SearchError, q);
    }
    assert.equal(search("").length, 0);
    makeCard(["a-b", "b"]);
    assert.equal(search("").length, 1);
    assert.equal(search("-").length, 1, "單獨一個減號是搜尋連字號");
  });
});

describe("ops", () => {
  beforeEach(resetCollection);

  test("暫停與恢復會依型態還原 queue", async () => {
    const n = makeCard(["n", "1"]);
    const l = makeCard(["l", "2"], { type: 1, queue: 1, due_ts: 5 });
    const r = reviewCard(["r", "3"], 0);
    const rl = reviewCard(["x", "4"], 0, { type: 3, queue: 1 });
    await ops.suspendCards([n, l, r, rl]);
    assert.deepEqual([n, l, r, rl].map((c) => c.queue), [-1, -1, -1, -1]);
    await ops.suspendCards([n, l, r, rl], false);
    assert.deepEqual([n, l, r, rl].map((c) => c.queue), [0, 1, 2, 1]);
    assert.ok(n.mod > 0, "mod 要更新才能同步");
  });

  test("擱置到隔天自動恢復", async () => {
    const c = reviewCard(["a", "b"], 0);
    await ops.buryCards([c]);
    assert.equal(c.queue, -3);
    assert.equal(await ops.unburyIfNeeded(), 0, "同一天不恢復");
    c.bury_day = core.today() - 1;
    assert.equal(await ops.unburyIfNeeded(), 1);
    assert.equal(c.queue, 2);
    const s = reviewCard(["s", "b"], 0, { queue: -1 });
    await ops.buryCards([s]);
    assert.equal(s.queue, -1, "暫停的卡不會被擱置蓋掉");
  });

  test("重設為新卡：排到最後、可選擇清除次數", async () => {
    const a = reviewCard(["a", "1"], 3, { reps: 5, lapses: 2 });
    const b = reviewCard(["b", "2"], 3, { reps: 4, lapses: 1 });
    const before = ops.nextNewPos();
    await ops.forgetCards([b, a]);
    assert.deepEqual([a.type, a.queue, a.s, a.due_day, a.reps, a.lapses], [0, 0, null, null, 5, 2]);
    assert.ok(a.pos >= before && b.pos > a.pos, "依建立順序排到最後");
    await ops.forgetCards([a], { resetCounts: true });
    assert.deepEqual([a.reps, a.lapses], [0, 0]);
  });

  test("設定到期日", async () => {
    const t = core.today();
    const r = reviewCard(["r", "1"], 20, { ivl: 20 });
    const n = makeCard(["n", "2"]);
    await ops.setDue([r], "0");
    assert.equal(r.due_day, t);
    assert.equal(r.ivl, 20, "沒有 ! 就不改間隔");
    await ops.setDue([r], "3!");
    assert.deepEqual([r.due_day, r.ivl], [t + 3, 3]);
    await ops.setDue([n], "2-4");
    assert.ok(n.due_day >= t + 2 && n.due_day <= t + 4);
    assert.deepEqual([n.type, n.queue], [2, 2]);
    assert.ok(n.s > 0 && n.d > 0, "新卡轉成複習卡要補上記憶狀態");
    assert.deepEqual([ops.parseDueSpec("abc"), ops.parseDueSpec("5-2"), ops.parseDueSpec("1-7!")?.setInterval], [null, null, true]);
    await assert.rejects(() => ops.setDue([r], "x"), /格式/);
  });

  test("從字典把片語加成新卡：自動建牌組、不重複", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ static_mod: 5 }) });
    try {
      const first = await ops.addPhraseCard("look forward to", "期待", "anticipate");
      assert.equal(first.added, true);
      const deck = store.static.decks.find((d) => d.name === ops.PHRASE_DECK);
      assert.ok(deck, "第一次加入要建立「字典片語」牌組");
      assert.equal(deck.config, 100);
      const note = [...store.notes.values()][0];
      assert.deepEqual(note.fields.slice(0, 2), ["look forward to", "期待"]);
      assert.equal(note.fields[2], "來自：anticipate");
      assert.equal([...store.cards.values()].find((c) => c.nid === note.id).did, deck.id);
      const again = await ops.addPhraseCard("Look forward to ", "期待");
      assert.equal(again.added, false);
      assert.equal(store.notes.size, 1);
      assert.equal(store.static.decks.filter((d) => d.name === ops.PHRASE_DECK).length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("新增、編輯、重複偵測、刪除", async () => {
    const { note, cards } = await ops.addNote({ mid: NT_PLUS, did: 14, fields: ["resilient", "有彈性的"], tags: "adj, new  adj" });
    assert.equal(note.tags, "adj new");
    assert.deepEqual(note.fields, ["resilient", "有彈性的", ""]);
    assert.equal(cards.length, 1);
    assert.deepEqual([cards[0].did, cards[0].type, cards[0].queue], [14, 0, 0]);
    assert.equal(store.notes.size, 1);
    assert.equal(ops.findDuplicates(NT_PLUS, " Resilient ").length, 1);
    assert.equal(ops.findDuplicates(NT_PLUS, "resilient", note.id).length, 0);
    await assert.rejects(() => ops.addNote({ mid: NT_PLUS, did: 14, fields: ["  ", "x"] }), /不能是空的/);
    await assert.rejects(() => ops.addNote({ mid: 999, did: 14, fields: ["x"] }), /筆記類型/);
    await assert.rejects(() => ops.addNote({ mid: NT_PLUS, did: 999, fields: ["x"] }), /牌組/);
    await ops.editNote(note, { fields: ["resilient", "堅韌的", "He is resilient."], tags: "adj" });
    assert.deepEqual([note.fields[1], note.fields[2], note.tags], ["堅韌的", "He is resilient.", "adj"]);
    const res = await ops.deleteNotes([note]);
    assert.deepEqual(res, { notes: 1, cards: 1 });
    assert.equal(store.notes.size + store.cards.size, 0, "刪除後不在記憶體裡");
  });

  test("標籤與標記", async () => {
    const a = makeCard(["a", "1"], {}, { tags: "x y" });
    const note = store.notes.get(a.nid);
    await ops.addTags([note], "z x");
    assert.equal(note.tags, "x y z");
    await ops.removeTags([note], "X z");
    assert.equal(note.tags, "y");
    assert.equal(await ops.toggleMark([note]), true);
    assert.ok(ops.tagList(note).includes("marked"));
    assert.equal(await ops.toggleMark([note]), false);
  });

  test("頑固卡與同卡擱置", async () => {
    const note = (c) => store.notes.get(c.nid);
    const c = reviewCard(["a", "1"], 0, { lapses: 7 });
    assert.equal(await ops.handleLeech(c), false);
    c.lapses = 8;
    assert.equal(await ops.handleLeech(c), true);
    assert.ok(ops.tagList(note(c)).includes("leech"));
    assert.equal(c.queue, 2, "預設只加標籤");
    c.lapses = 12;
    assert.equal(await ops.handleLeech(c), true, "之後每增加門檻的一半再觸發");
    c.lapses = 9;
    assert.equal(await ops.handleLeech(c), false);
    index.configById.get(101).leechAction = "suspend";
    c.lapses = 8;
    await ops.handleLeech(c);
    assert.equal(c.queue, -1);

    const a = makeCard(["a", "1"]);
    const sib = { ...a, id: ++seq, ord: 1 };
    store.cards.set(sib.id, sib);
    index.configById.get(101).buryNew = true;
    await ops.buryAfterAnswer(a);
    assert.equal(sib.queue, -2);
    assert.equal(a.queue, 0, "作答的這張自己不被擱置");
  });
});

describe("plan（每日上限）", () => {
  beforeEach(resetCollection);

  test("新卡上限依牌組、含上層牌組", () => {
    for (let i = 0; i < 6; i++) makeCard([`n${i}`, "x"], { did: 11, pos: i + 1 });
    for (let i = 0; i < 6; i++) makeCard([`m${i}`, "x"], { did: 12, pos: 100 + i });
    assert.equal(plan(11).new.length, 3, "L1 自己的上限 3");
    assert.equal(plan(12).new.length, 3);
    assert.equal(plan(10).new.length, 6, "從上層牌組讀 = 各子牌組各 3");
    assert.deepEqual(plan(11).new.map((c) => c.pos), [1, 2, 3], "依新卡順序");
  });

  test("今天讀過的算進上限", () => {
    const cards = [1, 2, 3, 4].map((i) => makeCard([`n${i}`, "x"], { did: 11, pos: i }));
    const t = Date.now();
    store.revlog.set(t, { id: t, cid: cards[0].id, ease: 3, ivl: -600, last_ivl: 0, time: 1, type: 0 });
    cards[0].type = 1; cards[0].queue = 1; cards[0].due_ts = core.nowSec() + 600;
    assert.equal(plan(11).new.length, 2, "上限 3 已用掉 1");
    store.revlog.set(t + 1, { id: t + 1, cid: cards[0].id, ease: 3, ivl: -600, last_ivl: -600, time: 1, type: 0 });
    assert.equal(plan(11).new.length, 2, "同一張卡的後續學習步驟不算新卡");
  });

  test("暫停與擱置的卡不出現；複習依到期日排序", () => {
    const a = reviewCard(["a", "1"], -3, { did: 14 });
    const b = reviewCard(["b", "2"], 0, { did: 14 });
    reviewCard(["c", "3"], 0, { did: 14, queue: -1 });
    reviewCard(["d", "4"], 0, { did: 14, queue: -3 });
    reviewCard(["e", "5"], 2, { did: 14 });
    assert.deepEqual(plan(14).rev.map((c) => c.id), [a.id, b.id]);
  });

  test("新卡隨機順序設定", () => {
    index.configById.get(101).newOrder = "random";
    for (let i = 0; i < 12; i++) makeCard([`n${i}`, "x"], { did: 12, pos: i + 1 });
    index.configById.get(101).newPerDay = 12;
    const orders = new Set();
    for (let k = 0; k < 8; k++) orders.add(plan(12).new.map((c) => c.pos).join());
    assert.ok(orders.size > 1, "隨機順序每次不同");
  });
});
