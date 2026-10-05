// .apkg 讀取：用 Anki 自己產生的真實套件（tests/fixtures/，由 tools/make_apkg_fixtures.py 產生）。node --test tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { decompress } from "fzstd";
import { parseProto, readPackage } from "../public/js/apkg.js";
import { readZip } from "../public/js/zip.js";

const require = createRequire(import.meta.url);
const SQL = await require("sql.js")();
const deps = { SQL, zstd: decompress };
const blob = (name) => new Blob([readFileSync(new URL(`./fixtures/${name}.apkg`, import.meta.url))]);

describe("ZIP 讀取", () => {
  test("列出項目並讀出內容（儲存與 deflate 兩種）", async () => {
    const zip = await readZip(blob("sample_legacy"));
    assert.ok(zip.has("collection.anki21") && zip.has("meta") && zip.has("media"));
    assert.deepEqual([...await zip.read("meta")], [8, 2]);
    const media = JSON.parse(new TextDecoder().decode(await zip.read("media")));
    assert.deepEqual(Object.values(media).sort(), ["beep.wav", "heart.png"]);
    const db = await zip.read("collection.anki21"); // deflate
    assert.equal(new TextDecoder().decode(db.subarray(0, 15)), "SQLite format 3");
    await assert.rejects(() => zip.read("nope"), /找不到/);
  });

  test("不是 ZIP 的檔案給清楚的錯誤", async () => {
    await assert.rejects(() => readZip(new Blob(["hello world, not a zip"])), /不是有效的 ZIP/);
  });
});

describe("protobuf", () => {
  test("整數、字串與巢狀訊息", () => {
    // field1 = 300 (varint), field2 = "hi", field3 = nested { field1 = 7 }
    const m = parseProto(new Uint8Array([0x08, 0xac, 0x02, 0x12, 2, 0x68, 0x69, 0x1a, 2, 0x08, 7]));
    assert.equal(m.get(1)[0], 300);
    assert.equal(new TextDecoder().decode(m.get(2)[0]), "hi");
    assert.equal(parseProto(m.get(3)[0]).get(1)[0], 7);
  });
});

const packages = {};
for (const name of ["sample_legacy", "sample_latest", "sample_latest_noscheduling"]) packages[name] = await readPackage(blob(name), deps);

for (const [name, version] of [["sample_legacy", 2], ["sample_latest", 3], ["sample_latest_noscheduling", 3]]) {
  describe(`讀取套件：${name}`, () => {
    const pkg = packages[name];

    test("版本、數量", () => {
      assert.equal(pkg.version, version);
      assert.equal(pkg.notes.length, 6);
      assert.equal(pkg.cards.length, 9);
    });

    test("筆記類型：標準、正反向、填空、輸入答案、圖片遮蓋", () => {
      const byName = Object.fromEntries(pkg.notetypes.map((n) => [n.name, n]));
      assert.deepEqual(Object.keys(byName).sort(), ["Basic", "Basic (and reversed card)", "Basic (type in the answer)", "Cloze", "Image Occlusion"]);
      assert.deepEqual(byName.Basic.fields, ["Front", "Back"]);
      assert.equal(byName.Basic.tmpls.length, 1);
      assert.equal(byName.Basic.tmpls[0].qfmt, "{{Front}}");
      assert.match(byName.Basic.tmpls[0].afmt, /FrontSide/);
      assert.equal(byName["Basic (and reversed card)"].tmpls.length, 2);
      assert.equal(byName["Basic (and reversed card)"].tmpls[1].qfmt, "{{Back}}");
      assert.equal(byName.Cloze.kind, "cloze");
      assert.match(byName.Cloze.tmpls[0].qfmt, /cloze:Text/);
      assert.equal(byName["Image Occlusion"].kind, "occlusion");
      assert.ok(byName.Basic.css.includes(".card"));
      assert.match(byName["Basic (type in the answer)"].tmpls[0].qfmt, /type:Back/);
    });

    test("牌組階層與筆記內容", () => {
      const names = pkg.decks.map((d) => d.name);
      assert.ok(names.includes("Fruits::Cloze") && names.includes("Fruits::Reversed"), names.join(","));
      const apple = pkg.notes.find((n) => n.fields[0] === "apple");
      assert.deepEqual(apple.tags.sort(), ["easy", "fruit"]);
      assert.match(apple.fields[1], /heart\.png/);
      const special = pkg.notes.find((n) => n.fields[0].includes("&"));
      assert.equal(special.fields[1], "特殊字元 <br> 換行");
      const cloze = pkg.notes.find((n) => n.fields[0].includes("{{c1::France}}"));
      assert.equal(cloze.fields[1], "Europe");
    });

    test("卡片：每個筆記的卡片數、複習進度", () => {
      const reviewed = pkg.cards.filter((c) => c.type === 2);
      if (name.endsWith("noscheduling")) {
        assert.equal(reviewed.length, 0, "匯出時選了不含進度，全部是新卡");
        assert.equal(pkg.revlog.length, 0);
      } else {
        assert.equal(reviewed.length, 1);
        assert.deepEqual([reviewed[0].ivl, reviewed[0].reps, reviewed[0].factor], [15, 4, 2500]);
        assert.equal(reviewed[0].due - pkg.today, 10, "到期日相對於匯出當天是 10 天後");
        assert.equal(pkg.revlog.length, 1);
      }
      const reversed = pkg.notes.find((n) => n.fields[0] === "pear");
      assert.deepEqual(pkg.cards.filter((c) => c.nid === reversed.srcId).map((c) => c.ord).sort(), [0, 1]);
    });

    test("媒體：檔名與內容（新格式要先解壓）", async () => {
      assert.deepEqual(pkg.media.names.sort(), ["beep.wav", "heart.png"]);
      const png = await pkg.media.read("heart.png");
      assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      const wav = await pkg.media.read("beep.wav");
      assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
      assert.equal(await pkg.media.read("nope.png"), null);
    });
  });
}
