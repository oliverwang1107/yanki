// 把 public/media/ 的音檔與圖片上傳到 R2 bucket（Worker 的 MEDIA 綁定）。
// 只上傳「還沒傳過」的檔案：已上傳的檔名記在 web/data/media-uploaded.json（不進版本控制），
// 想整批重傳就加 --all。
//
//   node tools/upload_media.mjs              上傳新增的檔案到線上 R2
//   node tools/upload_media.mjs --local      上傳到本機 wrangler dev 用的模擬 R2
//   node tools/upload_media.mjs --all        不管紀錄，全部重傳
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = "yanki-media";
const dir = join(ROOT, "public", "media");
const args = new Set(process.argv.slice(2));
const local = args.has("--local");
const manifestPath = join(ROOT, "data", local ? "media-uploaded-local.json" : "media-uploaded.json");
const BATCH = 200;
const CONCURRENCY = "5"; // 太高會被 R2 限流（429）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const done = new Set(args.has("--all") || !existsSync(manifestPath) ? [] : JSON.parse(readFileSync(manifestPath, "utf8")));
const todo = readdirSync(dir).filter((f) => !done.has(f));
console.log(`public/media：${done.size} 個已上傳過，${todo.length} 個要上傳（${local ? "本機" : "線上"} R2：${BUCKET}）`);

const save = () => {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify([...done]));
};

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const list = join(tmpdir(), `yanki-media-${process.pid}.json`);
  writeFileSync(list, JSON.stringify(batch.map((key) => ({ key, file: join(dir, key) }))));
  let ok = false;
  for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
    const r = spawnSync("npx", ["wrangler", "r2", "bulk", "put", BUCKET, "--filename", list, local ? "--local" : "--remote", "--concurrency", CONCURRENCY], { cwd: ROOT, stdio: "inherit", shell: true });
    ok = r.status === 0;
    if (!ok) {
      console.error(`這批失敗（第 ${attempt} 次），等 ${attempt * 20} 秒再試…`);
      await sleep(attempt * 20000);
    }
  }
  if (!ok) {
    save();
    console.error(`失敗：已完成 ${done.size} 個，重新執行會從中斷的地方繼續。`);
    process.exit(1);
  }
  batch.forEach((k) => done.add(k));
  save();
  console.log(`進度 ${Math.min(i + BATCH, todo.length)} / ${todo.length}`);
}
console.log("完成");
