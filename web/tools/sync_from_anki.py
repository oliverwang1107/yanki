"""把「快照之後」在桌面 Anki 做的複習與修改合併進網頁版（切換用的匯入器）。

預設只做「試跑」：讀取（Anki 收藏的副本 + 網頁版目前的資料），印出會改什麼，不寫入任何東西。
確認後加 --apply 才會寫入。完全不會碰你真正的 Anki 收藏（只讀副本）。

    python tools/sync_from_anki.py                    試跑，對正式站
    python tools/sync_from_anki.py --apply            真的寫入正式站
    python tools/sync_from_anki.py --target local     對本機 wrangler dev（http://127.0.0.1:8787）
    python tools/sync_from_anki.py --collection X     用指定的 .anki2 檔（測試用，不複製）
    python tools/sync_from_anki.py --apply-deletes    也把「Anki 裡已刪除、網頁版沒再動過」的筆記刪掉
    python tools/sync_from_anki.py --media            把 Anki 新增的媒體檔複製到 public/media/（要再 wrangler deploy）

合併規則（和網頁版的 push 一樣，以 mod 較新者為準，複習紀錄取聯集）：
  - 複習紀錄 revlog：Anki 有、網頁版沒有的全部補上（id 是毫秒時間戳，重複會被忽略）。
  - 卡片：兩邊都有時，看誰最近一次複習比較晚；複習時間相同就看有沒有內容變動（暫停、旗標、換牌組…），
    Anki 的 mod 比網頁版新且內容不同才採用 Anki。只在 Anki 有的卡片（快照之後新增）直接加入。
  - 筆記：只在 Anki 有的加入；兩邊都有且 Anki 的 mod 較新、內容不同就採用 Anki。
  - 牌組、筆記類型、設定組：Anki 有、網頁版沒有的會「新增」（不會刪除或覆蓋網頁版已有的）。
"""
import argparse
import http.cookiejar  # noqa: F401  (保持標準函式庫相依一致)
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_anki import PROFILE_DIR, copy_collection  # noqa: E402

from anki.collection import Collection  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROD_URL = "https://yanki.yaya1107.dpdns.org"
LOCAL_URL = "http://127.0.0.1:8787"
BATCH = 400  # Worker 一次最多 500 筆，留一點餘裕
CARD_KEYS = ["did", "ord", "type", "queue", "ivl", "reps", "lapses", "left", "s", "d", "lrt", "pos", "due_ts", "due_day", "flags", "bury_day"]


# ---------- 連線 ----------
def read_token(target):
    if target == "local":
        for line in open(os.path.join(ROOT, ".dev.vars"), encoding="utf-8"):
            if line.startswith("AUTH_TOKEN="):
                return line.split("=", 1)[1].strip()
        raise SystemExit(".dev.vars 裡找不到 AUTH_TOKEN")
    return open(os.path.join(ROOT, ".prod-token"), encoding="utf-8").read().strip()


class Api:
    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self.headers = {"Authorization": "Bearer " + token, "User-Agent": "anki-web-importer/1", "Accept": "application/json"}  # 工具專用的 AUTH_TOKEN，對應擁有者帳號

    def call(self, path, body=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = dict(self.headers)
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method="POST" if data is not None else "GET")
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    raise SystemExit(f"{path} 回 {e.code}：AUTH_TOKEN 不對（.prod-token / .dev.vars）或被擋下")
                if e.code == 409:
                    raise
                if attempt == 3 or e.code < 500:
                    raise SystemExit(f"{path} 失敗：HTTP {e.code} {e.read()[:200]!r}")
            except (urllib.error.URLError, TimeoutError):
                if attempt == 3:
                    raise
            time.sleep(1.5 * (attempt + 1))

    def pull_all(self, table):
        rows, mod, id_ = [], 0, 0
        while True:
            q = {"id": id_} if table == "revlog" else {"mod": mod, "id": id_}
            res = self.call(f"/api/pull/{table}?" + urllib.parse.urlencode(q))
            rows += res["rows"]
            if not res["more"]:
                return rows
            last = rows[-1]
            mod, id_ = last.get("mod", 0), last["id"]


# ---------- 讀 Anki ----------
def read_anki(col):
    tz = time.localtime().tm_gmtoff
    rollover = col.get_config("rollover") or 4

    def web_day(ts):
        return (ts + tz - rollover * 3600) // 86400

    def day_to_ts(day):
        return day * 86400 - tz + rollover * 3600

    now = int(time.time())
    shift = web_day(now) - col.sched.today
    today = web_day(now)

    notes = {}
    for i, g, mid, mod, tags, flds in col.db.all("select id,guid,mid,mod,tags,flds from notes"):
        notes[i] = {"id": i, "guid": g, "mid": mid, "mod": mod * 1000, "tags": tags.strip(), "fields": flds.split("\x1f"), "deleted": 0}

    cards = {}
    for cid, nid, did, ord_, type_, queue, due, ivl, reps, lapses, left, mod, flags, data in col.db.all(
        "select id,nid,did,ord,type,queue,due,ivl,reps,lapses,left,mod,flags,data from cards"
    ):
        extra = json.loads(data) if data else {}
        c = {
            "id": cid, "nid": nid, "did": did, "ord": ord_, "type": type_, "queue": queue, "ivl": ivl, "reps": reps,
            "lapses": lapses, "left": left, "mod": mod * 1000, "s": extra.get("s"), "d": extra.get("d"), "lrt": extra.get("lrt"),
            "pos": None, "due_ts": None, "due_day": None, "flags": flags & 7, "bury_day": None, "deleted": 0,
        }
        eff = queue
        if queue == 3:  # 跨日學習：網頁版沒有這個佇列，換成當天結束時到期的學習卡
            c["queue"], eff = 1, 3
            c["due_ts"] = day_to_ts(due + shift)
        elif queue in (-2, -3):  # 擱置：維持到明天再放出來
            c["queue"], c["bury_day"] = -3, today
        if eff == 3:
            pass
        elif type_ == 0:
            c["pos"] = due
        elif type_ == 2:
            c["due_day"] = due + shift
        else:  # 學習中／重學
            c["due_ts"] = due if due > 10**8 else day_to_ts(due + shift)
        cards[cid] = c

    revlog = {}
    last_review = {}
    for i, cid, ease, ivl, last, t, ty in col.db.all("select id,cid,ease,ivl,lastIvl,time,type from revlog"):
        revlog[i] = {"id": i, "cid": cid, "ease": ease, "ivl": ivl, "last_ivl": last, "time": t, "type": ty}
        if i > last_review.get(cid, 0):
            last_review[cid] = i

    # 筆記類型、牌組、設定組（只用來補「網頁版沒有的」）
    notetypes = {}
    for m in col.models.all():
        if len(m["tmpls"]) != 1 or m["type"] != 0:
            continue  # 只有被筆記用到才會在 main() 裡警告
        t = m["tmpls"][0]
        notetypes[m["id"]] = {"id": m["id"], "name": m["name"], "fields": [f["name"] for f in m["flds"]], "qfmt": t["qfmt"], "afmt": t["afmt"], "css": m["css"]}
    decks, configs = {}, {}
    for d in col.decks.all_names_and_ids():
        cfg = col.decks.config_dict_for_deck_id(d.id)
        decks[d.id] = {"id": d.id, "name": d.name, "config": cfg["id"]}
        configs[cfg["id"]] = {
            "id": cfg["id"], "name": cfg["name"], "newPerDay": cfg["new"]["perDay"], "revPerDay": cfg["rev"]["perDay"],
            "maxIvl": cfg["rev"]["maxIvl"], "desiredRetention": cfg["desiredRetention"], "learnSteps": cfg["new"]["delays"],
            "relearnSteps": cfg["lapse"]["delays"], "minLapseIvl": cfg["lapse"]["minInt"], "params": cfg["fsrsParams6"],
            "leechFails": cfg["lapse"].get("leechFails", 8), "leechAction": "suspend" if cfg["lapse"].get("leechAction", 1) == 0 else "tag",
            "buryNew": bool(cfg["new"].get("bury", False)), "buryReviews": bool(cfg["rev"].get("bury", False)),
        }
    return {"notes": notes, "cards": cards, "revlog": revlog, "last_review": last_review, "notetypes": notetypes, "decks": decks, "configs": configs, "today": today}


# ---------- 合併 ----------
def num_eq(a, b):
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) < 1e-6


def same_card(a, p):
    for k in CARD_KEYS:
        x, y = a.get(k), p.get(k)
        if k in ("s", "d"):
            ok = num_eq(x, y)
        elif k in ("flags", "bury_day", "left"):
            ok = (x or 0) == (y or 0)
        else:
            ok = x == y
        if not ok:
            return False
    return True


def same_note(a, p):
    return a["fields"] == p["fields"] and a["tags"].split() == p["tags"].split() and a["mid"] == p["mid"]


def plan(anki, prod):
    P_notes = {}
    for r in prod["notes"]:
        r["fields"] = json.loads(r["fields"]) if isinstance(r["fields"], str) else r["fields"]
        P_notes[r["id"]] = r
    P_cards = {r["id"]: r for r in prod["cards"]}
    P_revlog = {r["id"]: r for r in prod["revlog"]}
    P_last = {}
    for rid, r in P_revlog.items():
        if rid > P_last.get(r["cid"], 0):
            P_last[r["cid"]] = rid

    out = {"notes": [], "cards": [], "revlog": [], "deletes": [], "conflicts": [], "stats": {}}
    stats = out["stats"]
    for k in ("notes_new", "notes_update", "notes_web_newer", "cards_new", "cards_anki_newer", "cards_web_newer", "cards_unchanged", "revlog_new", "web_only_notes", "deleted_in_anki"):
        stats[k] = 0

    # 筆記
    for nid, n in anki["notes"].items():
        p = P_notes.get(nid)
        if p is None:
            out["notes"].append(n)
            stats["notes_new"] += 1
        elif p.get("deleted"):
            continue
        elif n["mod"] > p["mod"] and not same_note(n, p):
            out["notes"].append(n)
            stats["notes_update"] += 1
        elif p["mod"] > n["mod"] and not same_note(n, p):
            stats["notes_web_newer"] += 1

    # 卡片
    for cid, c in anki["cards"].items():
        p = P_cards.get(cid)
        if p is None:
            out["cards"].append(c)
            stats["cards_new"] += 1
            continue
        if p.get("deleted"):
            continue
        la, lp = anki["last_review"].get(cid, 0), P_last.get(cid, 0)
        # 只看網頁版沒有的複習：Anki 的最新複習不在網頁版的紀錄裡，才算 Anki 較新
        a_has_new_review = la > lp and la not in P_revlog
        if a_has_new_review:
            win = "anki"
        elif lp > la:
            win = "web"
        else:
            # Anki 的旗標變更不會更新 mod，所以 mod 相同（＝快照之後網頁版沒動過）但內容不同也算 Anki 較新
            win = "anki" if (c["mod"] >= p["mod"] and not same_card(c, p)) else "same"
        if win == "anki":
            out["cards"].append(c)
            stats["cards_anki_newer"] += 1
            if p["mod"] > c["mod"] and lp >= la:
                out["conflicts"].append(cid)
        elif win == "web":
            stats["cards_web_newer"] += 1
            if c["mod"] > p["mod"] and not same_card(c, p):
                out["conflicts"].append(cid)
        else:
            stats["cards_unchanged"] += 1

    # 複習紀錄
    for rid, r in anki["revlog"].items():
        if rid not in P_revlog:
            out["revlog"].append(r)
            stats["revlog_new"] += 1

    # 網頁版才有的筆記、以及 Anki 已刪除的筆記
    exported_at = int(prod["meta"].get("exportedAt", 0)) * 1000
    for nid, p in P_notes.items():
        if nid in anki["notes"] or p.get("deleted"):
            continue
        if p["mod"] <= exported_at:  # 快照之後沒人動過，代表是在 Anki 刪掉的
            stats["deleted_in_anki"] += 1
            out["deletes"].append(nid)
        else:
            stats["web_only_notes"] += 1
    return out, P_cards, P_notes


def missing_static(anki, static):
    have_nt = {n["id"] for n in static["notetypes"]}
    have_dk = {d["id"] for d in static["decks"]}
    have_cf = {json.loads(c["data"])["id"] for c in static["configs"]}
    used_mid = {n["mid"] for n in anki["notes"].values()}
    used_did = {c["did"] for c in anki["cards"].values()}
    nts = [anki["notetypes"][i] for i in used_mid if i not in have_nt and i in anki["notetypes"]]
    dks = [anki["decks"][i] for i in used_did if i not in have_dk and i in anki["decks"]]
    cfs = [anki["configs"][d["config"]] for d in dks if d["config"] not in have_cf and d["config"] in anki["configs"]]
    cfs = list({c["id"]: c for c in cfs}.values())
    unknown = [i for i in used_mid if i not in have_nt and i not in anki["notetypes"]]
    return nts, dks, cfs, unknown


def chunks(rows, n=BATCH):
    for i in range(0, len(rows), n):
        yield rows[i:i + n]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", choices=["prod", "local"], default="prod")
    ap.add_argument("--base-url")
    ap.add_argument("--collection", help="指定 .anki2 檔（測試用）；預設複製你 Anki 目前的收藏")
    ap.add_argument("--apply", action="store_true", help="真的寫入（預設只試跑）")
    ap.add_argument("--apply-deletes", action="store_true")
    ap.add_argument("--media", action="store_true")
    args = ap.parse_args()

    base = args.base_url or (LOCAL_URL if args.target == "local" else PROD_URL)
    api = Api(base, read_token(args.target))
    print(f"網頁版：{base}  模式：{'寫入' if args.apply else '試跑（不寫入）'}")

    path = args.collection or copy_collection()
    col = Collection(path)
    try:
        anki = read_anki(col)
    finally:
        col.close()
    print(f"Anki：筆記 {len(anki['notes'])}  卡片 {len(anki['cards'])}  複習紀錄 {len(anki['revlog'])}")

    static = api.call("/api/static")
    prod = {"meta": {r["k"]: r["v"] for r in static["meta"]}}
    for t in ("notes", "cards", "revlog"):
        prod[t] = api.pull_all(t)
    print(f"網頁版：筆記 {len(prod['notes'])}  卡片 {len(prod['cards'])}  複習紀錄 {len(prod['revlog'])}")

    out, P_cards, P_notes = plan(anki, prod)
    s = out["stats"]
    nts, dks, cfs, unknown = missing_static(anki, static)
    print("\n會做的事：")
    print(f"  複習紀錄：新增 {s['revlog_new']}")
    print(f"  筆記：新增 {s['notes_new']}、改用 Anki 版本 {s['notes_update']}、網頁版較新而保留 {s['notes_web_newer']}")
    print(f"  卡片：新增 {s['cards_new']}、改用 Anki 狀態 {s['cards_anki_newer']}、網頁版較新而保留 {s['cards_web_newer']}、沒變 {s['cards_unchanged']}")
    print(f"  牌組／筆記類型／設定組：新增 {len(dks)} / {len(nts)} / {len(cfs)}")
    print(f"  只在網頁版的筆記（保留）：{s['web_only_notes']}；Anki 已刪除且網頁版沒再動過：{s['deleted_in_anki']}"
          f"（{'會刪除' if args.apply_deletes else '不處理，加 --apply-deletes 才會刪'}）")
    if out["conflicts"]:
        print(f"  兩邊都改過的卡片 {len(out['conflicts'])} 張（已採用較晚複習／較新的那邊）：{out['conflicts'][:8]}{'…' if len(out['conflicts']) > 8 else ''}")
    if unknown:
        print(f"  ! 有筆記用了匯入器不支援的筆記類型（{unknown}），那些筆記會被跳過")
        skip = set(unknown)
        out["notes"] = [n for n in out["notes"] if n["mid"] not in skip]
        keep = {n["id"] for n in out["notes"]}
        out["cards"] = [c for c in out["cards"] if c["nid"] in keep or c["nid"] in P_notes]

    if args.media:
        src = os.path.join(PROFILE_DIR, "collection.media")
        dst = os.path.join(ROOT, "public", "media")
        os.makedirs(dst, exist_ok=True)
        new = [n for n in os.listdir(src) if not n.startswith("_") and os.path.isfile(os.path.join(src, n)) and not os.path.exists(os.path.join(dst, n))]
        for n in new:
            shutil.copy(os.path.join(src, n), os.path.join(dst, n))
        print(f"  媒體：新增 {len(new)} 個檔案到 public/media/" + ("（請再執行 npx wrangler deploy）" if new else ""))

    report = os.path.join(ROOT, "data", "import_report.json")
    with open(report, "w", encoding="utf-8") as f:
        json.dump({"stats": s, "conflicts": out["conflicts"], "deletes": out["deletes"], "new_notes": [n["id"] for n in out["notes"] if n["id"] not in P_notes],
                   "new_decks": [d["name"] for d in dks], "new_notetypes": [n["name"] for n in nts]}, f, ensure_ascii=False, indent=1)
    print(f"\n詳細 -> {report}")

    if not args.apply:
        print("\n（試跑，沒有寫入任何東西。確認沒問題再加 --apply。）")
        return

    # 1) 新牌組／筆記類型／設定組：必須先於卡片寫入。只增不減：把現有的全部原樣帶回去再加新的。
    if nts or dks or cfs:
        new_static = {
            "base": int(prod["meta"].get("static_mod", 0)),
            "notetypes": [{**n, "fields": json.loads(n["fields"]) if isinstance(n["fields"], str) else n["fields"]} for n in static["notetypes"]] + nts,
            "decks": [{"id": d["id"], "name": d["name"], "config": d["config"]} for d in static["decks"]] + dks,
            "configs": [json.loads(c["data"]) for c in static["configs"]] + cfs,
        }
        try:
            api.call("/api/static", new_static)
            print("  已新增牌組／筆記類型／設定組")
        except urllib.error.HTTPError as e:
            raise SystemExit(f"網頁版的牌組設定剛被改過（HTTP {e.code}），請重新執行")

    # 2) 刪除（選用）：標記 deleted 並更新 mod，這樣其他裝置同步時會把它移除
    now_ms = int(time.time() * 1000)
    if args.apply_deletes and out["deletes"]:
        dn = [{**P_notes[i], "deleted": 1, "mod": now_ms} for i in out["deletes"]]
        dc = [{**c, "deleted": 1, "mod": now_ms} for c in P_cards.values() if c["nid"] in set(out["deletes"])]
        out["notes"] += dn
        out["cards"] += dc

    # 3) 寫入。mod 一律設成現在，網頁版的各個裝置才會在下次同步時拉到這些列。
    for r in out["notes"] + out["cards"]:
        r["mod"] = now_ms
    for part in chunks(out["notes"]):
        api.call("/api/push", {"notes": part})
    for part in chunks(out["cards"]):
        api.call("/api/push", {"cards": part})
    for part in chunks(out["revlog"]):
        api.call("/api/push", {"revlog": part})
    print(f"已寫入：筆記 {len(out['notes'])}、卡片 {len(out['cards'])}、複習紀錄 {len(out['revlog'])}")
    print("各裝置下次開啟網頁版（或按同步）就會拿到。")


if __name__ == "__main__":
    main()
