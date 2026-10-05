// 朗讀：優先用瀏覽器內建的語音合成（不用下載音檔，離線也能用）；
// 瀏覽器沒有語音、或沒有英文語音時，改用雲端發音（Workers AI，念過的句子會快取在 R2 和這台裝置上）。
// 沒有音檔的單字、新增的卡片、例句都可以聽。
import { getPrefs } from "./prefs.js";

const nativeAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
// 只要能用瀏覽器語音或能播放雲端音檔，朗讀功能就可用
export const ttsAvailable = () => nativeAvailable() || (typeof window !== "undefined" && typeof Audio !== "undefined" && typeof fetch === "function");

// 決定這次用哪個引擎：pref 是使用者的選擇（auto／browser／cloud）；
// 自動模式下，瀏覽器已經載入語音清單、而且裡面沒有任何英文語音，就改用雲端。
export function chooseEngine(pref, native, voices) {
  if (pref === "cloud" || !native) return "cloud";
  if (pref === "browser") return "browser";
  return voices.length && !voices.some((v) => /^en[-_]/i.test(v.lang)) ? "cloud" : "browser";
}

let onError = () => {};
export const setTtsErrorHandler = (fn) => (onError = fn);

const PREFERRED = ["Samantha", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Microsoft Guy", "Karen", "Daniel", "Alex"];
let voice;
function pickVoice() {
  if (voice) return voice;
  const english = speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
  voice = PREFERRED.map((n) => english.find((v) => v.name.includes(n))).find(Boolean) ?? english.find((v) => /^en[-_]US/i.test(v.lang)) ?? english[0];
  return voice;
}
if (nativeAvailable()) speechSynthesis.addEventListener?.("voiceschanged", () => (voice = undefined));

// 一行文字裡中文字的比例：用來從「英文＋中文翻譯」的欄位裡挑出英文那一行。
const cjkShare = (line) => (line.match(/[　-鿿＀-￯]/g)?.length ?? 0) / Math.max(1, line.length);

// 從欄位 HTML 取出要朗讀的英文：去掉標籤、[sound:…]，只留英文為主的第一行。
export function englishOf(html) {
  const text = String(html ?? "")
    .replace(/\[sound:[^\]]*\]/g, " ")
    .replace(/<(br|\/div|\/p|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const line = text.split("\n").map((l) => l.trim()).find((l) => /[A-Za-z]/.test(l) && cjkShare(l) < 0.2);
  return line ?? "";
}

// ---------- 雲端發音 ----------
const TTS_CACHE = "tts-v1";
const blobUrls = new Map(); // 這個頁面載入期間念過的句子
let audio;

async function cloudAudioUrl(text) {
  if (blobUrls.has(text)) return blobUrls.get(text);
  const url = `/api/tts?text=${encodeURIComponent(text)}`;
  let res;
  try {
    const cache = await caches.open(TTS_CACHE);
    res = await cache.match(url);
    if (!res) {
      const fresh = await fetch(url, { credentials: "same-origin" });
      if (!fresh.ok) throw new Error((await fresh.json().catch(() => null))?.error ?? `雲端發音失敗（${fresh.status}）`);
      await cache.put(url, fresh.clone());
      res = fresh;
    }
  } catch (err) {
    if (err instanceof TypeError || !("caches" in globalThis)) {
      // 沒網路、或不能用 Cache API：直接抓
      const fresh = await fetch(url, { credentials: "same-origin" });
      if (!fresh.ok) throw new Error((await fresh.json().catch(() => null))?.error ?? `雲端發音失敗（${fresh.status}）`);
      res = fresh;
    } else throw err;
  }
  const objectUrl = URL.createObjectURL(await res.blob());
  blobUrls.set(text, objectUrl);
  return objectUrl;
}

async function speakCloud(text) {
  try {
    const src = await cloudAudioUrl(text);
    audio?.pause();
    audio = new Audio(src);
    audio.playbackRate = Math.min(1.5, Math.max(0.6, getPrefs().ttsRate / 0.9));
    await audio.play();
  } catch (err) {
    onError(err.name === "NotAllowedError" ? "瀏覽器擋住了自動播放，請按朗讀鈕" : `無法朗讀：${err.message}`);
  }
}

export function speak(text) {
  if (!ttsAvailable() || !text) return false;
  const native = nativeAvailable();
  const engine = chooseEngine(getPrefs().ttsEngine, native, native ? speechSynthesis.getVoices() : []);
  if (engine === "cloud") {
    speakCloud(text);
    return true;
  }
  speechSynthesis.cancel();
  audio?.pause();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = getPrefs().ttsRate;
  const v = pickVoice();
  if (v) u.voice = v;
  u.onerror = (e) => {
    if (e.error && e.error !== "canceled" && e.error !== "interrupted" && getPrefs().ttsEngine !== "browser") speakCloud(text); // 內建語音出錯，改用雲端
  };
  speechSynthesis.speak(u);
  return true;
}

export const stopSpeaking = () => {
  if (nativeAvailable()) speechSynthesis.cancel();
  audio?.pause();
};
