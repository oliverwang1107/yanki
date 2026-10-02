// 朗讀：用瀏覽器內建的語音合成（不用下載音檔，離線也能用）。
// 沒有音檔的單字、新增的卡片、例句都可以聽。
import { getPrefs } from "./prefs.js";

export const ttsAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

const PREFERRED = ["Samantha", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Microsoft Guy", "Karen", "Daniel", "Alex"];
let voice;
function pickVoice() {
  if (voice) return voice;
  const english = speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
  voice = PREFERRED.map((n) => english.find((v) => v.name.includes(n))).find(Boolean) ?? english.find((v) => /^en[-_]US/i.test(v.lang)) ?? english[0];
  return voice;
}
if (ttsAvailable()) speechSynthesis.addEventListener?.("voiceschanged", () => (voice = undefined));

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

export function speak(text) {
  if (!ttsAvailable() || !text) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = getPrefs().ttsRate;
  const v = pickVoice();
  if (v) u.voice = v;
  speechSynthesis.speak(u);
  return true;
}

export const stopSpeaking = () => ttsAvailable() && speechSynthesis.cancel();
