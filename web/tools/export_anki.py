"""把本機 Anki 收藏匯出成 web/data/export.json（用副本，Anki 開著也能跑）。

需要 `pip install anki`。用法：
    python tools/export_anki.py            只匯出資料
    python tools/export_anki.py --media    同時把媒體檔複製到 web/public/media/

到期日統一換成「學習日」編號：以本機時區、凌晨 4 點換日，
web_day(ts) = floor((ts + 時區秒數 - 4*3600) / 86400)，前端用同一個公式。
"""
import argparse
import json
import os
import shutil
import tempfile
import time

from anki.collection import Collection

PROFILE_DIR = os.path.join(os.environ["APPDATA"], "Anki2", "使用者 1")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "export.json")
MEDIA_OUT = os.path.join(ROOT, "public", "media")


def copy_collection():
    tmp = tempfile.mkdtemp()
    for suffix in ("", "-wal", "-shm"):
        src = os.path.join(PROFILE_DIR, "collection.anki2" + suffix)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(tmp, "collection.anki2" + suffix))
    return os.path.join(tmp, "collection.anki2")


def export(col):
    tz = time.localtime().tm_gmtoff
    rollover = col.get_config("rollover") or 4

    def web_day(ts):
        return (ts + tz - rollover * 3600) // 86400

    now = int(time.time())
    shift = web_day(now) - col.sched.today  # Anki 的 due 天數 -> 學習日編號

    used = {r[0] for r in col.db.all("select distinct mid from notes")}
    notetypes = []
    for m in col.models.all():
        if m["id"] not in used:
            continue
        assert len(m["tmpls"]) == 1 and m["type"] == 0, f"不支援的筆記類型：{m['name']}"
        t = m["tmpls"][0]
        notetypes.append({
            "id": m["id"], "name": m["name"], "fields": [f["name"] for f in m["flds"]],
            "qfmt": t["qfmt"], "afmt": t["afmt"], "css": m["css"],
        })

    decks, configs = [], {}
    for d in col.decks.all_names_and_ids():
        c = col.decks.config_dict_for_deck_id(d.id)
        decks.append({"id": d.id, "name": d.name, "config": c["id"]})
        configs[c["id"]] = {
            "id": c["id"], "name": c["name"],
            "newPerDay": c["new"]["perDay"], "revPerDay": c["rev"]["perDay"],
            "maxIvl": c["rev"]["maxIvl"], "desiredRetention": c["desiredRetention"],
            "learnSteps": c["new"]["delays"], "relearnSteps": c["lapse"]["delays"],
            "minLapseIvl": c["lapse"]["minInt"], "params": c["fsrsParams6"],
        }

    notes = [
        {"id": i, "guid": g, "mid": mid, "mod": mod, "tags": tags.strip(), "fields": flds.split("\x1f")}
        for i, g, mid, mod, tags, flds in col.db.all("select id,guid,mid,mod,tags,flds from notes")
    ]

    cards, no_state = [], 0
    for cid, nid, did, ord_, type_, queue, due, ivl, reps, lapses, left, mod, data in col.db.all(
        "select id,nid,did,ord,type,queue,due,ivl,reps,lapses,left,mod,data from cards"
    ):
        assert queue in (0, 1, 2), f"卡片 {cid} 有暫停或擱置狀態（queue={queue}），匯出腳本尚未處理"
        extra = json.loads(data) if data else {}
        card = {
            "id": cid, "nid": nid, "did": did, "ord": ord_, "type": type_, "queue": queue,
            "ivl": ivl, "reps": reps, "lapses": lapses, "left": left, "mod": mod,
            "s": extra.get("s"), "d": extra.get("d"), "lrt": extra.get("lrt"),
        }
        if queue == 0:
            card["pos"] = due
        elif queue == 1:
            card["dueTs"] = due
        else:
            card["dueDay"] = due + shift
        if type_ in (2, 3) and card["s"] is None:
            no_state += 1
        cards.append(card)

    revlog = [
        {"id": i, "cid": cid, "ease": ease, "ivl": ivl, "lastIvl": last, "time": t, "type": ty}
        for i, cid, ease, ivl, last, t, ty in col.db.all(
            "select id,cid,ease,ivl,lastIvl,time,type from revlog"
        )
    ]

    return {
        "meta": {"exportedAt": now, "tz": tz, "rollover": rollover, "today": web_day(now)},
        "notetypes": notetypes, "decks": decks, "configs": list(configs.values()),
        "notes": notes, "cards": cards, "revlog": revlog,
    }, no_state


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--media", action="store_true")
    args = ap.parse_args()

    path = copy_collection()
    col = Collection(path)
    try:
        data, no_state = export(col)
    finally:
        col.close()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"notes {len(data['notes'])}  cards {len(data['cards'])}  revlog {len(data['revlog'])}  "
          f"decks {len(data['decks'])}  configs {len(data['configs'])}")
    print(f"複習中但沒有 FSRS 狀態的卡：{no_state}")
    print(f"{OUT}  {os.path.getsize(OUT) / 1e6:.1f} MB")

    if args.media:
        src = os.path.join(PROFILE_DIR, "collection.media")
        os.makedirs(MEDIA_OUT, exist_ok=True)
        files = [n for n in os.listdir(src) if not n.startswith("_") and os.path.isfile(os.path.join(src, n))]
        for n in files:
            shutil.copy(os.path.join(src, n), os.path.join(MEDIA_OUT, n))
        print(f"媒體 {len(files)} 個檔案 -> {MEDIA_OUT}")


if __name__ == "__main__":
    main()
