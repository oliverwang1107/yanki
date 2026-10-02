"""用 Anki 自己的排程器產生測試答案，給 wasm/tests 比對 Rust 排程是否一致。

對每張抽樣的卡，記錄 Anki 後端算出的「按 Again/Hard/Good/Easy 之後」的狀態，
連同當時的卡片資料與牌組設定，寫到 wasm/tests/oracle.json。
需要 `pip install anki`；用法：python tools/make_oracle.py [抽樣數]
"""
import json
import os
import random
import sys

from google.protobuf.json_format import MessageToDict

from anki.collection import Collection
from export_anki import ROOT, copy_collection, export

OUT = os.path.join(ROOT, "wasm", "tests", "oracle.json")
RATINGS = ("again", "hard", "good", "easy")


def main():
    per_type = int(sys.argv[1]) if len(sys.argv) > 1 else 400
    col = Collection(copy_collection())
    try:
        data, _ = export(col)
        deck_config = {d["id"]: d["config"] for d in data["decks"]}
        by_type = {}
        for c in data["cards"]:
            by_type.setdefault(c["type"], []).append(c)
        random.seed(1)
        picked = []
        today = data["meta"]["today"]
        for t, cards in sorted(by_type.items()):
            if t == 2:  # 複習卡：真實使用都是到期才答，所以以到期卡為主，另抽少量未到期的
                due = [c for c in cards if c["dueDay"] <= today]
                rest = [c for c in cards if c["dueDay"] > today]
                picked += due[:per_type * 2] + random.sample(rest, min(len(rest), per_type // 4))
            else:
                picked += cards if len(cards) <= per_type else random.sample(cards, per_type)

        cases = []
        for c in picked:
            st = col._backend.get_scheduling_states(c["id"])
            cases.append({
                "card": c,
                "config": deck_config[c["did"]],
                "expect": {r: MessageToDict(getattr(st, r), preserving_proto_field_name=False) for r in RATINGS},
            })
        out = {"today": data["meta"]["today"], "tz": data["meta"]["tz"], "rollover": data["meta"]["rollover"],
               "configs": {str(c["id"]): c for c in data["configs"]}, "cases": cases}
    finally:
        col.close()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(cases)} 個案例（類型 {dict((t, min(len(v), per_type)) for t, v in by_type.items())}）-> {OUT}")


if __name__ == "__main__":
    main()
