// 用你的真實複習紀錄試跑瀏覽器版的 FSRS 最佳化（fsrs_opt.wasm），和 Anki 內建最佳化的結果（data/fsrs_result.json）比較。
// 用法：node tools/test_fsrsopt.mjs
import { readFileSync, existsSync } from "node:fs";
import { dayOf } from "../public/js/core.js";
import { DEFAULT_PARAMS, buildItems, loadOptimizer } from "../public/js/fsrsopt.js";

const exp = JSON.parse(readFileSync(new URL("../data/export.json", import.meta.url)));
const { items, cards } = buildItems(exp.revlog, dayOf);
console.log(`複習紀錄 ${exp.revlog.length} 筆 → ${items.length} 個訓練序列（${cards} 張卡）`);
const opt = await loadOptimizer(readFileSync(new URL("../public/fsrs_opt.wasm", import.meta.url)));
const t0 = Date.now();
const params = opt.optimize(items, { shortTerm: true, relearnSteps: 1 });
console.log(`最佳化完成：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
console.log("參數：" + params.map((x) => x.toFixed(3)).join(", "));
const score = (name, p) => { const e = opt.evaluate(items, p); console.log(`  ${name.padEnd(14)} log loss ${e.logLoss.toFixed(4)}  RMSE ${e.rmse.toFixed(4)}`); return e; };
const mine = score("瀏覽器版新參數", params);
const base = score("FSRS-6 預設", DEFAULT_PARAMS);
const refPath = new URL("../data/fsrs_result.json", import.meta.url);
if (existsSync(refPath)) {
  const ref = JSON.parse(readFileSync(refPath));
  score("Anki 內建結果", ref.params);
  console.log("Anki 內建參數：" + ref.params.map((x) => x.toFixed(3)).join(", "));
}
if (!(mine.logLoss < base.logLoss)) { console.error("新參數沒有比預設值準，有問題"); process.exit(1); }
