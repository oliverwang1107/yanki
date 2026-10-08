// FSRS 參數最佳化：把複習紀錄轉成 FSRS 的訓練序列，交給 fsrs_opt.wasm（fsrs crate 的 compute_parameters）計算。
// 轉換規則照 fsrs-rs 的參考實作（也就是 Anki 的做法）：每張卡取「最後一次重新開始學習」之後的紀錄，
// 每一筆複習（第二筆起）產生一個序列，內容是到它為止的所有（評分、距上次複習的天數）；距上次複習 0 天的不當作訓練目標。
// 沒有任何畫面相關的程式，Node 也能載入測試。

export const DEFAULT_PARAMS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

// revlog 列：{ id（毫秒時間戳）, cid, ease（1-4）, type（0 學習 1 複習 2 重學 3 篩選 4 手動）}
// dayOf：把時間戳（秒）轉成學習日編號（凌晨 4 點換日）。回傳 { items, cards }：items 是 [[評分, 天數], …] 的陣列。
export function buildItems(revlog, dayOf) {
  const byCard = new Map();
  for (const r of revlog) {
    if (!(r.ease >= 1 && r.ease <= 4) || r.type === 4) continue; // 手動調整（重設、改到期日）不是複習
    if (!byCard.has(r.cid)) byCard.set(r.cid, []);
    byCard.get(r.cid).push(r);
  }
  const out = [];
  for (const [cid, rows] of byCard) {
    rows.sort((a, b) => a.id - b.id);
    // 只留最後一次「重新開始學習」之後的紀錄（和參考實作一模一樣，包含邊界情形）
    let start = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].type === 0) start = i;
      else if (start !== 0) break;
    }
    if (rows[start].type !== 0) continue;
    const entries = rows.slice(start);
    const days = entries.map((r) => dayOf(Math.floor(r.id / 1000)));
    const delta = entries.map((_, i) => (i === 0 ? 0 : Math.max(0, days[i] - days[i - 1])));
    for (let i = 1; i < entries.length; i++) {
      if (delta[i] <= 0) continue;
      out.push({ id: entries[i].id, cid, reviews: entries.slice(0, i + 1).map((r, j) => [r.ease, delta[j]]) });
    }
  }
  out.sort((a, b) => a.id - b.id);
  // cids 和 items 一一對應：每個序列屬於哪張卡
  return { items: out.map((o) => o.reviews), cids: out.map((o) => o.cid), cards: new Set(out.map((o) => o.cid)).size };
}

// ---------- 分組比較：每個牌組（或設定）自己算一組參數，是不是比大家共用一組更準？ ----------
// 專屬參數的自由度比較多，用同一批紀錄訓練再打分數一定贏，所以改用留一份測試：
// 約 20% 的卡片（固定的雜湊，同一張卡永遠在同一邊）只拿來打分數，全域與專屬參數都只用其餘的卡片訓練。
export const MIN_TRAIN = 100; // 一組至少要有這麼多訓練序列、測試序列才比較，再少算出來的參數沒有意義
export const MIN_TEST = 40;
export const DIFF_MARGIN = 0.005; // log loss 差距的最低門檻

// 兩組參數在同一批測試序列上的 log loss 差距，雜訊大約是 0.11 ÷ √序列數（用性質相同的假資料量過），門檻取兩倍。
// 測試序列少的時候，看起來有差的差距多半只是雜訊。
export const diffMargin = (testN) => Math.max(DIFF_MARGIN, 0.22 / Math.sqrt(testN));

export function isHoldout(cid) {
  let h = (cid % 4294967291) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) % 5 === 0;
}

// "split" 專屬較準、"shared" 共用較準、"same" 差不多（那就共用，參數少一組比較省事也比較穩）
export function splitVerdict(globalLoss, ownLoss, testN) {
  const gain = globalLoss - ownLoss;
  const margin = diffMargin(testN);
  return gain >= margin ? "split" : gain <= -margin ? "shared" : "same";
}

// opt：loadOptimizer 的結果。groups 和 items 一一對應，是每個序列的分組代號（null 代表不獨立比較，但仍參與全域訓練）。
// 回傳 { groups: [{ key, train, test, skipped?, global, own }], overall }，分數是 { logLoss, rmse }。
// overall 是有比較的各組以測試序列數加權平均的 log loss：{ test, global, own }。
export function compareSplit(opt, { items, cids, groups, opts }, onProgress = () => {}) {
  const train = [];
  const test = [];
  items.forEach((it, i) => (isHoldout(cids[i]) ? test : train).push({ it, g: groups[i] }));
  const pick = (rows, g) => rows.filter((r) => r.g === g).map((r) => r.it);
  const keys = [...new Set(groups.filter((g) => g != null))];
  keys.sort((a, b) => pick(train, b).length - pick(train, a).length);

  onProgress("全域");
  const globalParams = opt.optimize(train.map((r) => r.it), opts);
  const out = [];
  let sum = { test: 0, global: 0, own: 0 };
  for (const [n, key] of keys.entries()) {
    const tr = pick(train, key);
    const te = pick(test, key);
    if (tr.length < MIN_TRAIN || te.length < MIN_TEST) {
      out.push({ key, train: tr.length, test: te.length, skipped: true });
      continue;
    }
    onProgress(`${key}（${n + 1}/${keys.length}）`);
    const own = opt.optimize(tr, opts);
    const row = { key, train: tr.length, test: te.length, global: opt.evaluate(te, globalParams), own: opt.evaluate(te, own) };
    out.push(row);
    sum = { test: sum.test + te.length, global: sum.global + te.length * row.global.logLoss, own: sum.own + te.length * row.own.logLoss };
  }
  const overall = sum.test ? { test: sum.test, global: sum.global / sum.test, own: sum.own / sum.test } : null;
  return { groups: out, overall };
}

// 打包成 wasm 要的 Int32Array：[短期記憶, 重學步驟數, n, (len, (評分, 天數)×len)×n]
export function encodeItems(items, { shortTerm = true, relearnSteps = 1 } = {}) {
  let size = 3;
  for (const it of items) size += 1 + it.length * 2;
  const buf = new Int32Array(size);
  buf[0] = shortTerm ? 1 : 0;
  buf[1] = relearnSteps;
  buf[2] = items.length;
  let at = 3;
  for (const it of items) {
    buf[at++] = it.length;
    for (const [rating, delta] of it) {
      buf[at++] = rating;
      buf[at++] = delta;
    }
  }
  return buf;
}

export async function loadOptimizer(source) {
  const bytes = source instanceof Response ? await source.arrayBuffer() : source;
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const put = (typed) => {
    const ptr = ex.alloc(typed.byteLength);
    new Uint8Array(ex.memory.buffer, ptr, typed.byteLength).set(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
    return ptr;
  };
  const fail = (code) => {
    throw new Error(code === 1 ? "複習紀錄格式不對" : "最佳化失敗（資料可能太少或不合理）");
  };
  return {
    // 回傳 21 個參數
    optimize(items, opts) {
      const data = encodeItems(items, opts);
      const inPtr = put(data);
      const outPtr = ex.alloc(21 * 4);
      try {
        const code = ex.optimize(inPtr, data.length, outPtr);
        if (code !== 0) fail(code);
        return Array.from(new Float32Array(ex.memory.buffer, outPtr, 21));
      } finally {
        ex.dealloc(inPtr, data.byteLength);
        ex.dealloc(outPtr, 21 * 4);
      }
    },
    // 用給定的參數在這批序列上算預測準確度：{ logLoss, rmse }（越小越準）
    evaluate(items, params) {
      const data = encodeItems(items);
      const inPtr = put(data);
      const pPtr = put(new Float32Array(params));
      const outPtr = ex.alloc(8);
      try {
        const code = ex.evaluate(inPtr, data.length, pPtr, outPtr);
        if (code !== 0) fail(code);
        const [logLoss, rmse] = new Float32Array(ex.memory.buffer, outPtr, 2);
        return { logLoss, rmse };
      } finally {
        ex.dealloc(inPtr, data.byteLength);
        ex.dealloc(pPtr, 21 * 4);
        ex.dealloc(outPtr, 8);
      }
    },
  };
}
