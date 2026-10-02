// 密碼在瀏覽器裡先做 PBKDF2（20 萬次），只把結果送給伺服器；明碼不會離開這台裝置。
// 登入頁（伺服器產生的 HTML）和 App 內的「改密碼」共用這一份。
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (s) => new TextEncoder().encode(s);

export const normName = (name) => name.normalize("NFKC").trim().toLowerCase();

export async function derive(username, password) {
  const base = await crypto.subtle.importKey("raw", bytes(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes("yanki:" + normName(username)), iterations: 200000 }, base, 256);
  return hex(bits);
}
