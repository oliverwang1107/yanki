// 管理工具（直接寫資料庫，不需要登入）：
//   node tools/admin.mjs claim-link local|remote        產生「認領擁有者帳號」的一次性連結（第一次升級後用）
//   node tools/admin.mjs invite local|remote            產生新同學的註冊邀請連結（7 天內有效，只能用一次）
//   node tools/admin.mjs reset-link local|remote <帳號>  產生重設某人密碼的連結（24 小時內有效）
//   node tools/admin.mjs users local|remote             列出所有使用者
//   node tools/admin.mjs disable|enable local|remote <帳號>
// 邀請碼只存雜湊；連結只會在這裡顯示一次。
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [cmd, target, arg] = process.argv.slice(2);
if (!cmd || !["local", "remote"].includes(target)) {
  console.error("用法：node tools/admin.mjs <claim-link|invite|reset-link|users|disable|enable> local|remote [帳號]");
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const BASE = target === "local" ? "http://localhost:8787" : "https://yanki.yaya1107.dpdns.org";
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const sql = (command) =>
  JSON.parse(
    execFileSync(process.execPath, [wrangler, "d1", "execute", "anki-web", `--${target}`, "--yes", "--json", `--command=${command}`], {
      cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, maxBuffer: 1 << 24,
    })
  )[0].results;

function newCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chars = Array.from(randomBytes(26), (b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{1,5}/g).join("-");
}
function invite(kind, uid, hours) {
  const code = newCode();
  const hash = createHash("sha256").update(code.replace(/[^A-Z0-9]/g, "")).digest("hex");
  const t = Date.now();
  sql(`INSERT INTO invites (code_hash, kind, uid, created_by, created_at, expires_at) VALUES (${q(hash)}, ${q(kind)}, ${uid ?? "NULL"}, 1, ${t}, ${t + hours * 3600000})`);
  return code;
}
const user = (name) => {
  const [u] = sql(`SELECT id, username FROM users WHERE username = ${q(name)} AND id > 0`);
  if (!u) throw new Error(`找不到帳號 ${name}`);
  return u;
};

if (cmd === "claim-link") {
  const [owner] = sql("SELECT id, username FROM users WHERE id = 1");
  if (owner.username) throw new Error(`擁有者帳號已經設定過了（${owner.username}），要重設密碼請用 reset-link`);
  console.log(`${BASE}/signup?code=${invite("claim", 1, 24)}\n（24 小時內有效，只能用一次；用來設定你自己的帳號和密碼）`);
} else if (cmd === "invite") {
  console.log(`${BASE}/signup?code=${invite("signup", null, 7 * 24)}\n（7 天內有效，只能用一次）`);
} else if (cmd === "reset-link") {
  if (!arg) throw new Error("請給帳號名稱");
  console.log(`${BASE}/reset?code=${invite("reset", user(arg).id, 24)}\n（24 小時內有效，只能用一次）`);
} else if (cmd === "users") {
  for (const u of sql("SELECT id, username, is_admin, disabled, created_at, last_login, (SELECT COUNT(*) FROM cards c WHERE c.uid = users.id AND c.deleted = 0) AS cards, (SELECT COUNT(*) FROM revlog r WHERE r.uid = users.id) AS reviews FROM users WHERE id > 0 ORDER BY id")) {
    const d = (t) => (t ? new Date(t).toLocaleString("zh-TW") : "—");
    console.log(`#${u.id} ${u.username ?? "（尚未設定帳號）"}${u.is_admin ? " [管理員]" : ""}${u.disabled ? " [已停用]" : ""}  卡片 ${u.cards}  複習 ${u.reviews}  最近登入 ${d(u.last_login)}`);
  }
} else if (cmd === "disable" || cmd === "enable") {
  if (!arg) throw new Error("請給帳號名稱");
  sql(`UPDATE users SET disabled = ${cmd === "disable" ? 1 : 0}, sess_ver = sess_ver + 1 WHERE id = ${user(arg).id}`);
  console.log(`${arg} 已${cmd === "disable" ? "停用" : "啟用"}`);
} else {
  throw new Error(`未知的指令 ${cmd}`);
}
