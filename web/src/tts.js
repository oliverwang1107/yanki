// 雲端發音（瀏覽器沒有內建語音、或沒有英文語音時的備援）：用 Workers AI 的 MeloTTS 把英文念成 MP3，
// 並存進 R2（tts/<雜湊>.mp3），同一句話第二次起不再呼叫 AI，所有使用者共用。
import { json, sha256Hex } from "./util.js";

const MODEL = "@cf/myshell-ai/melotts";
const MAX_CHARS = 200;
const LIMIT = 30; // 每位使用者每分鐘最多產生幾句（只算還沒快取的），粗略的保護
const recent = new Map();

export const ttsKey = async (text) => `tts/${(await sha256Hex(text.toLowerCase())).slice(0, 24)}.mp3`;

function throttled(uid) {
  const now = Date.now();
  const times = (recent.get(uid) ?? []).filter((t) => now - t < 60000);
  if (times.length >= LIMIT) return true;
  times.push(now);
  recent.set(uid, times);
  return false;
}

// MeloTTS 實際回傳的常是 WAV（RIFF 開頭）而不是 MP3，內容類型要照實際內容標，Safari 才播得出來。
export function sniffAudioType(bytes) {
  const head = String.fromCharCode(...bytes.slice(0, 4));
  if (head === "RIFF") return "audio/wav";
  if (head === "OggS") return "audio/ogg";
  if (head.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return "audio/mpeg";
}

const audioResponse = (body, type = "audio/mpeg") => new Response(body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff" } });

const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// GET /api/tts?text=…
export async function tts(request, env, uid) {
  const text = (new URL(request.url).searchParams.get("text") ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_CHARS) return json({ error: `文字長度要在 1 到 ${MAX_CHARS} 個字之間` }, 400);
  if (!/[A-Za-z]/.test(text)) return json({ error: "雲端發音只支援英文" }, 400);
  const key = await ttsKey(text);
  const cached = await env.MEDIA.get(key);
  if (cached) return audioResponse(cached.body, cached.httpMetadata?.contentType ?? "audio/mpeg");
  if (!env.AI) return json({ error: "沒有啟用 AI" }, 503);
  if (throttled(uid)) return json({ error: "一分鐘內請求太多次，請稍後再試" }, 429);
  let bytes;
  try {
    const out = await env.AI.run(MODEL, { prompt: text, lang: "en" });
    if (typeof out === "string") bytes = fromBase64(out);
    else if (typeof out?.audio === "string") bytes = fromBase64(out.audio);
    else bytes = new Uint8Array(await new Response(out).arrayBuffer());
  } catch (err) {
    return json({ error: `雲端發音暫時無法使用：${String(err?.message ?? err).slice(0, 100)}` }, 502);
  }
  if (!bytes?.length) return json({ error: "沒有產生聲音" }, 502);
  const type = sniffAudioType(bytes);
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
  return audioResponse(bytes, type);
}
