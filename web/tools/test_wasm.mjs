// 用 Node 載入 public/sched.wasm，對 wasm/tests/oracle.json（Anki 的答案）逐項比對。
// 驗證的是 JS 與 WASM 之間的介面；排程本身的細節在 wasm/tests/oracle.rs 已經比對過。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSched } from "../public/js/sched.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oracle = JSON.parse(readFileSync(join(root, "wasm", "tests", "oracle.json"), "utf8"));
const { next } = await loadSched(readFileSync(join(root, "public", "sched.wasm")));

const { today, tz, rollover } = oracle;
const webDay = (ts) => Math.floor((ts + tz - rollover * 3600) / 86400);
const close = (a, b) => Math.abs(a - b) <= 2e-4 * Math.max(1, Math.abs(b));
const mem = (got, want) => close(got.s, want.stability ?? 0) && close(got.d, want.difficulty ?? 0);

let total = 0;
const bad = [];
for (const c of oracle.cases) {
  const cfgJson = oracle.configs[c.config];
  const cfg = {
    learnSteps: cfgJson.learnSteps, relearnSteps: cfgJson.relearnSteps, maxIvl: cfgJson.maxIvl,
    minLapseIvl: cfgJson.minLapseIvl, desiredRetention: cfgJson.desiredRetention, params: cfgJson.params,
  };
  const elapsed = c.card.lrt ? Math.max(0, today - webDay(c.card.lrt)) : 0;
  const got = next(c.card, cfg, elapsed);
  const early = c.card.type === 2 && c.card.dueDay > today;

  ["again", "hard", "good", "easy"].forEach((name, i) => {
    total++;
    const g = got[i];
    const w = c.expect[name].normal;
    const key = Object.keys(w)[0];
    let ok = g.kind === key;
    if (ok && key === "learning") ok = g.remaining === (w.learning.remainingSteps ?? 0) && g.secs === (w.learning.scheduledSecs ?? 0) && mem(g, w.learning.memoryState);
    if (ok && key === "review") ok = mem(g, w.review.memoryState) && (early || (w.review.scheduledDays <= cfg.maxIvl && w.review.scheduledDays + 1 + g.hi / 8 >= g.lo && w.review.scheduledDays <= g.hi + 1 + g.hi / 8));
    if (ok && key === "relearning") ok = g.remaining === (w.relearning.learning.remainingSteps ?? 0) && g.secs === (w.relearning.learning.scheduledSecs ?? 0) && mem(g, w.relearning.learning.memoryState);
    if (!ok) bad.push(`card ${c.card.id} ${name}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);
  });
}
console.log(`比對 ${total} 項，不一致 ${bad.length} 項`);
bad.slice(0, 5).forEach((m) => console.log("  " + m));
process.exit(bad.length ? 1 : 0);
