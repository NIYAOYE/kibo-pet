"""从活跃宠物 luluka 的 idle 首帧生成应用图标 build/icon.ico(开发期一次性)。

用法(conda 虚拟环境):
    conda run -n peticon python tools/hatch-desktop-pet/scripts/make_app_icon.py
"""
import json
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PET = os.path.join(ROOT, "pets", "luluka")

meta = json.load(open(os.path.join(PET, "pet.json"), encoding="utf-8"))
sheet = Image.open(os.path.join(PET, meta["spritesheetPath"])).convert("RGBA")
cw = meta["sheet"]["cellWidth"]
ch = meta["sheet"]["cellHeight"]
idle_row = meta["animations"]["idle"]["row"]

frame = sheet.crop((0, idle_row * ch, cw, idle_row * ch + ch))
bbox = frame.getbbox()          # 裁到不透明包围盒,居中更好看
if bbox:
    frame = frame.crop(bbox)

side = max(frame.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(frame, ((side - frame.width) // 2, (side - frame.height) // 2))
canvas = canvas.resize((256, 256), Image.LANCZOS)

out = os.path.join(ROOT, "build", "icon.ico")
os.makedirs(os.path.dirname(out), exist_ok=True)
canvas.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out)
