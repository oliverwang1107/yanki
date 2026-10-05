// FSRS 最佳化：複習紀錄轉訓練序列、wasm 介面。node --test tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DEFAULT_PARAMS, buildItems, encodeItems, loadOptimizer } from "../public/js/fsrsopt.js";

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

  test("打包成 wasm 的輸入格式", () => {
    const buf = encodeItems([[[3, 0], [4, 2]], [[1, 0], [3, 1], [2, 5]]], { shortTerm: true, relearnSteps: 2 });
    assert.deepEqual([...buf], [1, 2, 2, 2, 3, 0, 4, 2, 3, 1, 0, 3, 1, 2, 5]);
  });
});

describe("fsrs_opt.wasm", () => {
  // 用固定的亂數產生一批像樣的複習紀錄（每張卡 4-7 次複習，間隔漸漸拉長，偶爾忘記）
  function synthetic(cardsN) {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const rows = [];
    for (let c = 1; c <= cardsN; c++) {
      let day = Math.floor(rnd() * 30);
      let gap = 1;
      rows.push(rev(c, day, 1 + Math.floor(rnd() * 4), 0));
      for (let k = 0; k < 4 + Math.floor(rnd() * 4); k++) {
        gap = Math.max(1, Math.round(gap * (rnd() < 0.85 ? 2.2 : 0.5)));
        day += gap;
        rows.push(rev(c, day, rnd() < 0.85 ? 3 : 1));
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

  test("資料太少時回傳初始參數而不是壞掉；壞輸入回報錯誤", async () => {
    const opt = await loadOptimizer(readFileSync(new URL("../public/fsrs_opt.wasm", import.meta.url)));
    const { items } = buildItems(synthetic(3), dayOf);
    const params = opt.optimize(items, { shortTerm: true, relearnSteps: 1 });
    assert.equal(params.length, 21);
    assert.throws(() => opt.optimize([[[9, 0], [3, 1]]], {}), /最佳化失敗|格式/);
  });
});
