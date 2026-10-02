// Worker 共用的小工具。
export const enc = new TextEncoder();

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

export const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
export const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s) => toHex(await sha256(s));
export const b64url = (u8) => btoa(String.fromCharCode(...u8)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

// 比對祕密值：先各自雜湊成固定長度再用常數時間比較，避免從回應時間猜出內容。
export async function sameSecret(a, b) {
  return crypto.subtle.timingSafeEqual(await sha256(String(a)), await sha256(String(b)));
}

export function cookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
}

// 讀 JSON 請求本體；格式不對就回 null。
export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

export const now = () => Date.now();

// 隨機邀請碼：128 位元，轉成 base32（排除容易看錯的字母），每 5 碼一組。
export function randomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{1,5}/g).join("-");
}

// 邀請碼比對前先正規化（大小寫、空白、連字號都不計）。
export const normCode = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
