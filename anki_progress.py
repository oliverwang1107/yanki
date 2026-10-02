"""Anki 讀卡進度報告。

讀取本機 Anki 收藏（只讀副本，Anki 開著也能跑），對照每個目標的截止日，
算出進度、需要的速度、最近實際速度與預估完成日，輸出成 HTML 並用瀏覽器打開。
要改目標或截止日，編輯下面的 GOALS 即可。
"""
import datetime
import html
import math
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import webbrowser

PROFILE_DIR = os.path.join(os.environ["APPDATA"], "Anki2", "使用者 1")
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "進度報告.html")
# 發佈到 claude.ai 的版本（手機遠端看）
ARTIFACT_OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anki-progress.html")

# deadline：新卡要讀完的日期（None 表示沒有截止日，只顯示進度）
# exam：考試日，用來檢查有沒有讀過的卡被排到考試之後才複習
# start：計畫開始讀新卡的日期，在這之前沒讀不算落後
GOALS = [
    {
        "name": "多益 900 分",
        "decks": ["多益 900分 ENG-CH"],
        "deadline": datetime.date(2026, 11, 1),
        "exam": datetime.date(2026, 11, 1),
        "note": "11/1 前讀完所有新卡",
    },
    {
        "name": "英文單字 L1–L4（衝刺）",
        "decks": ["英文單字::L1", "英文單字::L2", "英文單字::L3", "英文單字::L4"],
        "deadline": datetime.date(2026, 10, 15),
        "exam": datetime.date(2027, 1, 20),
        "note": "10 月中前衝完，之後專心讀 L5–L6",
    },
    {
        "name": "英文單字 L5–L6（慢讀）",
        "decks": ["英文單字::L5", "英文單字::L6"],
        "deadline": datetime.date(2027, 1, 20),
        "exam": datetime.date(2027, 1, 20),
        "start": datetime.date(2026, 10, 15),
        "note": "L1–L4 衝完後開始，1/20 前讀完",
    },
    {
        "name": "英文單字-P（片語）",
        "decks": ["英文單字-P"],
        "deadline": None,
        "note": "沒有設定截止日",
    },
]

# 英文單字的最長間隔目前封頂 90 天；過了這天，新排的複習可能落在 1/20 之後
L1L6_CAP_REVIEW_DATE = datetime.date(2026, 10, 22)
RECENT_DAYS = 7
CHART_DAYS = 14
BAR_AREA = 90  # 長條圖最高那根的高度（px）
LABEL_H = 20   # 長條圖下方日期標籤的高度（px）


def unicase(a, b):
    a, b = a.lower(), b.lower()
    return (a > b) - (a < b)


def open_snapshot():
    """把收藏（含 WAL）複製到暫存資料夾再開，避免跟 Anki 搶檔案。"""
    src = os.path.join(PROFILE_DIR, "collection.anki2")
    if not os.path.exists(src):
        sys.exit(f"找不到 Anki 收藏：{src}")
    tmp = tempfile.mkdtemp(prefix="anki_progress_")
    dst = os.path.join(tmp, "collection.anki2")
    shutil.copy2(src, dst)
    for ext in ("-wal", "-shm"):
        if os.path.exists(src + ext):
            shutil.copy2(src + ext, dst + ext)
    con = sqlite3.connect(dst)
    con.create_collation("unicase", unicase)
    return con, tmp


def rollover_hour(con):
    row = con.execute("select val from config where KEY='rollover'").fetchone()
    try:
        return int(row[0]) if row else 4
    except (TypeError, ValueError):
        return 4


def collect(con):
    now = time.time()
    rollover = rollover_hour(con)
    crt = con.execute("select crt from col").fetchone()[0]
    today_idx = int((now - crt) // 86400)
    today = datetime.datetime.fromtimestamp(now - rollover * 3600).date()
    crt_date = datetime.datetime.fromtimestamp(crt).date()
    shift_ms = rollover * 3600 * 1000

    deck_ids = {name.replace("\x1f", "::"): did for did, name in con.execute("select id, name from decks")}

    results = []
    for goal in GOALS:
        dids = [deck_ids[d] for d in goal["decks"] if d in deck_ids]
        missing = [d for d in goal["decks"] if d not in deck_ids]
        if not dids:
            results.append({**goal, "missing": missing, "empty": True})
            continue
        q = ",".join(str(d) for d in dids)

        total = con.execute(f"select count(*) from cards where did in ({q})").fetchone()[0]
        new = con.execute(f"select count(*) from cards where did in ({q}) and type=0 and queue=0").fetchone()[0]
        suspended = con.execute(f"select count(*) from cards where did in ({q}) and queue<0").fetchone()[0]
        learned = total - new - suspended
        due_today = con.execute(
            f"select count(*) from cards where did in ({q}) and "
            f"((queue=2 and due<=?) or (queue=3 and due<=?) or queue=1)",
            (today_idx, today_idx),
        ).fetchone()[0]

        # 每天第一次學到的新卡數（每張卡最早的 learn 紀錄）
        first_rows = con.execute(
            f"select date((min(id)-?)/1000,'unixepoch','localtime') from revlog "
            f"where type=0 and cid in (select id from cards where did in ({q})) group by cid",
            (shift_ms,),
        ).fetchall()
        new_by_day = {}
        for (d,) in first_rows:
            new_by_day[d] = new_by_day.get(d, 0) + 1
        rev_by_day = dict(con.execute(
            f"select date((id-?)/1000,'unixepoch','localtime') d, count(*) from revlog "
            f"where cid in (select id from cards where did in ({q})) group by d",
            (shift_ms,),
        ).fetchall())

        def iso(offset):
            return (today - datetime.timedelta(days=offset)).isoformat()

        new_today = new_by_day.get(iso(0), 0)
        reviews_today = rev_by_day.get(iso(0), 0)
        # 最近 7 天（不含今天，今天還沒讀完）平均每天學的新卡
        recent = [new_by_day.get(iso(i), 0) for i in range(1, RECENT_DAYS + 1)]
        avg_recent = sum(recent) / RECENT_DAYS
        active_days = sum(1 for n in recent if n > 0)
        chart = [(iso(i), new_by_day.get(iso(i), 0), rev_by_day.get(iso(i), 0))
                 for i in range(CHART_DAYS - 1, -1, -1)]

        deadline = goal["deadline"]
        info = {**goal, "missing": missing, "empty": False, "total": total, "new": new,
                "learned": learned, "suspended": suspended, "due_today": due_today,
                "new_today": new_today, "reviews_today": reviews_today,
                "avg_recent": avg_recent, "active_days": active_days, "chart": chart}

        if deadline:
            days_left = (deadline - today).days
            # 還沒到計畫開始日的話，從開始日起算需要的速度
            start = goal.get("start")
            study_days = (deadline - max(today, start)).days if start else days_left
            info["days_left"] = days_left
            info["not_started_yet"] = bool(start and today < start)
            info["need_per_day"] = math.ceil(new / study_days) if study_days > 0 else new
        if goal.get("exam"):
            dues = con.execute(f"select due from cards where did in ({q}) and queue=2").fetchall()
            info["due_after_exam"] = sum(
                1 for (d,) in dues if crt_date + datetime.timedelta(days=d) > goal["exam"])
        if avg_recent > 0 and new > 0:
            info["projected"] = today + datetime.timedelta(days=math.ceil(new / avg_recent))
        results.append(info)

    return today, results


def status_of(g):
    """回傳 (等級, 標題, 說明)。等級：done / good / warn / bad / info"""
    if g["new"] == 0:
        return "done", "新卡全部讀完", "接下來只要把每天到期的複習做完。"
    if not g.get("deadline"):
        if g["avg_recent"] == 0:
            return "info", "最近 7 天沒有讀新卡", "這組沒有截止日，照自己的步調就好。"
        return "info", f"預計 {g['projected']:%Y/%m/%d} 讀完", f"照最近每天約 {g['avg_recent']:.0f} 張的速度。"
    if g["days_left"] <= 0:
        return "bad", "已經過了截止日", f"還有 {g['new']} 張新卡沒讀。"
    need = g["need_per_day"]
    if g.get("not_started_yet") and g["avg_recent"] == 0:
        return "info", f"還沒開始，計畫 {g['start']:%m/%d} 起讀", \
            f"開始後每天約 {need} 張，就能在 {g['deadline']:%m/%d} 前讀完。"
    if g["avg_recent"] == 0:
        return "bad", "最近 7 天沒有讀新卡", f"從今天起每天要讀 {need} 張才來得及。"
    margin = (g["deadline"] - g["projected"]).days
    if margin >= 3:
        return "good", f"進度超前，預計提早 {margin} 天完成", \
            f"最近每天約 {g['avg_recent']:.0f} 張，需要的是每天 {need} 張。"
    if margin >= 0:
        return "warn", "剛好趕得上，但沒有緩衝", \
            f"最近每天約 {g['avg_recent']:.0f} 張，建議拉到每天 {need + 3} 張以上。"
    return "bad", f"照目前速度會晚 {-margin} 天完成", \
        f"最近每天約 {g['avg_recent']:.0f} 張，需要提高到每天 {need} 張。"


def warnings_for(g, today):
    out = []
    if g.get("missing"):
        out.append(f"找不到牌組：{'、'.join(g['missing'])}（可能被改名了，請修改 anki_progress.py 裡的 GOALS）")
    if g.get("due_after_exam"):
        out.append(f"有 {g['due_after_exam']} 張讀過的卡，下次複習排在考試日（{g['exam']:%m/%d}）之後，考前不會再看到它們。")
    if g["decks"][0].startswith("英文單字::L") and today >= L1L6_CAP_REVIEW_DATE and g.get("deadline"):
        out.append("距離 1/20 已不到 90 天，最長複習間隔（90 天）該調小了，不然新排的複習會落在考試之後。")
    return out


def render(today, results, artifact=False):
    """artifact=True 時輸出給 Artifact 發佈用的版本（不含 html/head/body，外殼由平台加上）。"""
    e = html.escape
    cards = []
    for g in results:
        if g.get("empty"):
            cards.append(f'<section class="goal bad"><h2>{e(g["name"])}</h2>'
                         f'<p class="warn-line">找不到任何牌組：{e("、".join(g["missing"]))}</p></section>')
            continue
        level, title, detail = status_of(g)
        pct = 100 * g["learned"] / g["total"] if g["total"] else 0
        stats = [
            ("已讀", f'{g["learned"]:,}', f'共 {g["total"]:,} 張'),
            ("剩餘新卡", f'{g["new"]:,}', "張"),
        ]
        if g.get("deadline"):
            stats.append(("距截止日", f'{g["days_left"]}', f'天（{g["deadline"]:%Y/%m/%d}）'))
            stats.append(("每天需要", f'{g["need_per_day"]}', "張新卡"))
        stats.append(("今天新卡", f'{g["new_today"]}', "張"))
        stats.append(("今天待複習", f'{g["due_today"]}', "張"))
        stat_html = "".join(
            f'<div class="stat"><div class="label">{e(k)}</div>'
            f'<div class="value">{e(v)}</div><div class="unit">{e(u)}</div></div>'
            for k, v, u in stats)

        show_need = bool(g.get("deadline") and g["new"] and g["days_left"] > 0)
        peak = max([n for _, n, _ in g["chart"]] + [g["need_per_day"] if show_need else 0, 1])
        bars = []
        for day, n, r in g["chart"]:
            label = day[5:].replace("-", "/")
            bars.append(f'<div class="bar" title="{label}：新卡 {n} 張、複習 {r} 次">'
                        f'<span class="n">{n or ""}</span>'
                        f'<div class="fill" style="height:{BAR_AREA * n / peak:.0f}px"></div>'
                        f'<span class="d">{label}</span></div>')
        need_line = ""
        if show_need:
            need_line = (f'<div class="need" style="bottom:{LABEL_H + BAR_AREA * g["need_per_day"] / peak:.0f}px">'
                         f'<span>需要 {g["need_per_day"]}</span></div>')

        warn_html = "".join(f'<p class="warn-line">⚠ {e(w)}</p>' for w in warnings_for(g, today))
        chip = {"done": "完成", "good": "超前", "warn": "注意", "bad": "落後", "info": "進行中"}[level]
        cards.append(f"""
<section class="goal {level}">
  <header>
    <div class="head-text"><h2>{e(g["name"])}</h2><p class="note">{e(g["note"])}</p></div>
    <div class="pct">{pct:.0f}<small>%</small></div>
  </header>
  <div class="progress"><div style="width:{pct:.1f}%"></div></div>
  <div class="status"><span class="chip">{chip}</span><strong>{e(title)}</strong><span class="detail">{e(detail)}</span></div>
  {warn_html}
  <div class="stats">{stat_html}</div>
  <div class="chart-title">最近 {CHART_DAYS} 天每天讀的新卡（最近 7 天有讀的天數：{g["active_days"]}/7）</div>
  <div class="chart">{need_line}{"".join(bars)}</div>
</section>""")

    generated = datetime.datetime.now().strftime("%Y/%m/%d %H:%M")
    page = f"""<title>Anki 讀卡進度</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Sans+TC:wght@400;500;700&display=swap">
<style>
/* 版面：單欄儀表板，每個讀卡目標一張卡片，摘要（狀態）在前、細節（數字、長條圖）在後 */
:root {{
  --bg:#eef0f3; --card:#ffffff; --ink:#1b2230; --muted:#5f6878; --line:#d9dde5; --track:#e3e7ee;
  --accent:#2f5d9e;
  --good:#1d7a47; --warn:#9a6208; --bad:#b3342a; --info:#2f5d9e;
  --font-body:"IBM Plex Sans","Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif;
  --font-num:"IBM Plex Sans","Segoe UI",sans-serif;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg:#12161d; --card:#1b212b; --ink:#e6e9ef; --muted:#98a1b1; --line:#2c3443; --track:#2a3140;
    --accent:#7aa5e0; --good:#5cc98a; --warn:#e0a63f; --bad:#f07a6e; --info:#7aa5e0;
    color-scheme:dark;
  }}
}}
:root[data-theme="dark"] {{
  --bg:#12161d; --card:#1b212b; --ink:#e6e9ef; --muted:#98a1b1; --line:#2c3443; --track:#2a3140;
  --accent:#7aa5e0; --good:#5cc98a; --warn:#e0a63f; --bad:#f07a6e; --info:#7aa5e0;
  color-scheme:dark;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 var(--font-body); }}
main {{ max-width:860px; margin:0 auto; padding-inline:16px; padding-block:28px 40px;
  display:flex; flex-direction:column; gap:16px; }}
.top h1 {{ font-size:22px; font-weight:700; margin:0; text-wrap:balance; }}
.top p {{ color:var(--muted); margin:2px 0 0; font-size:13px; }}
.goal {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px;
  display:flex; flex-direction:column; gap:12px; min-width:0; }}
header {{ display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }}
.head-text {{ min-width:0; }}
h2 {{ font-size:17px; font-weight:700; margin:0; }}
.note {{ color:var(--muted); margin:2px 0 0; font-size:13px; }}
.pct {{ font:600 30px/1 var(--font-num); font-variant-numeric:tabular-nums; }}
.pct small {{ font-size:15px; color:var(--muted); margin-left:1px; }}
.progress {{ height:8px; background:var(--track); border-radius:4px; overflow:hidden; }}
.progress div {{ height:100%; background:var(--accent); border-radius:4px; }}
.status {{ display:flex; flex-wrap:wrap; gap:4px 10px; align-items:center; }}
.chip {{ font-size:12px; font-weight:500; letter-spacing:.04em; padding:2px 9px; border-radius:999px;
  color:var(--info); background:color-mix(in srgb, var(--info) 14%, transparent); }}
.good .chip,.done .chip {{ color:var(--good); background:color-mix(in srgb, var(--good) 14%, transparent); }}
.warn .chip {{ color:var(--warn); background:color-mix(in srgb, var(--warn) 16%, transparent); }}
.bad .chip {{ color:var(--bad); background:color-mix(in srgb, var(--bad) 14%, transparent); }}
.status .detail {{ color:var(--muted); font-size:14px; }}
.warn-line {{ margin:0; padding:8px 12px; border-radius:8px; font-size:14px;
  background:color-mix(in srgb, var(--warn) 13%, transparent); }}
.stats {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:1px;
  background:var(--line); border:1px solid var(--line); border-radius:10px; overflow:hidden; }}
.stat {{ background:var(--card); padding:8px 12px; }}
.label,.unit {{ color:var(--muted); font-size:12px; }}
.label {{ letter-spacing:.03em; }}
.value {{ font:600 21px/1.3 var(--font-num); font-variant-numeric:tabular-nums; }}
.chart-title {{ color:var(--muted); font-size:13px; }}
.chart {{ position:relative; display:flex; gap:4px; height:{BAR_AREA + LABEL_H + 18}px;
  padding-bottom:{LABEL_H}px; overflow-x:auto; overflow-y:hidden; }}
.bar {{ position:relative; flex:1; min-width:26px; display:flex; flex-direction:column; justify-content:flex-end; }}
.fill {{ background:var(--accent); border-radius:3px 3px 0 0; min-height:1px; opacity:.8; }}
.bar:last-child .fill {{ opacity:1; }}
.bar .n {{ text-align:center; font:11px/16px var(--font-num); color:var(--ink); }}
.bar .d {{ position:absolute; bottom:-{LABEL_H - 2}px; width:100%; text-align:center; font:10px var(--font-num); color:var(--muted); }}
.need {{ position:absolute; left:0; right:0; border-top:2px dashed var(--bad); pointer-events:none; }}
.need span {{ position:absolute; right:0; top:-17px; font-size:11px; color:var(--bad); background:var(--card); padding:0 4px; }}
footer {{ color:var(--muted); font-size:12px; line-height:1.6; }}
@media (max-width:480px) {{ .goal {{ padding:16px; }} .pct {{ font-size:26px; }} }}
</style>
<main>
<div class="top">
  <h1>Anki 讀卡進度</h1>
  <p>資料更新於 {generated}</p>
</div>
{"".join(cards)}
<footer>最近速度：過去 7 天（不含今天）平均每天第一次學的新卡數。紅色虛線：到截止日前每天需要讀的新卡數。</footer>
</main>"""
    if artifact:
        return page
    return ('<!doctype html>\n<html lang="zh-Hant"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'{page}\n</html>')


def print_summary(today, results):
    print(f"Anki 讀卡進度　{today:%Y/%m/%d}\n")
    for g in results:
        if g.get("empty"):
            print(f"■ {g['name']}：找不到牌組 {g['missing']}\n")
            continue
        _, title, detail = status_of(g)
        print(f"■ {g['name']}　已讀 {g['learned']}/{g['total']}　剩 {g['new']} 張新卡")
        print(f"  {title}：{detail}")
        print(f"  今天新卡 {g['new_today']} 張，待複習 {g['due_today']} 張")
        for w in warnings_for(g, today):
            print(f"  ⚠ {w}")
        print()


def main():
    con, tmp = open_snapshot()
    try:
        today, results = collect(con)
    finally:
        con.close()
        shutil.rmtree(tmp, ignore_errors=True)
    print_summary(today, results)
    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write(render(today, results))
    with open(ARTIFACT_OUTPUT, "w", encoding="utf-8") as f:
        f.write(render(today, results, artifact=True))
    print(f"報告：{OUTPUT}")
    if "--no-open" not in sys.argv:
        webbrowser.open("file:///" + OUTPUT.replace("\\", "/"))


if __name__ == "__main__":
    main()
