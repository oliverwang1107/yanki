// 今天的進度與連續天數，由複習紀錄（revlog）算出，不另外存。
import { dayOf, store, today } from "./core.js";

const reviewDay = (r) => dayOf(Math.floor(r.id / 1000));

export function todayProgress() {
  const t = today();
  const days = new Set();
  let reviews = 0;
  let ms = 0;
  for (const r of store.revlog.values()) {
    if (r.type === 4) continue; // 手動調整排程，不算複習
    const d = reviewDay(r);
    days.add(d);
    if (d === t) {
      reviews++;
      ms += r.time ?? 0;
    }
  }
  // 連續天數：今天還沒複習就從昨天往回算，這樣一整天都不會看到「連續中斷」的假警報。
  let streak = 0;
  for (let d = days.has(t) ? t : t - 1; days.has(d); d--) streak++;
  return { reviews, minutes: Math.round(ms / 60000), streak, hasHistory: days.size > 0 };
}
