// 使用者媒體：檔名工具、圖片路徑修正、伺服器上傳規則（用假的 R2）。node --test tests/
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as media from "../public/js/media.js";
import { fixMediaSrc } from "../public/js/render.js";
import { ownerOfKey, uploadMedia, userMediaName } from "../src/media.js";

describe("檔名工具", () => {
  test("副檔名、種類、插入欄位的標籤", () => {
    assert.equal(media.extOf("Photo.JPG"), "jpg");
    assert.equal(media.extOf("noext"), "");
    assert.equal(media.kindOf("a.webp"), "image");
    assert.equal(media.kindOf("a.m4a"), "audio");
    assert.equal(media.kindOf("a.exe"), "other");
    assert.equal(media.mediaTag("u1-abc.png"), '<img src="/media/u1-abc.png">');
    assert.equal(media.mediaTag("rec.webm"), "[sound:rec.webm]");
  });

  test("雜湊：同樣內容同樣結果，16 個十六進位字元", async () => {
    const a = await media.hashHex16(new TextEncoder().encode("hello").buffer);
    const b = await media.hashHex16(new TextEncoder().encode("hello").buffer);
    const c = await media.hashHex16(new TextEncoder().encode("hellO").buffer);
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("圖片路徑修正", () => {
  test("相對檔名改成 /media/，網址與 data: 不動", () => {
    assert.equal(fixMediaSrc('<img src="cat.jpg">'), '<img src="/media/cat.jpg">');
    assert.equal(fixMediaSrc("<img class='x' src='my cat.png' width=10>"), "<img class='x' src='/media/my%20cat.png' width=10>");
    assert.equal(fixMediaSrc('<img src="/media/u1-a.png">'), '<img src="/media/u1-a.png">');
    assert.equal(fixMediaSrc('<img src="https://x.test/a.png">'), '<img src="https://x.test/a.png">');
    assert.equal(fixMediaSrc('<img src="data:image/png;base64,AAAA">'), '<img src="data:image/png;base64,AAAA">');
    assert.equal(fixMediaSrc("<p>沒有圖片</p>"), "<p>沒有圖片</p>");
    assert.equal(fixMediaSrc('<img src="a%20b.png">'), '<img src="/media/a%20b.png">');
  });
});

// 假的 R2：記憶體裡的 Map
function fakeEnv() {
  const files = new Map();
  return {
    files,
    MEDIA: {
      head: async (k) => (files.has(k) ? { size: files.get(k).size } : null),
      list: async ({ prefix }) => ({ objects: [...files].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, size: v.size })), truncated: false }),
      put: async (k, body, opts) => {
        const buf = new Uint8Array(await new Response(body).arrayBuffer());
        files.set(k, { size: buf.length, type: opts.httpMetadata.contentType });
      },
    },
  };
}
const req = (qs, body, headers = {}) =>
  new Request(`https://x.test/api/media?${qs}`, { method: "POST", body, headers: { "Content-Length": String(body?.length ?? 0), ...headers } });

describe("伺服器上傳規則", () => {
  const HASH = "0123456789abcdef";

  test("檔名歸屬：u<uid>- 開頭是私人的", () => {
    assert.equal(userMediaName(7, HASH, "png"), `u7-${HASH}.png`);
    assert.equal(ownerOfKey(`u7-${HASH}.png`), 7);
    assert.equal(ownerOfKey("cambridge-123.mp3"), null);
    assert.equal(ownerOfKey("user-photo.png"), null);
  });

  test("正常上傳：檔名含 uid 與雜湊，內容類型由副檔名決定", async () => {
    const env = fakeEnv();
    const res = await uploadMedia(req(`ext=png&hash=${HASH}`, new Uint8Array(100), { "Content-Type": "text/html" }), env, 3);
    const out = await res.json();
    assert.equal(res.status, 200);
    assert.equal(out.name, `u3-${HASH}.png`);
    assert.equal(env.files.get(out.name).type, "image/png");
    const again = await (await uploadMedia(req(`ext=png&hash=${HASH}`, new Uint8Array(100)), env, 3)).json();
    assert.equal(again.existed, true);
  });

  test("拒絕：不支援的格式、壞雜湊、空檔案、太大", async () => {
    const env = fakeEnv();
    const status = async (qs, body) => (await uploadMedia(req(qs, body), env, 1)).status;
    assert.equal(await status(`ext=svg&hash=${HASH}`, new Uint8Array(10)), 400);
    assert.equal(await status(`ext=html&hash=${HASH}`, new Uint8Array(10)), 400);
    assert.equal(await status(`ext=png&hash=zzzz`, new Uint8Array(10)), 400);
    assert.equal(await status(`ext=png&hash=${HASH}`, new Uint8Array(0)), 400);
    assert.equal(await status(`ext=png&hash=${HASH}`, new Uint8Array(7 * 1024 * 1024)), 413);
    assert.equal(await status(`ext=mp3&hash=${HASH}`, new Uint8Array(7 * 1024 * 1024)), 200, "音檔上限比較大");
    assert.equal(env.files.size, 1);
  });

  test("每人總容量上限", async () => {
    const env = fakeEnv();
    for (let i = 0; i < 25; i++) env.files.set(`u2-${String(i).padStart(16, "0")}.mp3`, { size: 12 * 1024 * 1024 });
    const full = await uploadMedia(req(`ext=mp3&hash=${HASH}`, new Uint8Array(1024)), env, 2);
    assert.equal(full.status, 413);
    const other = await uploadMedia(req(`ext=mp3&hash=${HASH}`, new Uint8Array(1024)), env, 5);
    assert.equal(other.status, 200, "別人的容量不受影響");
  });
});
