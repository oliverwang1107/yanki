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
  return { items: out.map((o) => o.reviews), cards: new Set(out.map((o) => o.cid)).size };
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
