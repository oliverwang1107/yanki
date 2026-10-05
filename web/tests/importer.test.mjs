// .apkg 匯入：用真實套件測試完整流程（牌組、筆記類型、媒體、進度、重複）。node --test tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, test } from "node:test";
import { decompress } from "fzstd";
import { readPackage } from "../public/js/apkg.js";
import { cardOrds, presetNoteType } from "../public/js/cards.js";
import * as core from "../public/js/core.js";
import { applyPlan, buildPlan, mediaRefs, rewriteMedia } from "../public/js/importer.js";

const { store, persist } = core;
Object.assign(persist, { cards: async () => {}, notes: async () => {}, revlog: async () => {}, ink: async () => {}, removeRevlog: async () => {}, static: async () => {} });
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ static_mod: 9 }) });

const require = createRequire(import.meta.url);
const SQL = await require("sql.js")();
const deps = { SQL, zstd: decompress };
const load = (name) => readPackage(new Blob([readFileSync(new URL(`./fixtures/${name}.apkg`, import.meta.url))]), deps);
const packages = { legacy: await load("sample_legacy"), latest: await load("sample_latest") };

function seed() {
  store.notes.clear(); store.cards.clear(); store.revlog.clear(); store.ink.clear(); store.dict.clear();
  store.static = {
    meta: { static_mod: "1" },
    notetypes: [
      { id: 1, name: "Basic", kind: "standard", fields: ["Front", "Back"], qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}", css: "", tmpls: null },
    ],
    decks: [{ id: 1, name: "Default", config: 100 }, { id: 10, name: "我的牌組", config: 100 }],
    configs: [{ id: 100, name: "Default" }],
  };
  core.indexStatic();
}
const fakeUploader = async (name, bytes) => {
  const ext = name.split(".").pop();
  return bytes.length ? `u1-${String(bytes.length).padStart(16, "0")}.${ext}` : null;
};

describe("媒體參照", () => {
  test("找出圖片與音檔，並換成新檔名", () => {
    const html = `<img src="a b.png"> <img src='c.jpg' width=3> [sound:d.mp3] <img src="https://x.test/e.png"> <img src="/media/u1-x.png"> <audio src=f.wav></audio>`;
    assert.deepEqual([...mediaRefs(html)].sort(), ["a b.png", "c.jpg", "d.mp3", "f.wav"]);
    const map = new Map([["a b.png", "u1-1.png"], ["d.mp3", "u1-2.mp3"], ["f.wav", "u1-3.wav"]]);
    const out = rewriteMedia(html, map);
    assert.match(out, /<img src="\/media\/u1-1\.png">/);
    assert.match(out, /\[sound:u1-2\.mp3\]/);
    assert.match(out, /src="\/media\/u1-3\.wav"/);
    assert.match(out, /<img src='c\.jpg' width=3>/, "沒有對應的保持原樣");
    assert.match(out, /https:\/\/x\.test\/e\.png/);
  });
  test("百分比編碼的檔名也能對上", () => {
    assert.deepEqual([...mediaRefs('<img src="a%20b.png">')], ["a b.png"]);
    assert.match(rewriteMedia('<img src="a%20b.png">', new Map([["a b.png", "u1-1.png"]])), /\/media\/u1-1\.png/);
  });
});

for (const [label, key] of [["舊格式", "legacy"], ["新格式", "latest"]]) {
  describe(`匯入 ${label} 套件`, () => {
    beforeEach(seed);
    const pkg = packages[key];

    test("計畫：牌組階層、筆記類型（重用同名同欄位的、建立新的）、數量", () => {
      const plan = buildPlan(pkg, { root: "匯入" });
      assert.equal(plan.summary.notes, 6);
      assert.equal(plan.summary.cards, 9);
      assert.equal(plan.summary.noteTypes, 4, "Basic 重用，其餘四種新建");
      assert.equal(plan.summary.reusedNoteTypes, 1);
      assert.ok(plan.newDeckNames.includes("匯入::Fruits") && plan.newDeckNames.includes("匯入::Fruits::Cloze"));
      assert.ok(plan.summary.estimatedWrites > 0);
      const kinds = Object.fromEntries(plan.notetypes.map((n) => [n.name, n.kind]));
      assert.equal(kinds.Cloze, "cloze");
      assert.equal(kinds["Image Occlusion"], "occlusion");
      assert.deepEqual(plan.mediaList.sort(), ["beep.wav", "heart.png"]);
    });

    test("套用：預設全部當新卡；每個筆記產生的卡片和原本一樣多，而且對得上這個 App 的版型規則", async () => {
      const plan = buildPlan(pkg);
      const result = await applyPlan(plan, pkg, { uploader: fakeUploader });
      assert.deepEqual([result.notes, result.cards, result.media, result.mediaSkipped], [6, 9, 2, 0]);
      assert.equal(store.notes.size, 6);
      assert.ok([...store.cards.values()].every((c) => c.type === 0 && c.queue === 0 && c.s === null && c.due_day === null));
      assert.equal(store.revlog.size, 0);
      // 每張匯入的卡片，都是這個 App 看得出來「應該存在」的卡（沒有空白卡）
      for (const note of store.notes.values()) {
        const nt = core.index.noteTypeById.get(note.mid);
        const ords = cardOrds(nt, note.fields);
        const have = [...store.cards.values()].filter((c) => c.nid === note.id).map((c) => c.ord).sort();
        assert.deepEqual(have, ords.sort(), `${nt.name} 的卡片`);
      }
      // 牌組階層
      const names = store.static.decks.map((d) => d.name);
      assert.ok(names.includes("Fruits") && names.includes("Fruits::Cloze") && names.includes("Fruits::Occlusion"));
      const clozeNote = [...store.notes.values()].find((n) => n.fields[0].includes("France"));
      const clozeCards = [...store.cards.values()].filter((c) => c.nid === clozeNote.id);
      assert.ok(clozeCards.every((c) => core.index.deckById.get(c.did).name === "Fruits::Cloze"));
    });

    test("媒體檔名被換成上傳後的新檔名（圖片與音檔）", async () => {
      const plan = buildPlan(pkg);
      await applyPlan(plan, pkg, { uploader: fakeUploader });
      const apple = [...store.notes.values()].find((n) => n.fields[0] === "apple");
      assert.match(apple.fields[1], /<img src="\/media\/u1-\d+\.png">/);
      assert.ok(!apple.fields[1].includes("heart.png"));
      const pear = [...store.notes.values()].find((n) => n.fields[0] === "pear");
      assert.match(pear.fields[1], /\[sound:u1-\d+\.wav\]/);
    });

    test("沒有上傳函式或檔案不支援時，保留原本的引用而不是壞掉", async () => {
      const plan = buildPlan(pkg);
      const result = await applyPlan(plan, pkg, { uploader: async () => null });
      assert.equal(result.mediaSkipped, 2);
      const apple = [...store.notes.values()].find((n) => n.fields[0] === "apple");
      assert.match(apple.fields[1], /heart\.png/);
    });

    test("保留複習進度：到期日、間隔、記憶狀態與複習紀錄", async () => {
      const plan = buildPlan(pkg, { keepScheduling: true });
      assert.equal(plan.summary.revlog, 1);
      await applyPlan(plan, pkg, { uploader: fakeUploader });
      const reviewed = [...store.cards.values()].filter((c) => c.type === 2);
      assert.equal(reviewed.length, 1);
      const c = reviewed[0];
      assert.equal(c.queue, 2);
      assert.equal(c.ivl, 15);
      assert.equal(c.due_day, core.today() + 10);
      assert.ok(c.s >= 1 && c.d >= 1 && c.d <= 10, "沒有 FSRS 資料時用間隔與難易度估一個記憶狀態");
      assert.ok(c.lrt < core.nowSec());
      assert.equal(store.revlog.size, 1);
      assert.equal([...store.revlog.values()][0].cid, c.id);
    });

    test("重複的筆記會略過（同 guid 或同類型同第一欄），可以關掉", async () => {
      store.notes.set(500, { id: 500, guid: "HwY._7W[_<", mid: 1, mod: 1, tags: "", fields: ["whatever", "x"], deleted: 0 }); // 同 guid
      store.notes.set(501, { id: 501, guid: "other", mid: 1, mod: 1, tags: "", fields: ["<B>中文</B> & 'quote'", "x"], deleted: 0 }); // 同類型同第一欄（大小寫不同）
      const plan = buildPlan(pkg);
      assert.equal(plan.summary.duplicates, 2, "apple（同 guid）和另一筆 Basic（同第一欄）");
      assert.equal(plan.summary.notes, 4);
      assert.equal(buildPlan(pkg, { skipDuplicates: false }).summary.notes, 6);
    });

    test("全部放進指定牌組、加標籤", async () => {
      const plan = buildPlan(pkg, { deckMode: "single", targetDeckId: 10, extraTag: "匯入 測試" });
      assert.equal(plan.summary.decks, 0);
      await applyPlan(plan, pkg, { uploader: fakeUploader });
      assert.ok([...store.cards.values()].every((c) => c.did === 10));
      assert.ok([...store.notes.values()].every((n) => n.tags.split(" ").includes("匯入_測試")));
      assert.equal(store.static.decks.length, 2, "沒有新增牌組");
      assert.throws(() => buildPlan(pkg, { deckMode: "single", targetDeckId: 999 }), /選擇/);
    });

    test("筆記類型同名但欄位不同時，建立新的而不是覆蓋", () => {
      store.static.notetypes.push({ id: 2, name: "Cloze", kind: "cloze", fields: ["Other", "Fields"], qfmt: "{{cloze:Other}}", afmt: "{{cloze:Other}}", css: "", tmpls: null });
      core.indexStatic();
      const plan = buildPlan(pkg);
      const cloze = plan.notetypes.find((n) => n.kind === "cloze");
      assert.match(cloze.name, /匯入/);
      assert.deepEqual(cloze.fields, ["Text", "Back Extra"]);
    });

    test("已經有圖片遮蓋類型時重用它，欄位依名稱對應", async () => {
      store.static.notetypes.push(presetNoteType("occlusion", 7, "我的遮蓋"));
      core.indexStatic();
      const plan = buildPlan(pkg);
      assert.ok(!plan.notetypes.some((n) => n.kind === "occlusion"));
      await applyPlan(plan, pkg, { uploader: fakeUploader });
      const io = [...store.notes.values()].find((n) => n.mid === 7);
      assert.match(io.fields[0], /<img/, "Image 在第一個欄位");
      assert.match(io.fields[1], /image-occlusion/, "Occlusion 在第二個欄位");
      assert.equal(io.fields[2], "心臟");
      assert.equal([...store.cards.values()].filter((c) => c.nid === io.id).length, 2);
    });
  });
}
