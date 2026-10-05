// 使用者自己的媒體（圖片、錄音、音檔）：放在 R2，檔名 u<uid>-<雜湊>.<副檔名>，只有本人讀得到。
// 雜湊由瀏覽器算（SHA-256 前 16 碼），伺服器只檢查格式；內容類型一律由副檔名決定，不信任用戶端送來的類型。
import { json } from "./util.js";

export const USER_MEDIA_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", webm: "audio/webm",
};
const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_AUDIO = 12 * 1024 * 1024;
const MAX_TOTAL = 300 * 1024 * 1024; // 每人的總容量上限
const MAX_FILES = 3000;

export const userMediaName = (uid, hash, ext) => `u${uid}-${hash}.${ext}`;
// 檔名以 u<數字>- 開頭的是某位使用者的私人檔案；回傳那位使用者的 uid，其他（共用的 mp3、圖片）回傳 null。
export const ownerOfKey = (key) => {
  const m = /^u(\d+)-/.exec(key);
  return m ? Number(m[1]) : null;
};

// PUT/POST /api/media?ext=png&hash=0123456789abcdef，內容是檔案本身
export async function uploadMedia(request, env, uid) {
  const url = new URL(request.url);
  const ext = (url.searchParams.get("ext") ?? "").toLowerCase();
  const hash = url.searchParams.get("hash") ?? "";
  const type = USER_MEDIA_TYPES[ext];
  if (!type) return json({ error: "不支援這種檔案格式" }, 400);
  if (!/^[0-9a-f]{16}$/.test(hash)) return json({ error: "檔案雜湊格式不對" }, 400);
  const size = Number(request.headers.get("Content-Length") ?? 0);
  if (!size) return json({ error: "沒有檔案內容" }, 400);
  if (size > (type.startsWith("image/") ? MAX_IMAGE : MAX_AUDIO)) return json({ error: "檔案太大（圖片上限 6MB、音檔上限 12MB）" }, 413);

  const name = userMediaName(uid, hash, ext);
  if (await env.MEDIA.head(name)) return json({ name, existed: true });

  let total = 0;
  let count = 0;
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix: `u${uid}-`, limit: 1000, cursor });
    for (const o of page.objects) (total += o.size), count++;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && count < MAX_FILES);
  if (total + size > MAX_TOTAL || count >= MAX_FILES) return json({ error: "你的媒體空間已滿（上限 300MB），請先整理不用的檔案" }, 413);

  await env.MEDIA.put(name, request.body, { httpMetadata: { contentType: type, cacheControl: "private, max-age=86400" } });
  return json({ name });
}
