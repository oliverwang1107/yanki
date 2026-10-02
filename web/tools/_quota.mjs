// Cloudflare D1 免費方案每天只能寫入約 10 萬列（UTC 午夜＝台灣早上 8 點重置），而且索引也算寫入：
// 每寫一列主表還要加上它的每個索引，所以 notes／cards 這類表一列約 3 次。
// 對「正式環境」做大量寫入的工具（遷移、牌組庫、字典上傳）先呼叫這裡，額度不夠就停下來，不要硬做。
// 用 `--force` 才會略過檢查。
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_LIMIT = 80000; // 免費上限 10 萬，留 2 萬給大家平常的複習與同步

// 免費額度是「每個 UTC 日」計算（台灣早上 8 點歸零），不是滾動 24 小時。
// wrangler d1 info 給的是滾動 24 小時，重置後還會高很久；這裡改問 Cloudflare 的分析 API，拿「今天（UTC）」的真實用量。
const ACCOUNT_ID = "35e3abd7f4df444b92373128f959096c";
const DATABASE_ID = "96846dff-9b35-4fc5-937b-6a4b968c18ae";

export async function rowsWrittenToday() {
  try {
    const raw = execFileSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "auth", "token", "--json"], {
      cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    const token = JSON.parse(raw.slice(raw.indexOf("{"))).token;
    const day = new Date().toISOString().slice(0, 10);
    const query = `query { viewer { accounts(filter: {accountTag: "${ACCOUNT_ID}"}) { d1AnalyticsAdaptiveGroups(limit: 10, filter: {date_geq: "${day}", date_leq: "${day}", databaseId: "${DATABASE_ID}"}) { sum { rowsWritten } } } } }`;
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
    const groups = (await res.json()).data.viewer.accounts[0].d1AnalyticsAdaptiveGroups;
    return groups.reduce((n, g) => n + g.sum.rowsWritten, 0); // 今天還沒有任何寫入時是空陣列 → 0
  } catch {
    return null; // 查不到就退回滾動 24 小時（比較保守）
  }
}

export function rowsWritten24h() {
  const out = execFileSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "d1", "info", "anki-web", "--json"], {
    cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  return JSON.parse(out.slice(out.indexOf("{"))).rows_written_24h;
}

// estimate：這次預計寫入幾列。回傳目前已用量；不夠就 throw。
export async function guardRemoteWrites(estimate, label) {
  if (process.argv.includes("--force")) return null;
  const today = await rowsWrittenToday();
  const used = today ?? rowsWritten24h();
  console.log(`D1 ${today === null ? "過去 24 小時" : "今天（UTC，台灣早上 8 點歸零）"}已寫入 ${used.toLocaleString()} 列（免費上限約 100,000），${label}預計再寫 ${estimate.toLocaleString()} 列`);
  if (used + estimate > SAFE_LIMIT) {
    throw new Error(`會超過免費寫入額度的安全線（${SAFE_LIMIT.toLocaleString()}）。請等台灣時間早上 8 點重置後再做，或分批做；真的要做請加 --force。`);
  }
  return used;
}
