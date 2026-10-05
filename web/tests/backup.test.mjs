// 備份與還原：node --test tests/
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as backup from "../public/js/backup.js";
import * as core from "../public/js/core.js";

const { store, persist } = core;
const calls = { cards: 0, notes: 0, revlog: 0, ink: 0, static: 0 };
Object.assign(persist, {
  cards: async (rows) => void (calls.cards += rows.length),
  notes: async (rows) => void (calls.notes += rows.length),
  revlog: async (rows) => void (calls.revlog += rows.length),
  ink: async (rows) => void (calls.ink += rows.length),
  removeRevlog: async () => {},
  static: async () => void calls.static++,
});
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ static_mod: 9 }) });

const note = (id, front, patch = {}) => ({ id, guid: "g" + id, mid: 1, mod: 1000, tags: "", fields: [front, "x"], deleted: 0, ...patch });
const card = (id, nid, patch = {}) => ({
  id, nid, did: 10, ord: 0, type: 0, queue: 0, ivl: 0, reps: 0, lapses: 0, left: 0, mod: 1000,
  s: null, d: null, lrt: null, pos: id, due_ts: null, due_day: null, flags: 0, bury_day: null, deleted: 0, ...patch,
});

function seed() {
  store.notes.clear(); store.cards.clear(); store.revlog.clear(); store.ink.clear(); store.dict.clear();
  store.static = {
    meta: { static_mod: "1" },
    notetypes: [{ id: 1, name: "Basic", fields: ["Front", "Back"], qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}", css: "" }],
    decks: [{ id: 10, name: "A", config: 100 }, { id: 11, name: "B", config: 100 }],
    configs: [{ id: 100, name: "Default", newPerDay: 20 }],
  };
  core.indexStatic();
  for (const [nid, cid, front] of [[1, 101, "apple"], [2, 102, "banana"], [3, 103, "cherry"]]) {
    store.notes.set(nid, note(nid, front));
    store.cards.set(cid, card(cid, nid));
  }
  store.revlog.set(5001, { id: 5001, cid: 101, ease: 3, ivl: 1, last_ivl: 0, time: 3000, type: 0 });
  store.ink.set(101, { id: 101, mod: 1000, data: '{"s":[]}', deleted: 0 });
  Object.keys(calls).forEach((k) => (calls[k] = 0));
}

const snapshot = () => JSON.parse(JSON.stringify(backup.makeBackup()));

describe("備份檔", () => {
  beforeEach(seed);

  test("存成 JSON 再讀回來", () => {
    const b = backup.parseBackup(backup.backupJson());
    assert.equal(b.version, backup.BACKUP_VERSION);
    assert.deepEqual([b.notes.length, b.cards.length, b.revlog.length, b.ink.length], [3, 3, 1, 1]);
    assert.equal(b.static.decks.length, 2);
  });

  test("格式不對的檔案給看得懂的錯誤", () => {
    assert.throws(() => backup.parseBackup("hello"), /不是有效的備份檔/);
    assert.throws(() => backup.parseBackup("{}"), /不是這個 App 的備份檔/);
    assert.throws(() => backup.parseBackup(JSON.stringify({ notes: [], cards: [], static: {} })), /缺少/);
    assert.throws(() => backup.parseBackup(JSON.stringify({ version: 99, notes: [], cards: [], static: { notetypes: [], decks: [], configs: [] } })), /更新 App/);
  });

  test("沒有變動時，兩種還原都不需要做任何事", () => {
    const b = snapshot();
    for (const mode of ["merge", "replace"]) {
      const p = backup.planRestore(b, mode);
      assert.equal(backup.planTotal(p), 0);
      assert.equal(p.static, null);
    }
  });
});

describe("還原", () => {
  beforeEach(seed);

  test("合併：補回被刪的卡片，但不蓋掉比較新的修改，也不刪任何東西", async () => {
    const b = snapshot();
    // 備份之後：刪了一張卡、改了一筆筆記、新增一筆筆記
    store.cards.delete(102);
    store.notes.get(1).fields[0] = "apple (edited)";
    store.notes.get(1).mod = 5000;
    store.notes.set(9, note(9, "durian", { mod: 6000 }));
    store.cards.set(109, card(109, 9));

    const plan = backup.planRestore(b, "merge");
    assert.deepEqual(plan.cards.map((c) => c.id), [102]);
    assert.deepEqual(plan.notes, [], "目前的筆記比較新，不該被備份蓋掉");
    assert.deepEqual([plan.dropNotes.length, plan.dropCards.length], [0, 0]);
    await backup.applyRestore(plan);
    assert.ok(store.cards.has(102));
    assert.equal(store.notes.get(1).fields[0], "apple (edited)");
    assert.ok(store.notes.has(9) && store.cards.has(109));
    assert.equal(calls.cards, 1, "只寫有差異的列");
  });

  test("完整還原：改回備份的內容、刪掉備份之後新增的、補回被刪的", async () => {
    const b = snapshot();
    store.cards.delete(102);
    store.notes.get(1).fields[0] = "apple (edited)";
    store.notes.get(1).mod = 5000;
    store.notes.set(9, note(9, "durian", { mod: 6000 }));
    store.cards.set(109, card(109, 9));
    store.cards.get(103).queue = -1; // 暫停

    const plan = backup.planRestore(b, "replace");
    assert.deepEqual(plan.cards.map((c) => c.id).sort(), [102, 103]);
    assert.deepEqual(plan.notes.map((n) => n.id), [1]);
    assert.deepEqual([plan.dropNotes.map((n) => n.id), plan.dropCards.map((c) => c.id)], [[9], [109]]);
    await backup.applyRestore(plan);
    assert.equal(store.notes.get(1).fields[0], "apple");
    assert.equal(store.cards.get(103).queue, 0);
    assert.ok(store.cards.has(102));
    assert.ok(!store.notes.has(9) && !store.cards.has(109));
    // 還原之後的資料列 mod 一定比原本新，其他裝置同步時才會被覆蓋
    assert.ok(store.cards.get(102).mod > 1000);
  });

  test("還原牌組與筆記類型（含合併只補缺少的）", async () => {
    const b = snapshot();
    store.static.decks = [...store.static.decks.filter((d) => d.id !== 11), { id: 12, name: "新牌組", config: 100 }];
    core.indexStatic();

    const merge = backup.planRestore(b, "merge");
    assert.deepEqual(merge.static.decks.map((d) => d.id).sort(), [10, 11, 12]);
    const replace = backup.planRestore(b, "replace");
    assert.deepEqual(replace.static.decks.map((d) => d.id), [10, 11]);
    await backup.applyRestore(merge);
    assert.equal(store.static.decks.length, 3);
    assert.equal(calls.static, 1);
  });

  test("複習紀錄只補回缺少的；缺少筆記類型或牌組的資料會略過並提醒", () => {
    const b = snapshot();
    b.revlog.push({ id: 5002, cid: 102, ease: 3, ivl: 1, last_ivl: 0, time: 1000, type: 0 });
    b.revlog.push({ id: 5003, cid: 99999, ease: 3, ivl: 1, last_ivl: 0, time: 1000, type: 0 }); // 卡片不存在
    b.notes.push(note(20, "orphan", { mid: 777 }));
    b.cards.push(card(120, 1, { did: 999 }));
    const plan = backup.planRestore(b, "merge");
    assert.deepEqual(plan.revlog.map((r) => r.id), [5002]);
    assert.equal(plan.warnings.length, 2);
    assert.ok(plan.warnings.some((w) => w.includes("筆記類型")) && plan.warnings.some((w) => w.includes("牌組")));
  });

  test("手寫標記也會還原", async () => {
    const b = snapshot();
    store.ink.get(101).data = '{"s":[{"k":"r","p":[1,2,3,4]}]}';
    const plan = backup.planRestore(b, "replace");
    assert.equal(plan.ink.length, 1);
    await backup.applyRestore(plan);
    assert.equal(store.ink.get(101).data, '{"s":[]}');
  });
});
