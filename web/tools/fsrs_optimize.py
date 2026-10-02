"""用 Anki 內建的 FSRS 最佳化工具，從你完整的複習紀錄算出新的參數，並比較不同「目標記憶率」要多花多少複習量。

資料來源：你 Anki 收藏的副本 + 網頁版正式站上的複習紀錄（合併，不重複）。完全不會動你真正的 Anki 收藏
（只讀副本，而且合併進去的網頁版紀錄只寫在副本裡）。

    python tools/fsrs_optimize.py                      只分析，印出報告，不寫入
    python tools/fsrs_optimize.py --retention 0.95     指定要套用的目標記憶率（預設 0.95）
    python tools/fsrs_optimize.py --apply              把新參數和目標記憶率寫進正式站你的牌組設定
                                                       （舊設定會先備份到 data/fsrs-configs-backup-*.json）
    python tools/fsrs_optimize.py --target local       對本機 dev server

要用 Anki 內建的 Python 執行（系統 Python 沒有 anki 套件）：
    C:\\Users\\yaya\\AppData\\Local\\AnkiProgramFiles\\.venv\\Scripts\\python.exe tools/fsrs_optimize.py
"""
import argparse
import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_anki import copy_collection  # noqa: E402
from sync_from_anki import LOCAL_URL, PROD_URL, ROOT, Api, read_token  # noqa: E402

from anki.collection import Collection  # noqa: E402

DEFAULT_PARAMS_FSRS6 = [
    0.2120, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.0010, 1.8722, 0.1666, 0.7960,
    1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]


def merge_web_revlog(path, rows):
    """把網頁版的複習紀錄補進 Anki 副本（只補副本裡沒有、而且卡片存在的）。回傳補了幾筆。"""
    db = sqlite3.connect(path)
    have = {r[0] for r in db.execute("select id from revlog")}
    cards = {r[0] for r in db.execute("select id from cards")}
    add = [(r["id"], r["cid"], -1, r["ease"], r["ivl"], r["last_ivl"], 0, r["time"], r["type"]) for r in rows if r["id"] not in have and r["cid"] in cards]
    db.executemany("insert or ignore into revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) values (?,?,?,?,?,?,?,?,?)", add)
    db.commit()
    db.close()
    return len(add)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", choices=["prod", "local"], default="prod")
    ap.add_argument("--retention", type=float, default=0.95)
    ap.add_argument("--override", action="append", default=[], metavar="名稱關鍵字=記憶率", help="名稱含這段文字的設定組改用別的目標記憶率，例如 --override 多益=0.97（可重複）")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    api = Api(LOCAL_URL if args.target == "local" else PROD_URL, read_token(args.target))
    static = api.call("/api/static")
    configs = [json.loads(c["data"]) for c in static["configs"]]
    web_revlog = api.pull_all("revlog")

    path = copy_collection()
    added = merge_web_revlog(path, web_revlog)
    col = Collection(path)
    try:
        total = col.db.scalar("select count(*) from revlog where ease between 1 and 4 and type != 4")
        cards_reviewed = col.db.scalar("select count(distinct cid) from revlog where ease between 1 and 4 and type != 4")
        print(f"複習紀錄：Anki 副本 + 網頁版新增 {added} 筆 = {total} 筆有效評分，涵蓋 {cards_reviewed} 張卡片")

        relearn = max((len(c.get("relearnSteps") or []) for c in configs), default=1)
        be = col._backend
        t0 = time.time()
        res = be.compute_fsrs_params(search="deck:*", current_params=[], ignore_revlogs_before_ms=0, num_of_relearning_steps=relearn, health_check=False)
        new = list(res.params)
        print(f"最佳化完成（{time.time() - t0:.0f} 秒），用了 {res.fsrs_items} 筆複習序列，得到 {len(new)} 個參數")
        if len(new) != 21:
            raise SystemExit("參數數量不是 21（FSRS-6），Anki 版本可能不同，先停下來")

        # 用同一批紀錄比較：新參數、你原本各牌組設定裡的參數、FSRS-6 預設參數
        def loss(params):
            r = be.evaluate_params_legacy(params=params, search="deck:*", ignore_revlogs_before_ms=0)
            return r.log_loss, r.rmse_bins  # rmse_bins 其實是已經算好的 RMSE（bins）

        candidates = [("新參數（用你全部的紀錄）", new), ("FSRS-6 預設值", DEFAULT_PARAMS_FSRS6)]
        for c in configs:
            if c.get("params"):
                candidates.append((f"目前「{c['name']}」", c["params"]))
        print("\n預測準確度（越小越準；log loss 是主要指標，RMSE 是記憶率預測誤差）")
        scores = {}
        for name, p in candidates:
            ll, rm = loss(p)
            scores[name] = (ll, rm)
            print(f"  {name:<34} log loss {ll:.4f}   RMSE {rm:.4f}")

        # 交叉驗證：把紀錄切成幾份，用其中幾份訓練、在沒看過的那份上檢查，比「訓練資料上的分數」更能看出有沒有過度配適
        cv = be.evaluate_params(search="deck:*", ignore_revlogs_before_ms=0, num_of_relearning_steps=relearn)
        print(f"\n新參數的交叉驗證（沒看過的資料上）：log loss {cv.log_loss:.4f}   RMSE {cv.rmse_bins:.4f}")
        print("新參數：" + ", ".join(f"{x:.3f}" for x in new))

        # 目標記憶率與複習量：數字是「相對 0.90 的每張卡累計複習成本」，越大越辛苦
        cost = dict(be.get_retention_workload(w=new, search="deck:*"))
        # 鍵是百分比整數（70–99）
        pct = lambda r: min(cost, key=lambda k: abs(k - round(r * 100)))
        base = cost[pct(0.90)]
        print("\n目標記憶率 → 相對複習量（0.90 = 1.0）")
        table = {}
        for r in (0.80, 0.85, 0.90, 0.92, 0.93, 0.95, 0.96, 0.97, 0.98):
            table[r] = cost[pct(r)] / base
            print(f"  {r:.2f}  {table[r]:.2f}×")

        out = {"cv": [cv.log_loss, cv.rmse_bins], "params": new, "fsrs_items": res.fsrs_items, "reviews": total, "scores": scores, "workload": table, "retention": args.retention, "at": int(time.time())}
        os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
        with open(os.path.join(ROOT, "data", "fsrs_result.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
    finally:
        col.close()

    if not args.apply:
        print("\n（只分析，沒有寫入任何設定。要套用請加 --apply，目標記憶率用 --retention 指定。）")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(ROOT, "data", f"fsrs-configs-backup-{stamp}.json")
    with open(backup, "w", encoding="utf-8") as f:
        json.dump(configs, f, ensure_ascii=False, indent=1)
    overrides = [(k, float(v)) for k, v in (o.split("=", 1) for o in args.override)]

    def retention_for(c):
        return next((v for k, v in overrides if k in c["name"]), args.retention)

    updated = [{**c, "params": new, "desiredRetention": retention_for(c)} for c in configs]
    base_mod = int({r["k"]: r["v"] for r in static["meta"]}.get("static_mod", 0))
    api.call("/api/static", {"base": base_mod, "configs": updated})
    print(f"\n已寫入 {len(updated)} 組牌組設定（都換成新參數）：")
    for c in updated:
        print(f"  {c['name']}：目標記憶率 {c['desiredRetention']}")
    print(f"舊設定備份在 {backup}（要還原就把裡面的內容貼回牌組選項，或叫我還原）")
    print("各裝置下次同步就會套用。")


if __name__ == "__main__":
    main()
