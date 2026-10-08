// 在背景執行緒跑 FSRS 最佳化，畫面不會卡住。
// 一般最佳化：{ items, opts, evalSets: [{ name, params }] } → { params, scores: [{ name, logLoss, rmse }] }
// 分組比較：{ split: { items, cids, groups, opts } } → { split: 結果 }，中途會送 { progress: "進行到哪" }
// 失敗回傳 { error }。
import { compareSplit, loadOptimizer } from "./fsrsopt.js";

self.onmessage = async (e) => {
  try {
    const { items, opts, evalSets, split } = e.data;
    const opt = await loadOptimizer(await fetch("/fsrs_opt.wasm"));
    if (split) {
      self.postMessage({ split: compareSplit(opt, split, (progress) => self.postMessage({ progress })) });
      return;
    }
    const params = opt.optimize(items, opts);
    const scores = [{ name: "new", params }, ...evalSets].map(({ name, params: p }) => ({ name, ...opt.evaluate(items, p) }));
    self.postMessage({ params, scores });
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err) });
  }
};
