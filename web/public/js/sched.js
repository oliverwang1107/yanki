// 排程：呼叫 sched.wasm（Rust 的 fsrs ＋ Anki 的學習步驟與間隔規則）。介面細節見 wasm/src/lib.rs。
const KIND = { 1: "learning", 2: "review", 3: "relearning" };

export async function loadSched(source) {
  const bytes = source instanceof Response ? await source.arrayBuffer() : source;
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const input = () => new Float64Array(ex.memory.buffer, ex.input_ptr(), 160);
  const output = () => new Float64Array(ex.memory.buffer, ex.output_ptr(), 32);

  // card: { type, left, ivl, s, d, id, reps }；cfg: 牌組設定；elapsedDays: 距上次複習的學習日數
  // 回傳 [again, hard, good, easy]，每個是 { kind, remaining, secs, days, s, d, lo, hi }
  function next(card, cfg, elapsedDays) {
    const inp = input();
    const learn = cfg.learnSteps ?? [];
    const relearn = cfg.relearnSteps ?? [];
    const params = cfg.params ?? [];
    if (13 + learn.length + relearn.length + params.length > inp.length) throw new Error("排程輸入太長");
    inp.set([
      card.type, card.left % 1000, card.ivl, card.s ?? NaN, card.d ?? NaN, elapsedDays, card.id + card.reps,
      cfg.desiredRetention, cfg.maxIvl, cfg.minLapseIvl, learn.length, relearn.length, params.length,
      ...learn, ...relearn, ...params,
    ]);
    const code = ex.schedule();
    if (code !== 0) throw new Error(code === 1 ? "排程輸入不合法" : "FSRS 計算失敗（參數可能有誤）");
    const out = output();
    return [0, 1, 2, 3].map((i) => {
      const [kind, remaining, secs, days, s, d, lo, hi] = out.subarray(i * 8, i * 8 + 8);
      return { kind: KIND[kind], remaining, secs, days, s, d, lo, hi };
    });
  }

  return { next };
}
