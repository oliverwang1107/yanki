r"""用 Anki 自己的程式庫產生 .apkg 測試檔（tests/fixtures/），涵蓋舊格式（legacy）與新格式（zstd），
包含：基本型、正反向、填空題、圖片遮蓋、輸入答案、圖片與音檔媒體、牌組階層、複習進度。

用 Anki 內建的 Python 執行：
    C:\Users\yaya\AppData\Local\AnkiProgramFiles\.venv\Scripts\python.exe tools/make_apkg_fixtures.py
"""
import base64
import os
import shutil
import tempfile

from anki.collection import Collection, ExportAnkiPackageOptions

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures")
os.makedirs(OUT, exist_ok=True)

# 1x1 紅色 PNG 與一小段無聲 WAV
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
WAV = b"RIFF" + (36 + 8).to_bytes(4, "little") + b"WAVEfmt " + (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little") + (8000).to_bytes(4, "little") + (8000).to_bytes(4, "little") + (1).to_bytes(2, "little") + (8).to_bytes(2, "little") + b"data" + (8).to_bytes(4, "little") + bytes([128] * 8)

tmp = tempfile.mkdtemp()
col = Collection(os.path.join(tmp, "collection.anki2"))
media_dir = col.media.dir()
with open(os.path.join(media_dir, "heart.png"), "wb") as f:
    f.write(PNG)
with open(os.path.join(media_dir, "beep.wav"), "wb") as f:
    f.write(WAV)

def deck(name):
    return col.decks.id(name)

def add(model_name, fields, deck_name, tags=""):
    m = col.models.by_name(model_name)
    note = col.new_note(m)
    for k, v in fields.items():
        note[k] = v
    note.tags = [t for t in tags.split() if t]
    col.add_note(note, deck(deck_name))
    return note

add("Basic", {"Front": "apple", "Back": "蘋果 <img src=\"heart.png\">"}, "Fruits::Basic", "fruit easy")
add("Basic (and reversed card)", {"Front": "pear", "Back": "梨子 [sound:beep.wav]"}, "Fruits::Reversed")
add("Cloze", {"Text": "The capital of {{c1::France}} is {{c2::Paris::city}}.", "Back Extra": "Europe"}, "Fruits::Cloze")
add("Basic (type in the answer)", {"Front": "banana", "Back": "banana"}, "Fruits::Typing")
add("Basic", {"Front": "<b>中文</b> & 'quote'", "Back": "特殊字元 <br> 換行"}, "Fruits::Basic")

# 圖片遮蓋：新版 Anki 內建的筆記類型
try:
    io_model = col.models.by_name("Image Occlusion")
    if io_model is None:
        col._backend.add_image_occlusion_notetype()
        io_model = col.models.by_name("Image Occlusion")
    note = col.new_note(io_model)
    note["Image"] = '<img src="heart.png">'
    note["Occlusion"] = "{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.2:oi=1}}{{c2::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.1:oi=1}}"
    note["Header"] = "心臟"
    col.add_note(note, deck("Fruits::Occlusion"))
except Exception as e:  # 舊版沒有圖片遮蓋
    print("沒有建立圖片遮蓋範例：", e)

# 讓其中兩張卡有複習進度
cids = col.find_cards("front:apple")
for cid in cids:
    card = col.get_card(cid)
    card.type, card.queue, card.ivl, card.due, card.reps, card.factor = 2, 2, 15, col.sched.today + 10, 4, 2500
    col.update_card(card)
    col.db.execute("insert into revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) values (?,?,?,?,?,?,?,?,?)", 1700000000000 + cid % 1000, cid, -1, 3, 15, 5, 2500, 4000, 1)

total = col.note_count()
print("筆記", total, "卡片", col.card_count())
for name, legacy, sched in [("legacy", True, True), ("latest", False, True), ("latest_noscheduling", False, False)]:
    opts = ExportAnkiPackageOptions(with_scheduling=sched, with_deck_configs=False, with_media=True, legacy=legacy)
    path = os.path.join(OUT, f"sample_{name}.apkg")
    col.export_anki_package(out_path=path, options=opts, limit=None)
    print("已輸出", path, os.path.getsize(path), "bytes")
col.close()
shutil.rmtree(tmp, ignore_errors=True)
