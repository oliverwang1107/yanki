// FSRS 最佳化：複習紀錄轉訓練序列、wasm 介面。node --test tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DEFAULT_PARAMS, DIFF_MARGIN, MIN_TEST, MIN_TRAIN, buildItems, compareSplit, diffMargin, encodeItems, isHoldout, loadOptimizer, splitVerdict } from "../public/js/fsrsopt.js";

const DAY = 86400;
// 假的「學習日」：以 UTC 天數計（時間戳是毫秒）
const dayOf = (sec) => Math.floor(sec / DAY);
const rev = (cid, day, ease, type = 1, extra = 0) => ({ id: (day * DAY + 3600 + extra) * 1000, cid, ease, type });

describe("複習紀錄轉成訓練序列", () => {
  test("每筆（第二筆起）一個序列，內容是到它為止的歷史", () => {
    const { items, cards } = buildItems([rev(1, 0, 3, 0), rev(1, 2, 3), rev(1, 7, 1), rev(1, 9, 3, 2)], dayOf);
    assert.equal(cards, 1);
    assert.deepEqual(items, [
      [[3, 0], [3, 2]],
      [[3, 0], [3, 2], [1, 5]],
      [[3, 0], [3, 2], [1, 5], [3, 2]],
    ]);
  });

  test("同一天的複習不當作訓練目標，但留在歷史裡", () => {
    const { items } = buildItems([rev(1, 0, 3, 0), rev(1, 0, 3, 1, 600), rev(1, 3, 3)], dayOf);
    assert.deepEqual(items, [[[3, 0], [3, 0], [3, 3]]]);
  });

  test("手動調整與評分 0 不算；沒有學習紀錄開頭的卡片略過", () => {
    const { items, cards } = buildItems([rev(1, 0, 3, 0), rev(1, 1, 0, 4), rev(1, 4, 3), rev(2, 0, 3, 1), rev(2, 5, 3)], dayOf);
    assert.equal(cards, 1);
    assert.deepEqual(items, [[[3, 0], [3, 4]]]);
  });

  test("重新開始學習之後，只用最後一次重新開始後的紀錄", () => {
    const { items } = buildItems([rev(1, 0, 3, 0), rev(1, 2, 3), rev(1, 10, 3, 0), rev(1, 13, 4)], dayOf);
    assert.deepEqual(items, [[[3, 0], [4, 3]]]);
  });

  test("順序依時間排序，不管輸入順序", () => {
    const rows = [rev(1, 5, 4), rev(1, 0, 3, 0), rev(1, 2, 2)];
    assert.deepEqual(buildItems(rows, dayOf).items, [[[3, 0], [2, 2]], [[3, 0], [2, 2], [4, 3]]]);
  });

  test("cids 和 items 一一對應", () => {
    const { items, cids } = buildItems([rev(1, 0, 3, 0), rev(1, 2, 3), rev(2, 0, 3, 0), rev(2, 1, 4), rev(2, 5, 3)], dayOf);
    // 照複習時間排序：卡 2 第 1 天、卡 1 第 2 天、卡 2 第 5 天
    assert.deepEqual(cids, [2, 1, 2]);
    assert.deepEqual(items, [[[3, 0], [4, 1]], [[3, 0], [3, 2]], [[3, 0], [4, 1], [3, 4]]]);
  });

  test("測試／訓練的分法固定、約 20% 當測試、連號的卡片不會集中在同一邊", () => {
    const ids = Array.from({ length: 10000 }, (_, i) => 1700000000000 + i);
    const held = ids.filter(isHoldout);
    assert.ok(held.length > 1800 && held.length < 2200, String(held.length));
    assert.deepEqual(ids.filter(isHoldout), held);
    let run = 0;
    let longest = 0;
    for (const id of ids) longest = Math.max(longest, (run = isHoldout(id) ? run + 1 : 0));
    assert.ok(longest < 10, `連續測試卡 ${longest}`);
  });

  test("分開與共用的結論：差距要超過門檻才算", () => {
    assert.equal(splitVerdict(0.4, 0.39, 10000), "split");
    assert.equal(splitVerdict(0.4, 0.398, 10000), "same");
    assert.equal(splitVerdict(0.4, 0.402, 10000), "same");
    assert.equal(splitVerdict(0.4, 0.41, 10000), "shared");
  });

  test("測試序列少的時候門檻比較高，同樣的差距只算雜訊", () => {
    assert.equal(splitVerdict(0.4, 0.39, 10000), "split");
    assert.equal(splitVerdict(0.4, 0.39, 100), "same"); // 100 個序列的門檻約 0.022
    assert.equal(splitVerdict(0.4, 0.37, 100), "split");
    assert.ok(diffMargin(1e9) === DIFF_MARGIN && diffMargin(100) > diffMargin(400));
  });

  test("打包成 wasm 的輸入格式", () => {
    const buf = encodeItems([[[3, 0], [4, 2]], [[1, 0], [3, 1], [2, 5]]], { shortTerm: true, relearnSteps: 2 });
    assert.deepEqual([...buf], [1, 2, 2, 2, 3, 0, 4, 2, 3, 1, 0, 3, 1, 2, 5]);
  });
});

describe("fsrs_opt.wasm", () => {
  // 用固定的亂數產生一批像樣的複習紀錄（每張卡 4-7 次複習，間隔漸漸拉長，偶爾忘記）
  // firstCid：第一張卡的編號；grow：答對後間隔的成長倍率；pGood：答對的機率
  function synthetic(cardsN, { firstCid = 1, grow = 2.2, pGood = 0.85, seed = 12345 } = {}) {
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const rows = [];
    for (let c = firstCid; c < firstCid + cardsN; c++) {
      let day = Math.floor(rnd() * 30);
      let gap = 1;
      rows.push(rev(c, day, 1 + Math.floor(rnd() * 4), 0));
      for (let k = 0; k < 4 + Math.floor(rnd() * 4); k++) {
        gap = Math.max(1, Math.round(gap * (rnd() < 0.85 ? grow : 0.5)));
        day += gap;
        rows.push(rev(c, day, rnd() < pGood ? 3 : 1));
      }
    }
    return rows;
  }

  test("最佳化得到 21 個有限的參數，且比預設值更貼近資料", async () => {
    const { items } = buildItems(synthetic(300), dayOf);
    assert.ok(items.length > 500);
    const opt = await loadOptimizer(readFileSync(new URL("../public/fsrs_opt.wasm", import.meta.url)));
    const params = opt.optimize(items, { shortTerm: true, relearnSteps: 1 });
    assert.equal(params.length, 21);
    assert.ok(params.every(Number.isFinite));
    const mine = opt.evaluate(items, params);
    const base = opt.evaluate(items, DEFAULT_PARAMS);
    assert.ok(Number.isFinite(mine.logLoss) && mine.logLoss > 0);
    assert.ok(mine.logLoss < base.logLoss, `新參數 ${mine.logLoss} 應該比預設 ${base.logLoss} 準`);
  });

  describe("分牌組比較", () => {
    // 兩個牌組：A 間隔成長快、很少忘記；B 間隔成長慢、常忘記；C 只有幾張卡
    const A = synthetic(400, { firstCid: 1, grow: 2.4, pGood: 0.95, seed: 1 });
    const B = synthetic(400, { firstCid: 100001, grow: 1.4, pGood: 0.6, seed: 2 });
    const C = synthetic(5, { firstCid: 200001, seed: 3 });
    const keyOf = (cid) => (cid < 100000 ? "A" : cid < 200000 ? "B" : "C");
    const prep = (rows) => {
      const { items, cids } = buildItems(rows, dayOf);
      return { items, cids, groups: cids.map(keyOf), opts: { shortTerm: true, relearnSteps: 1 } };
    };
    const wasm = () => loadOptimizer(readFileSync(new URL("../public/fsrs_opt.wasm", import.meta.url)));

    test("資料太少的組跳過，其餘組有共用與專屬的分數，整體是加權平均", async () => {
      const opt = await wasm();
      const out = compareSplit(opt, prep([...A, ...B, ...C]));
      assert.deepEqual(out.groups.map((g) => g.key).sort(), ["A", "B", "C"]);
      const c = out.groups.find((g) => g.key === "C");
      assert.ok(c.skipped && c.train < MIN_TRAIN);
      const ran = out.groups.filter((g) => !g.skipped);
      assert.equal(ran.length, 2);
      for (const g of ran) {
        assert.ok(g.train >= MIN_TRAIN && g.test >= MIN_TEST);
        for (const s of [g.global, g.own]) assert.ok(Number.isFinite(s.logLoss) && s.logLoss > 0 && Number.isFinite(s.rmse));
      }
      const tests = ran.reduce((n, g) => n + g.test, 0);
      assert.equal(out.overall.test, tests);
      const mean = (k) => ran.reduce((n, g) => n + g.test * g[k].logLoss, 0) / tests;
      assert.ok(Math.abs(out.overall.global - mean("global")) < 1e-9);
      assert.ok(Math.abs(out.overall.own - mean("own")) < 1e-9);
    });

    test("性質差很多的牌組，專屬參數在沒看過的卡片上比共用的準", async () => {
      const opt = await wasm();
      const { groups } = compareSplit(opt, prep([...A, ...B]));
      const gains = groups.map((g) => g.global.logLoss - g.own.logLoss);
      assert.ok(gains.every((x) => x > -0.005), `專屬不該比共用差很多：${gains}`);
      assert.ok(Math.max(...gains) > 0.005, `至少一組專屬明顯較準：${gains}`);
    });

    test("性質相同的兩個牌組，分開沒有比較準", async () => {
      const opt = await wasm();
      const same = [...synthetic(400, { firstCid: 1, seed: 7 }), ...synthetic(400, { firstCid: 100001, seed: 8 })];
      const { groups, overall } = compareSplit(opt, prep(same));
      for (const g of groups) assert.notEqual(splitVerdict(g.global.logLoss, g.own.logLoss, g.test), "split", `${g.key}：共用 ${g.global.logLoss}、專屬 ${g.own.logLoss}`);
      assert.notEqual(splitVerdict(overall.global, overall.own, overall.test), "split", `共用 ${overall.global}、專屬 ${overall.own}`);
    });

    test("同一張卡的所有序列都在同一邊，所以訓練與測試的卡片不重疊", () => {
      const { cids } = prep([...A, ...B]);
      const sides = new Map();
      for (const cid of cids) {
        const side = isHoldout(cid);
        assert.equal(sides.get(cid) ?? side, side);
        sides.set(cid, side);
      }
    });
  });

  test("資料太少時回傳初始參數而不是壞掉；壞輸入回報錯誤", async () => {
    const opt = await loadOptimizer(readFileSync(new URL("../public/fsrs_opt.wasm", import.meta.url)));
    const { items } = buildItems(synthetic(3), dayOf);
    const params = opt.optimize(items, { shortTerm: true, relearnSteps: 1 });
    assert.equal(params.length, 21);
    assert.throws(() => opt.optimize([[[9, 0], [3, 1]]], {}), /最佳化失敗|格式/);
  });
});
