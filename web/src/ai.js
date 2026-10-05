// 片語例句：用 Workers AI 替使用者加進牌組的片語寫一句英文例句和中文翻譯。
// 免費額度每天有限，所以每位使用者每分鐘最多 12 次（只記在這個 Worker 實例的記憶體裡，是粗略的保護）。
import { json, readJson } from "./util.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const recent = new Map(); // uid → 最近的請求時間
const LIMIT = 12;

const SYSTEM =
  "You write one natural English example sentence (8 to 18 words) that uses the given English phrase or collocation, " +
  "for a Taiwanese adult learner preparing for TOEIC. Keep the phrase's wording intact (you may inflect verbs). " +
  "Then translate the sentence into Traditional Chinese as used in Taiwan. " +
  'Reply with JSON only, no other text: {"en":"...","zh":"..."}';

function throttled(uid) {
  const now = Date.now();
  const times = (recent.get(uid) ?? []).filter((t) => now - t < 60000);
  if (times.length >= LIMIT) return true;
  times.push(now);
  recent.set(uid, times);
  return false;
}

export function parseExample(text) {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const en = String(o.en ?? "").trim();
    const zh = String(o.zh ?? "").trim();
    if (!en || !zh || en.length > 220 || zh.length > 120 || !/[一-鿿]/.test(zh)) return null;
    return [en, zh];
  } catch {
    return null;
  }
}

export async function phraseExample(request, env, uid) {
  if (!env.AI) return json({ error: "沒有啟用 AI" }, 503);
  const body = await readJson(request);
  const phrase = String(body?.phrase ?? "").trim();
  const hint = String(body?.zh ?? "").trim();
  if (!phrase || phrase.length > 80) return json({ error: "片語格式不對" }, 400);
  if (throttled(uid)) return json({ error: "一分鐘內請求太多次，請稍後再試" }, 429);
  const user = `Phrase: ${phrase}${hint && hint.length <= 60 && !hint.startsWith("搭配詞") ? `\nMeaning: ${hint}` : ""}`;
  try {
    const out = await env.AI.run(MODEL, {
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      max_tokens: 200,
      temperature: 0.5,
    });
    const ex = parseExample(typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? ""));
    if (!ex) return json({ error: "AI 沒有產生可用的例句" }, 502);
    return json({ ex });
  } catch (err) {
    return json({ error: `AI 暫時無法使用：${String(err?.message ?? err).slice(0, 100)}` }, 502);
  }
}
