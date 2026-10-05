// 筆記類型編輯、多卡片筆記（正反向、填空、圖片遮蓋）的新增／編輯／空白卡片。node --test tests/
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { presetNoteType } from "../public/js/cards.js";
import * as core from "../public/js/core.js";
import * as nts from "../public/js/notetypes.js";
import * as ops from "../public/js/ops.js";

const { store, persist } = core;
Object.assign(persist, { cards: async () => {}, notes: async () => {}, revlog: async () => {}, ink: async () => {}, removeRevlog: async () => {}, static: async () => {} });
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ static_mod: 5 }) });

const BASIC = 1, REV = 2, CLOZE = 3, IO = 4;
function seed() {
  store.notes.clear(); store.cards.clear(); store.revlog.clear(); store.ink.clear(); store.dict.clear();
  store.static = {
    meta: { static_mod: "1" },
    notetypes: [
      { ...presetNoteType("basic", BASIC, "Basic"), kind: "standard" },
      presetNoteType("reversed", REV, "Basic (and reversed card)"),
      presetNoteType("cloze", CLOZE, "Cloze"),
      presetNoteType("occlusion", IO, "Image Occlusion"),
    ],
    decks: [{ id: 10, name: "D", config: 100 }],
    configs: [{ id: 100, name: "Default" }],
  };
  core.indexStatic();
}
const cardsOf = (note) => core.cardsOfNote(note.id).sort((a, b) => a.ord - b.ord);

describe("新增與編輯筆記會產生對應的卡片", () => {
  beforeEach(seed);

  test("正反向：一個筆記兩張卡；反面是空的只有一張", async () => {
    const both = await ops.addNote({ mid: REV, did: 10, fields: ["apple", "蘋果"] });
    assert.deepEqual(both.cards.map((c) => c.ord), [0, 1]);
    const one = await ops.addNote({ mid: REV, did: 10, fields: ["pear", ""] });
    assert.deepEqual(one.cards.map((c) => c.ord), [0]);
    await ops.editNote(one.note, { fields: ["pear", "梨子"] });
    assert.deepEqual(cardsOf(one.note).map((c) => c.ord), [0, 1], "補上反面之後自動新增第二張");
  });

  test("填空題：每個編號一張，之後加填空會補卡、刪填空會變成空白卡", async () => {
    const { note, cards } = await ops.addNote({ mid: CLOZE, did: 10, fields: ["{{c1::Paris}} is the capital of {{c2::France}}.", ""] });
    assert.deepEqual(cards.map((c) => c.ord), [0, 1]);
    const r = await ops.editNote(note, { fields: ["{{c1::Paris}} is in {{c2::France}} and {{c3::Europe}}.", ""] });
    assert.equal(r.added, 1);
    assert.deepEqual(cardsOf(note).map((c) => c.ord), [0, 1, 2]);
    await ops.editNote(note, { fields: ["{{c1::Paris}} is in France and Europe.", ""] });
    assert.deepEqual(ops.findEmptyCards().map((c) => c.ord).sort(), [1, 2]);
    const del = await ops.deleteEmptyCards();
    assert.deepEqual([del.deleted, del.skipped], [2, 0]);
    assert.deepEqual(cardsOf(note).map((c) => c.ord), [0]);
  });

  test("沒有任何填空或遮蓋區域時不能新增，並說明原因", async () => {
    await assert.rejects(() => ops.addNote({ mid: CLOZE, did: 10, fields: ["沒有填空", ""] }), /填空/);
    await assert.rejects(() => ops.addNote({ mid: IO, did: 10, fields: ['<img src="a.png">', "", "", ""] }), /遮蓋區域/);
    const ok = await ops.addNote({ mid: IO, did: 10, fields: ['<img src="a.png">', "{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:oi=1}}{{c2::image-occlusion:rect:left=.5:top=.5:width=.2:height=.2:oi=1}}", "", ""] });
    assert.deepEqual(ok.cards.map((c) => c.ord), [0, 1]);
  });

  test("所有卡片都是空白的筆記不會被「清除空白卡片」整個刪掉", async () => {
    const { note } = await ops.addNote({ mid: CLOZE, did: 10, fields: ["{{c1::x}}", ""] });
    await ops.editNote(note, { fields: ["沒有填空了", ""] });
    const r = await ops.deleteEmptyCards();
    assert.deepEqual([r.deleted, r.skipped], [0, 1]);
    assert.equal(cardsOf(note).length, 1);
  });
});

describe("筆記類型的草稿", () => {
  beforeEach(seed);

  test("欄位改名時，版型裡所有引用一起改", () => {
    assert.equal(nts.renameInTemplate("{{Front}} {{#Front}}x{{/Front}} {{cloze:Front}} {{FrontSide}} {{Back}}", "Front", "Word"), "{{Word}} {{#Word}}x{{/Word}} {{cloze:Word}} {{FrontSide}} {{Back}}");
    assert.equal(nts.renameInTemplate("{{type:Back}}", "Back", "Meaning"), "{{type:Meaning}}");
    assert.equal(nts.renameInTemplate("{{Front}}", "Front", "Front"), "{{Front}}");
  });

  test("驗證：名稱、欄位、版型引用", () => {
    const d = () => nts.draftOf(store.static.notetypes[1]);
    assert.equal(nts.validateDraft(d(), store.static.notetypes), null);
    assert.match(nts.validateDraft({ ...d(), name: " " }), /名稱/);
    assert.match(nts.validateDraft({ ...d(), name: "Basic" }, store.static.notetypes), /同名/);
    const dup = d(); dup.fields[1].name = "Front";
    assert.match(nts.validateDraft(dup), /重複/);
    const bad = d(); bad.fields[0].name = "A:B";
    assert.match(nts.validateDraft(bad), /不能包含/);
    const ref = d(); ref.tmpls[0].qfmt = "{{Nope}}";
    assert.match(nts.validateDraft(ref), /Nope/);
    const empty = d(); empty.tmpls[0].qfmt = "  ";
    assert.match(nts.validateDraft(empty), /正面/);
    const noCloze = nts.draftOf(store.static.notetypes[2]); noCloze.tmpls[0].qfmt = "{{Text}}";
    assert.match(nts.validateDraft(noCloze), /cloze/);
  });

  test("影響評估：刪版型、換順序、刪欄位", async () => {
    const { note } = await ops.addNote({ mid: REV, did: 10, fields: ["apple", "蘋果"] });
    const old = store.static.notetypes[1];
    const cards = cardsOf(note);

    const del = nts.draftOf(old); del.tmpls.splice(0, 1); // 刪掉卡片 1
    let plan = nts.planChange(old, del, [note], cards);
    assert.deepEqual(plan.drop.map((c) => c.ord), [0]);
    assert.deepEqual(plan.remap.map((r) => [r.card.ord, r.ord]), [[1, 0]]);

    const swap = nts.draftOf(old); swap.tmpls.reverse();
    plan = nts.planChange(old, swap, [note], cards);
    assert.equal(plan.drop.length, 0);
    assert.deepEqual(plan.remap.map((r) => [r.card.ord, r.ord]).sort(), [[0, 1], [1, 0]]);

    const dropField = nts.draftOf(old); dropField.fields.splice(0, 1);
    plan = nts.planChange(old, dropField, [note], cards);
    assert.deepEqual(plan.droppedFields, ["Front"]);
    assert.deepEqual(plan.noteChanges[0].fields, ["蘋果"]);

    const addField = nts.draftOf(old); addField.fields.push({ name: "Extra", orig: null, committed: "Extra" });
    plan = nts.planChange(old, addField, [note], cards);
    assert.deepEqual(plan.noteChanges[0].fields, ["apple", "蘋果", ""]);

    const rename = nts.draftOf(old); rename.fields[0].name = "Word";
    assert.equal(nts.planChange(old, rename, [note], cards).noteChanges.length, 0, "只改名不需要動筆記");
  });

  test("套用：刪版型時卡片的 ord 跟著重排，新增版型會替現有筆記產生新卡", async () => {
    const { note } = await ops.addNote({ mid: REV, did: 10, fields: ["apple", "蘋果"] });
    const old = store.static.notetypes[1];

    const d = nts.draftOf(old);
    d.tmpls.splice(0, 1);
    await nts.applyChange(d, nts.planChange(old, d, [note], cardsOf(note)));
    assert.deepEqual(cardsOf(note).map((c) => c.ord), [0], "原本的第二張卡變成第一張");
    assert.equal(index().noteTypeById.get(REV).tmpls.length, 1);

    const nt2 = index().noteTypeById.get(REV);
    const d2 = nts.draftOf(nt2);
    d2.tmpls.push({ name: "新版型", qfmt: "{{Back}}", afmt: "{{FrontSide}}<hr id=answer>{{Front}}", orig: null });
    await nts.applyChange(d2, nts.planChange(nt2, d2, [note], cardsOf(note)));
    assert.deepEqual(cardsOf(note).map((c) => c.ord), [0, 1]);
  });

  test("欄位順序改變時，筆記內容跟著搬", async () => {
    const { note } = await ops.addNote({ mid: BASIC, did: 10, fields: ["apple", "蘋果"] });
    const old = store.static.notetypes[0];
    const d = nts.draftOf(old);
    d.fields.reverse();
    d.tmpls[0].qfmt = "{{Back}}"; // 反轉後 Back 在前面
    d.tmpls[0].afmt = "{{FrontSide}}<hr id=answer>{{Front}}";
    await nts.applyChange(d, nts.planChange(old, d, [note], cardsOf(note)));
    assert.deepEqual(note.fields, ["蘋果", "apple"]);
    assert.deepEqual(index().noteTypeById.get(BASIC).fields, ["Back", "Front"]);
  });
});

const index = () => core.index;
