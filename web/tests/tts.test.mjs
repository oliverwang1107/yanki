// 朗讀：選擇引擎、雲端發音（假的 R2 與 AI）。node --test tests/
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chooseEngine } from "../public/js/tts.js";
import { sniffAudioType, tts, ttsKey } from "../src/tts.js";

describe("選擇發音引擎", () => {
  const en = [{ lang: "en-US" }];
  const zh = [{ lang: "zh-TW" }, { lang: "ja-JP" }];
  test("自動：有英文語音用瀏覽器；沒有英文語音或沒有語音功能用雲端", () => {
    assert.equal(chooseEngine("auto", true, en), "browser");
    assert.equal(chooseEngine("auto", true, []), "browser", "語音清單還沒載入時先用瀏覽器");
    assert.equal(chooseEngine("auto", true, zh), "cloud");
    assert.equal(chooseEngine("auto", false, []), "cloud");
  });
  test("使用者指定時照他的選擇（瀏覽器不能用時仍改用雲端）", () => {
    assert.equal(chooseEngine("cloud", true, en), "cloud");
    assert.equal(chooseEngine("browser", true, zh), "browser");
    assert.equal(chooseEngine("browser", false, []), "cloud");
  });
});

function fakeEnv({ ai } = {}) {
  const files = new Map();
  const types = new Map();
  return {
    files,
    MEDIA: {
      get: async (k) => (files.has(k) ? { body: files.get(k), httpMetadata: { contentType: types.get(k) } } : null),
      put: async (k, bytes, opts) => (files.set(k, bytes), types.set(k, opts?.httpMetadata?.contentType)),
    },
    ...(ai ? { AI: { run: ai } } : {}),
  };
}
const get = (text) => new Request(`https://x.test/api/tts?text=${encodeURIComponent(text)}`);
const b64 = (s) => btoa(s);

describe("雲端發音伺服器", () => {
  test("第一次呼叫 AI 並存進 R2，第二次直接用快取", async () => {
    let calls = 0;
    const env = fakeEnv({ ai: async (model, input) => { calls++; assert.equal(input.lang, "en"); return { audio: b64("MP3DATA") }; } });
    const r1 = await tts(get("Practice makes perfect."), env, 1);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("Content-Type"), "audio/mpeg");
    assert.equal(new TextDecoder().decode(await r1.arrayBuffer()), "MP3DATA");
    const r2 = await tts(get("practice  makes   perfect."), env, 2); // 大小寫、空白不同也算同一句
    assert.equal(r2.status, 200);
    assert.equal(calls, 1);
    assert.equal(env.files.size, 1);
    assert.ok([...env.files.keys()][0].startsWith("tts/"));
  });

  test("拒絕：沒有文字、太長、沒有英文字母", async () => {
    const env = fakeEnv({ ai: async () => ({ audio: b64("x") }) });
    assert.equal((await tts(get(""), env, 1)).status, 400);
    assert.equal((await tts(get("a".repeat(201)), env, 1)).status, 400);
    assert.equal((await tts(get("你好嗎"), env, 1)).status, 400);
    assert.equal(env.files.size, 0);
  });

  test("AI 失敗或沒有 AI 時回清楚的錯誤", async () => {
    const bad = fakeEnv({ ai: async () => { throw new Error("quota"); } });
    const r = await tts(get("hello"), bad, 1);
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /quota/);
    assert.equal((await tts(get("hello"), fakeEnv(), 1)).status, 503);
    const empty = fakeEnv({ ai: async () => ({ audio: "" }) });
    assert.equal((await tts(get("hello"), empty, 1)).status, 502);
  });

  test("每位使用者每分鐘最多 30 句（只算還沒快取的）", async () => {
    const env = fakeEnv({ ai: async () => ({ audio: b64("x") }) });
    for (let i = 0; i < 30; i++) assert.equal((await tts(get(`word number ${i}`), env, 9)).status, 200);
    assert.equal((await tts(get("one more word"), env, 9)).status, 429);
    assert.equal((await tts(get("word number 3"), env, 9)).status, 200, "已快取的不受限制");
    assert.equal((await tts(get("one more word"), env, 10)).status, 200, "別人不受影響");
  });

  test("依實際內容標示聲音格式（MeloTTS 常回傳 WAV）", async () => {
    assert.equal(sniffAudioType(new TextEncoder().encode("RIFF....WAVE")), "audio/wav");
    assert.equal(sniffAudioType(new TextEncoder().encode("ID3")), "audio/mpeg");
    assert.equal(sniffAudioType(new Uint8Array([0xff, 0xfb, 0x90])), "audio/mpeg");
    const env = fakeEnv({ ai: async () => ({ audio: btoa("RIFF1234WAVEdata") }) });
    const r = await tts(get("hello wav"), env, 1);
    assert.equal(r.headers.get("Content-Type"), "audio/wav");
    const again = await tts(get("hello wav"), env, 1);
    assert.equal(again.headers.get("Content-Type"), "audio/wav", "快取的檔案也用同樣的類型");
  });

  test("快取鍵：同樣的句子（忽略大小寫）同一把", async () => {
    assert.equal(await ttsKey("Hello"), await ttsKey("hello"));
    assert.notEqual(await ttsKey("hello"), await ttsKey("hello!"));
  });
});
