// 在背景執行緒跑 FSRS 最佳化，畫面不會卡住。訊息：{ items, opts, evalSets: [{ name, params }] }
// 回傳：{ params, scores: [{ name, logLoss, rmse }] }；失敗回傳 { error }。
import { loadOptimizer } from "./fsrsopt.js";

self.onmessage = async (e) => {
  try {
    const { items, opts, evalSets } = e.data;
    const opt = await loadOptimizer(await fetch("/fsrs_opt.wasm"));
    const params = opt.optimize(items, opts);
    const scores = [{ name: "new", params }, ...evalSets].map(({ name, params: p }) => ({ name, ...opt.evaluate(items, p) }));
    self.postMessage({ params, scores });
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err) });
  }
};
