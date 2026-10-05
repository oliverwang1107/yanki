// 筆記類型、填空題、圖片遮蓋、版型渲染。node --test tests/
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as cards from "../public/js/cards.js";
import { renderCloze, renderOcclusion } from "../public/js/render.js";

const nt = (key) => cards.presetNoteType(key, 1);

describe("填空題語法", () => {
  test("找出編號、去掉標記", () => {
    assert.deepEqual(cards.clozeNumbers("{{c2::b}} and {{c1::a::hint}} and {{c2::again}}"), [1, 2]);
    assert.deepEqual(cards.clozeNumbers("沒有填空"), []);
    assert.equal(cards.stripCloze("The {{c1::cat::animal}} sat on the {{c2::mat}}."), "The cat sat on the mat.");
    assert.equal(cards.stripCloze("{{c1::outer {{c2::inner}} text}}"), "outer inner text");
  });

  test("問題面遮住、答案面顯示，其他編號照常顯示", () => {
    const text = "The {{c1::cat::animal}} sat on the {{c2::mat}}.";
    assert.equal(renderCloze(text, 1, "q"), 'The <span class="cloze">[animal]</span> sat on the mat.');
    assert.equal(renderCloze(text, 1, "a"), 'The <span class="cloze">cat</span> sat on the mat.');
    assert.equal(renderCloze(text, 2, "q"), 'The cat sat on the <span class="cloze">[...]</span>.');
  });

  test("巢狀填空、括號沒配對好不會壞掉", () => {
    assert.equal(renderCloze("{{c1::outer {{c2::inner}} end}}", 2, "q"), 'outer <span class="cloze">[...]</span> end');
    assert.equal(renderCloze("{{c1::outer {{c2::inner}} end}}", 1, "q"), '<span class="cloze">[...]</span>');
    assert.equal(renderCloze("{{c1::沒有結尾", 1, "q"), "{{c1::沒有結尾");
    assert.equal(renderCloze("a {{b}} c", 1, "q"), "a {{b}} c");
  });
});

describe("一個筆記會產生幾張卡", () => {
  test("基本型：正面有內容才產生", () => {
    assert.deepEqual(cards.cardOrds(nt("basic"), ["apple", "蘋果"]), [0]);
    assert.deepEqual(cards.cardOrds(nt("basic"), ["", "蘋果"]), []);
    assert.deepEqual(cards.cardOrds(nt("basic"), ["<br>", "x"]), [], "只有 <br> 算空的");
  });

  test("基本型＋反向：兩個版型各一張；反面是空的就只有一張", () => {
    assert.deepEqual(cards.cardOrds(nt("reversed"), ["apple", "蘋果"]), [0, 1]);
    assert.deepEqual(cards.cardOrds(nt("reversed"), ["apple", ""]), [0]);
  });

  test("可選的反向卡片：Add Reverse 有填才產生第二張", () => {
    assert.deepEqual(cards.cardOrds(nt("optional"), ["a", "b", ""]), [0]);
    assert.deepEqual(cards.cardOrds(nt("optional"), ["a", "b", "y"]), [0, 1]);
  });

  test("填空題：每個編號一張，ord 從 0 起算", () => {
    assert.deepEqual(cards.cardOrds(nt("cloze"), ["{{c1::a}} {{c3::b}}", ""]), [0, 2]);
    assert.deepEqual(cards.cardOrds(nt("cloze"), ["沒有填空", ""]), []);
    assert.match(cards.noCardsReason(nt("cloze")), /填空/);
  });

  test("圖片遮蓋：每個群組一張", () => {
    const occ = "{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:oi=1}}<br>{{c1::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.1:oi=1}}<br>{{c2::image-occlusion:rect:left=.7:top=.7:width=.1:height=.1}}";
    assert.deepEqual(cards.cardOrds(nt("occlusion"), ['<img src="a.png">', occ, "", ""]), [0, 1]);
    assert.deepEqual(cards.cardOrds(nt("occlusion"), ['<img src="a.png">', "", "", ""]), []);
  });

  test("舊的筆記類型（沒有 tmpls）仍然運作", () => {
    const old = { id: 1, name: "Basic", fields: ["Front", "Back"], qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}", css: "" };
    assert.equal(cards.templatesOf(old).length, 1);
    assert.deepEqual(cards.cardOrds(old, ["a", "b"]), [0]);
  });

  test("筆記標題", () => {
    assert.equal(cards.noteTitle(nt("cloze"), ["The {{c1::cat}} sat", ""]), "The cat sat");
    assert.equal(cards.noteTitle(nt("occlusion"), ["<img src=x>", "", "", ""]), "[圖片遮蓋]");
    assert.equal(cards.noteTitle(nt("occlusion"), ["<img src=x>", "", "心臟", ""]), "心臟");
    assert.equal(cards.noteTitle(nt("basic"), ["<b>apple</b>", "x"]), "apple");
  });
});

describe("圖片遮蓋", () => {
  const occ = "{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.4:oi=1}}{{c2::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.2:oi=1}}{{c3::image-occlusion:polygon:points=\"0.1,0.1 0.5,0.1 0.3,0.4\"}}";

  test("解析與輸出互相轉換", () => {
    const shapes = cards.parseOcclusion(occ);
    assert.deepEqual(shapes.map((s) => [s.group, s.kind, s.hideAll]), [[1, "rect", true], [2, "ellipse", true], [3, "polygon", false]]);
    assert.deepEqual([shapes[0].x, shapes[0].y, shapes[0].w, shapes[0].h], [0.1, 0.2, 0.3, 0.4]);
    assert.deepEqual(shapes[2].points, [[0.1, 0.1], [0.5, 0.1], [0.3, 0.4]]);
    const again = cards.parseOcclusion(cards.stringifyOcclusion(shapes));
    assert.deepEqual(again, shapes);
  });

  test("問題面：考的區域是橘紅色、其他區域是黃色；答案面：考的區域揭開", () => {
    const q = renderOcclusion("<img>", occ, 1, "q");
    assert.match(q, /<rect[^>]*fill="#ff8e8e"/);
    assert.match(q, /<ellipse[^>]*fill="#ffeba2"/);
    assert.ok(!q.includes("<polygon"), "沒有 oi=1 的區域，只遮一個模式不顯示");
    const a = renderOcclusion("<img>", occ, 1, "a");
    assert.match(a, /<rect[^>]*stroke-dasharray/);
    assert.match(a, /<ellipse[^>]*fill="#ffeba2"/);
    const third = renderOcclusion("<img>", occ, 3, "q");
    assert.match(third, /<polygon/);
  });
});

describe("內建範本", () => {
  test("每個範本的版型與欄位一致", () => {
    for (const key of Object.keys(cards.PRESETS)) {
      const t = cards.presetNoteType(key, 5);
      assert.equal(t.qfmt, t.tmpls[0].qfmt);
      assert.equal(t.kind, cards.PRESETS[key].kind);
      for (const tmpl of t.tmpls) {
        for (const m of (tmpl.qfmt + tmpl.afmt).matchAll(/\{\{[#^/]?([^}]+?)\}\}/g)) {
          const name = m[1].split(":").pop().trim();
          assert.ok(t.fields.includes(name) || cards.SPECIAL_FIELDS.has(name), `${key} 的版型用到不存在的欄位 ${name}`);
        }
      }
    }
  });
});
