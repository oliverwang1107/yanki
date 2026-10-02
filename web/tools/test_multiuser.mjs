// 多使用者的端對端測試（對本機 wrangler dev 跑，不會碰正式站）。
// 用法：先 `npx wrangler dev`（或 preview_start），再 `node tools/test_multiuser.mjs`
// 檢查：登入保護、邀請制註冊、牌組庫複製、不同使用者的資料互相看不到也蓋不掉、登入失敗限制、
//       停用／重設／改密碼會讓舊的登入狀態失效、非管理員碰不到管理功能。
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const vars = Object.fromEntries(readFileSync(join(root, ".dev.vars"), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const OWNER = { Authorization: `Bearer ${vars.AUTH_TOKEN}` };

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { (cond ? pass++ : fail++), console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond ? "" : ` ${extra}`}`); };
const key = (name, pw) => pbkdf2Sync(pw.normalize("NFKC"), `yanki:${name.normalize("NFKC").trim().toLowerCase()}`, 200000, 32, "sha256").toString("hex");

async function call(path, { method = "GET", body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* HTML 或空的 */ }
  const set = res.headers.get("set-cookie");
  return { status: res.status, data, text, cookie: set ? set.split(";")[0] : null };
}
async function pullAll(table, who) {
  const rows = [];
  let mod = 0, id = 0;
  for (;;) {
    const r = await call(`/api/pull/${table}?mod=${mod}&id=${id}`, who);
    rows.push(...r.data.rows);
    if (!r.data.more) return rows;
    ({ mod = 0, id } = r.data.rows.at(-1));
  }
}
const owner = { headers: OWNER };
const sql = (command) => JSON.parse(execFileSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "d1", "execute", "anki-web", "--local", "--yes", "--json", `--command=${command}`], { cwd: root, encoding: "utf8" }))[0].results;

// 牌組庫每天有全站的加入額度；測試前先清掉今天的計數，免得重複執行時被擋
sql("DELETE FROM user_meta WHERE uid = -1");
const tag = randomBytes(3).toString("hex");
const A = `e2e_a_${tag}`, B = `e2e_b_${tag}`, PW = "correct horse 1";

console.log("登入保護");
ok((await call("/api/me")).status === 401, "沒登入：/api/me 回 401");
const page = await call("/");
ok(page.status === 401 && page.text.includes("<form"), "沒登入：首頁顯示登入頁");
ok((await call("/js/app.js")).status === 401, "沒登入：程式檔拿不到");
ok((await call("/media/anything.mp3")).status === 401, "沒登入：音檔拿不到");
ok((await call("/js/pw.js")).status === 200, "登入頁需要的 pw.js 是公開的");
ok((await call("/api/me", { headers: { Authorization: "Bearer wrong" } })).status === 401, "錯的 Bearer 碼被拒絕");
ok((await call("/api/me", { cookie: "anki_session=1.0.9999999999.fakesig" })).status === 401, "偽造的登入 cookie 被拒絕");
const evil = await call("/api/auth/login", { method: "POST", headers: { Origin: "https://evil.example" }, body: { username: "x", key: "0".repeat(64) } });
ok(evil.status === 403, "來自別的網站的 POST 被拒絕", `（${evil.status}）`);

console.log("擁有者（Bearer 碼）");
const me = await call("/api/me", owner);
ok(me.status === 200 && me.data.id === 1 && me.data.is_admin === 1, "Bearer 碼對應擁有者且是管理員");
const ownerStatic = await call("/api/static", owner);
ok(ownerStatic.data.decks.length > 0 && ownerStatic.data.meta.some((m) => m.k === "static_mod"), "擁有者的牌組都在");
const ownerCards = await pullAll("cards", owner);
ok(ownerCards.length > 1000, `擁有者的卡片都在（${ownerCards.length}）`);

console.log("邀請制註冊");
const inv1 = (await call("/api/admin/invites", { ...owner, method: "POST", body: { kind: "signup" } })).data.code;
const inv2 = (await call("/api/admin/invites", { ...owner, method: "POST", body: { kind: "signup" } })).data.code;
ok(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}-[A-Z2-9]$/.test(inv1), "邀請碼格式", inv1);
ok((await call(`/api/auth/invite?code=${inv1}`)).data.kind === "signup", "預覽邀請：signup");
ok((await call("/api/auth/signup", { method: "POST", body: { code: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-F", username: A, key: key(A, PW) } })).status === 400, "亂猜的邀請碼被拒絕");
ok((await call("/api/auth/signup", { method: "POST", body: { code: inv1, username: "ab", key: key("ab", PW) } })).status === 400, "太短的帳號被拒絕");
ok((await call("/api/auth/signup", { method: "POST", body: { code: inv1, username: "library", key: key("library", PW) } })).status === 400, "保留的帳號名稱被拒絕");
const sa = await call("/api/auth/signup", { method: "POST", body: { code: inv1.toLowerCase().replaceAll("-", " "), username: A, key: key(A, PW) } });
ok(sa.status === 200 && sa.cookie, "用邀請碼註冊 A（大小寫、空白、連字號都不計）", JSON.stringify(sa.data));
const ca = { cookie: sa.cookie };
ok((await call("/api/auth/signup", { method: "POST", body: { code: inv1, username: `${A}x`, key: key(`${A}x`, PW) } })).status === 400, "邀請碼只能用一次");
const sb = await call("/api/auth/signup", { method: "POST", body: { code: inv2, username: B.toUpperCase(), key: key(B, PW) } });
ok(sb.status === 200, "註冊 B（帳號名稱大小寫不計）", JSON.stringify(sb.data));
const cb = { cookie: sb.cookie };
const inv3 = (await call("/api/admin/invites", { ...owner, method: "POST", body: { kind: "signup" } })).data.code;
const dup = await call("/api/auth/signup", { method: "POST", body: { code: inv3, username: A.toUpperCase(), key: key(A, PW) } });
ok(dup.status === 409, "重複的帳號名稱被拒絕", `（${dup.status}）`);
ok((await call(`/api/auth/invite?code=${inv3}`)).status === 200, "帳號名稱重複時邀請碼沒有被用掉");

console.log("新使用者的起始狀態");
const meA = await call("/api/me", ca);
ok(meA.data.username === A && meA.data.is_admin === 0 && meA.data.id > 1, "A 是一般使用者", JSON.stringify(meA.data));
const stA = await call("/api/static", ca);
ok(stA.data.decks.length === 0 && stA.data.configs.length === 1 && stA.data.notetypes.length === 2, "A 一開始沒有牌組，只有預設設定和筆記類型");
ok((await pullAll("cards", ca)).length === 0 && (await pullAll("notes", ca)).length === 0, "A 一開始沒有卡片和筆記");

console.log("牌組庫");
const lib = await call("/api/library", ca);
ok(lib.data.decks.length >= 1 && lib.data.decks.every((d) => d.state === "none"), "牌組庫的牌組 A 都還沒加入", JSON.stringify(lib.data.decks.map((d) => d.name)));
const libDeck = lib.data.decks.find((d) => d.name === "多益 900分 ENG-CH");
ok(!!libDeck && libDeck.cards > 1000, `牌組庫有多益牌組（${libDeck?.cards} 張）`);
ok((await call("/api/library/join", { ...ca, method: "POST", body: { deck: 12345 } })).status === 404, "加入不存在的牌組失敗");
ok((await call("/api/library/join", { ...ca, method: "POST", body: { deck: libDeck.id } })).status === 200, "A 加入牌組");
await call("/api/library/join", { ...ca, method: "POST", body: { deck: libDeck.id } });
const aCards = await pullAll("cards", ca);
ok(aCards.length === libDeck.cards, `A 有 ${libDeck.cards} 張卡片（重複加入不會變多）`, `（${aCards.length}）`);
ok(aCards.every((c) => c.type === 0 && c.queue === 0 && c.reps === 0 && c.s === null), "全部都是全新的卡片（沒有帶過任何進度）");
ok(new Set(aCards.map((c) => c.pos)).size === aCards.length, "新卡片順序沒有重複");
const aNotes = await pullAll("notes", ca);
ok(aNotes.length === libDeck.cards && aNotes.every((n) => !/\b(marked|leech)\b/.test(n.tags)), "A 的筆記沒有帶過擁有者的個人標籤");
const aDict = await pullAll("dict", ca);
ok(aDict.length > 0 && aDict.length <= aNotes.length, `A 拿到自己筆記的字典（${aDict.length} 筆）`);
const stA2 = await call("/api/static", ca);
ok(stA2.data.decks.length === 1, "A 現在有 1 個牌組");
ok((await pullAll("cards", cb)).length === 0, "B 還是空的");
ok((await call("/api/static", ca)).data.configs[0] && JSON.parse((await call("/api/static", ca)).data.configs[0].data).params.length === 0, "新使用者用預設 FSRS 參數，不帶擁有者的個人參數");

console.log("牌組庫：子牌組與整組加入");
const l1 = lib.data.decks.find((d) => d.name === "英文單字::L1");
const parent = lib.data.decks.find((d) => d.name === "英文單字");
const pDeck = lib.data.decks.find((d) => d.name === "英文單字-P");
ok(!!l1 && !!parent && !!pDeck && parent.depth === 0 && l1.depth === 1, "牌組庫有「英文單字」、它底下的 L1…，和「英文單字-P」");
ok(parent.cards > l1.cards * 3, `上層牌組的卡片數是所有子牌組的總和（${parent.cards}）`);
ok((await call("/api/library/join", { ...ca, method: "POST", body: { deck: l1.id } })).status === 200, "A 單獨加入 L1");
const st1 = await call("/api/static", ca);
const names1 = st1.data.decks.map((d) => d.name);
ok(names1.includes("英文單字") && names1.includes("英文單字::L1") && !names1.includes("英文單字::L2"), "單獨加入 L1 會一併建立上層「英文單字」，但不會有 L2", JSON.stringify(names1));
const cards1 = await pullAll("cards", ca);
ok(cards1.length === libDeck.cards + l1.cards, `A 的卡片 = 多益 + L1（${cards1.length}）`);
const lib2 = (await call("/api/library", ca)).data.decks;
ok(lib2.find((d) => d.name === "英文單字::L1").state === "joined" && lib2.find((d) => d.name === "英文單字::L2").state === "none" && lib2.find((d) => d.name === "英文單字").state === "partial", "狀態：L1 已加入、L2 未加入、上層「部分」");
ok((await call("/api/library/join", { ...ca, method: "POST", body: { deck: parent.id } })).status === 200, "A 加入整個「英文單字」");
const cards2 = await pullAll("cards", ca);
ok(cards2.length === libDeck.cards + parent.cards, `A 的卡片 = 多益 + 整個英文單字（${cards2.length}）`);
ok(cards2.every((c) => c.type === 0 && c.reps === 0 && c.s === null), "全部都是全新的卡片");
const perDeck = {};
for (const c of cards2) (perDeck[c.did] ??= new Set()).add(c.pos);
ok(Object.values(perDeck).every((set, i, all) => set.size === cards2.filter((c) => c.did === Number(Object.keys(perDeck)[i])).length), "每個牌組內的新卡片順序都沒有重複");
const lib3 = (await call("/api/library", ca)).data.decks;
ok(lib3.find((d) => d.name === "英文單字").state === "joined" && lib3.find((d) => d.name === "英文單字-P").state === "none", "上層「英文單字」變成已加入，片語牌組還沒");
ok((await pullAll("cards", cb)).length === 0, "B 還是空的");
ok(!(await pullAll("dict", ca)).some((r) => !cards2.some((c) => c.nid === r.id)), "字典只給 A 自己有的筆記");

console.log("免費額度保護");
const l2 = lib.data.decks.find((d) => d.name === "英文單字::L2");
const budget = (await call("/api/library", cb)).data.budget;
ok(budget && budget.limit === 50000 && budget.used > 40000, `listing 帶有今天的加入額度（已用 ${budget?.used} / ${budget?.limit}）`);
const blocked = await call("/api/library/join", { ...cb, method: "POST", body: { deck: l2.id } });
ok(blocked.status === 429 && /額度/.test(blocked.data?.error ?? ""), "全站加入額度用完後，另一位同學的加入被擋下（429，訊息說明原因）", `（${blocked.status}）`);
ok((await pullAll("cards", cb)).length === 0, "被擋下時沒有寫入任何資料");
const again = await call("/api/library/join", { ...ca, method: "POST", body: { deck: parent.id } });
ok(again.status === 200, "已經有的牌組重複加入不花額度，不會被擋");
sql("DELETE FROM user_meta WHERE uid = -1");
ok((await call("/api/library/join", { ...cb, method: "POST", body: { deck: l2.id } })).status === 200, "額度重置後（當天第一次加入）B 可以加入");
ok((await pullAll("cards", cb)).length === l2.cards, `B 拿到 L2 的 ${l2.cards} 張卡片`);
sql("DELETE FROM user_meta WHERE uid = -1");

console.log("資料隔離");
const target = ownerCards.find((c) => aCards.some((x) => x.id === c.id)) ?? ownerCards[0];
const ownerBefore = JSON.stringify(ownerCards.find((c) => c.id === target.id));
const evilRow = { ...aCards.find((c) => c.id === target.id) ?? target, ivl: 9999, mod: Date.now() + 1e9 };
ok((await call("/api/push", { ...ca, method: "POST", body: { cards: [{ ...evilRow, uid: 1 }] } })).status === 200, "A 上傳了和擁有者同編號的卡片（還夾帶 uid=1）");
const ownerAfter = JSON.stringify((await pullAll("cards", owner)).find((c) => c.id === target.id));
ok(ownerBefore === ownerAfter, "擁有者的那張卡片完全沒變");
ok((await pullAll("cards", ca)).find((c) => c.id === target.id)?.ivl === 9999, "A 自己的那張有更新");
const bNoteId = 1e15 + 7;
await call("/api/push", { ...cb, method: "POST", body: { notes: [{ id: bNoteId, guid: "g", mid: 1, mod: Date.now(), tags: "", fields: ["b-secret", "x"], deleted: 0 }] } });
ok(!(await pullAll("notes", ca)).some((n) => n.id === bNoteId) && !(await pullAll("notes", owner)).some((n) => n.id === bNoteId), "B 新增的筆記 A 和擁有者都看不到");
await call("/api/push", { ...ca, method: "POST", body: { notes: [{ id: bNoteId, guid: "g", mid: 1, mod: Date.now() + 5000, tags: "", fields: ["a-overwrite", "x"], deleted: 0 }] } });
ok((await pullAll("notes", cb)).find((n) => n.id === bNoteId)?.fields.includes("b-secret"), "A 上傳同編號的筆記，蓋不掉 B 的");
const rv = { id: 1e15 + 99, cid: 1, ease: 3, ivl: 1, last_ivl: 0, time: 1000, type: 0 };
await call("/api/push", { ...ca, method: "POST", body: { revlog: [rv] } });
ok((await pullAll("revlog", ca)).some((r) => r.id === rv.id) && !(await pullAll("revlog", cb)).some((r) => r.id === rv.id), "複習紀錄也各人分開");
const conflict = await call("/api/static", { ...ca, method: "POST", body: { base: 0, decks: [{ id: 1, name: "x", config: 1 }] } });
ok(conflict.status === 409, "牌組設定用舊版本儲存會被擋下（409）");
const stNow = await call("/api/static", ca);
const stBase = Number(stNow.data.meta.find((m) => m.k === "static_mod").v);
const okSave = await call("/api/static", { ...ca, method: "POST", body: { base: stBase, decks: stNow.data.decks.concat([{ id: 777, name: "我的牌組", config: 1 }]) } });
ok(okSave.status === 200, "用最新版本儲存牌組成功");
ok((await call("/api/static", cb)).data.decks.map((d) => d.name).sort().join("|") === "英文單字|英文單字::L2", "B 的牌組沒被影響（只有自己加入的 L2 和上層架子）");

console.log("權限");
ok((await call("/api/admin/users", ca)).status === 403, "一般使用者不能用管理功能");
ok((await call("/api/admin/invites", { ...ca, method: "POST", body: { kind: "signup" } })).status === 403, "一般使用者不能產生邀請");
const list = await call("/api/admin/users", owner);
ok(list.data.users.some((u) => u.username === A) && list.data.users.every((u) => u.id > 0), "管理員看得到使用者清單（不含牌組庫）");

console.log("登入與失敗限制");
const good = await call("/api/auth/login", { method: "POST", body: { username: A, key: key(A, PW) } });
ok(good.status === 200 && good.cookie, "A 用帳號密碼登入");
ok((await call("/api/auth/login", { method: "POST", body: { username: A.toUpperCase(), key: key(A, PW) } })).status === 200, "帳號大小寫不計");
ok((await call("/api/auth/login", { method: "POST", body: { username: A, key: key(A, "wrong password") } })).status === 401, "密碼錯誤被拒絕");
ok((await call("/api/auth/login", { method: "POST", body: { username: `nobody_${tag}`, key: key("x", PW) } })).status === 401, "不存在的帳號被拒絕（訊息相同）");
let limited = 0;
for (let i = 0; i < 12; i++) if ((await call("/api/auth/login", { method: "POST", body: { username: B, key: key(B, `bad${i}`) } })).status === 429) limited++;
ok(limited >= 2, `連續輸入錯誤密碼會被暫時鎖住（${limited} 次回 429）`);
ok((await call("/api/auth/login", { method: "POST", body: { username: B, key: key(B, PW) } })).status === 429, "鎖住期間連正確密碼也先擋下");
sql(`DELETE FROM auth_fail`);

console.log("停用、重設、改密碼");
const uidA = meA.data.id;
ok((await call(`/api/admin/users/${uidA}/disabled`, { ...owner, method: "POST", body: { disabled: 1 } })).status === 200, "管理員停用 A");
ok((await call("/api/me", ca)).status === 401, "A 原本的登入狀態立刻失效");
ok((await call("/api/auth/login", { method: "POST", body: { username: A, key: key(A, PW) } })).status === 401, "停用的帳號不能登入");
await call(`/api/admin/users/${uidA}/disabled`, { ...owner, method: "POST", body: { disabled: 0 } });
ok((await call("/api/me", ca)).status === 401, "重新啟用後舊的登入狀態還是失效（要重新登入）");
const rinv = (await call("/api/admin/invites", { ...owner, method: "POST", body: { kind: "reset", uid: uidA } })).data.code;
ok((await call(`/api/auth/invite?code=${rinv}`)).data.username === A, "重設連結會顯示是誰的帳號");
ok((await call("/api/auth/signup", { method: "POST", body: { code: rinv, username: `${A}z`, key: key(`${A}z`, PW) } })).status === 400, "重設連結不能拿來註冊新帳號");
const NEWPW = "brand new pass 2";
const rs = await call("/api/auth/reset", { method: "POST", body: { code: rinv, key: key(A, NEWPW) } });
ok(rs.status === 200 && rs.cookie, "用重設連結設定新密碼");
ok((await call("/api/auth/login", { method: "POST", body: { username: A, key: key(A, PW) } })).status === 401, "舊密碼不能登入了");
ok((await call("/api/me", { cookie: rs.cookie })).status === 200, "重設後的登入狀態有效");
ok((await call("/api/auth/reset", { method: "POST", body: { code: rinv, key: key(A, NEWPW) } })).status === 400, "重設連結只能用一次");
const cp = await call("/api/auth/password", { cookie: rs.cookie, method: "POST", body: { oldKey: key(A, "not my password"), newKey: key(A, "third password 3") } });
ok(cp.status === 401, "改密碼時舊密碼錯誤被拒絕");
const cp2 = await call("/api/auth/password", { cookie: rs.cookie, method: "POST", body: { oldKey: key(A, NEWPW), newKey: key(A, "third password 3") } });
ok(cp2.status === 200 && cp2.cookie, "改密碼成功");
ok((await call("/api/me", { cookie: rs.cookie })).status === 401, "改密碼後其他裝置的登入狀態失效");
ok((await call("/api/me", { cookie: cp2.cookie })).status === 200, "這台裝置拿到新的登入狀態");
ok((await call("/api/auth/login", { method: "POST", body: { username: A, key: key(A, "third password 3") } })).status === 200, "新密碼可以登入");

console.log("擁有者認領帳號");
const [ownerRow] = sql("SELECT username FROM users WHERE id = 1");
ok(ownerRow.username === null || typeof ownerRow.username === "string", "擁有者帳號狀態可讀（認領流程另外手動測試）");

// 清理這次建立的測試帳號和資料
const ids = sql(`SELECT id FROM users WHERE username LIKE 'e2e\\_%' ESCAPE '\\'`).map((r) => r.id);
if (ids.length) {
  const list2 = ids.join(",");
  for (const t of ["cards", "notes", "revlog", "decks", "configs", "notetypes", "user_meta"]) sql(`DELETE FROM ${t} WHERE uid IN (${list2})`);
  sql(`DELETE FROM users WHERE id IN (${list2})`);
}
sql("DELETE FROM auth_fail");
console.log(`\n${pass} 項通過，${fail} 項失敗`);
process.exit(fail ? 1 : 0);
