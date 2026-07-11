"""从零画一个原创应用图标 build/icon.ico(开发期一次性)。

不依赖任何宠物包(不同于同目录下已废弃的 make_app_icon.py,它是从 luluka
的精灵图裁出来的)。构图上致敬用户提供的参考图(圆角方形底+猫耳机器人头盔+
发光眼睛/天线的可爱机器人猫太空员),但全部用 PIL 基本图形从零绘制,不复用/
摹描参考图的任何像素,规避版权问题。

用法:
    conda run -n peticon python tools/hatch-desktop-pet/scripts/make_app_icon_original.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))

SIZE = 256
BG_TOP = (60, 40, 120, 255)      # 靠上的紫色
BG_BOTTOM = (40, 70, 190, 255)   # 靠下的蓝色
WHITE = (245, 245, 250, 255)
OUTLINE = (20, 18, 30, 255)
VISOR = (18, 16, 28, 255)
GLOW = (110, 235, 240, 255)


def rounded_square_gradient(size: int, radius: int) -> Image.Image:
    """圆角方形底,纵向紫→蓝渐变。"""
    grad = Image.new("RGBA", (size, size))
    for y in range(size):
        t = y / (size - 1)
        r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        for x in range(size):
            grad.putpixel((x, y), (r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def draw_head(canvas: Image.Image) -> None:
    d = ImageDraw.Draw(canvas)
    cx, cy = SIZE // 2, SIZE // 2 + 10

    # 猫耳(两个三角形,画在头盔之前所以头盔边缘会盖住耳朵根部)
    ear_h = 46
    d.polygon([(cx - 78, cy - 58), (cx - 40, cy - 92), (cx - 26, cy - 46)], fill=WHITE, outline=OUTLINE, width=4)
    d.polygon([(cx + 78, cy - 58), (cx + 40, cy - 92), (cx + 26, cy - 46)], fill=WHITE, outline=OUTLINE, width=4)

    # 头盔:圆角方形白色轮廓
    helmet_box = [cx - 72, cy - 66, cx + 72, cy + 74]
    d.rounded_rectangle(helmet_box, radius=46, fill=WHITE, outline=OUTLINE, width=5)

    # 天线:两根细杆 + 发光小球
    d.line([(cx - 34, cy - 66), (cx - 34, cy - 96)], fill=OUTLINE, width=5)
    d.line([(cx + 34, cy - 66), (cx + 34, cy - 96)], fill=OUTLINE, width=5)
    for ax in (cx - 34, cx + 34):
        d.ellipse([ax - 11, cy - 107, ax + 11, cy - 85], fill=GLOW, outline=OUTLINE, width=3)

    # 面罩(深色visor,内缩于头盔)
    visor_box = [cx - 54, cy - 44, cx + 54, cy + 56]
    d.rounded_rectangle(visor_box, radius=34, fill=VISOR)

    # 发光弯眨眼睛(两段向上开口的弧线)
    eye_w, eye_h = 34, 26
    for ex in (cx - 26, cx + 26):
        d.arc([ex - eye_w // 2, cy - 6 - eye_h // 2, ex + eye_w // 2, cy - 6 + eye_h // 2],
              start=200, end=340, fill=GLOW, width=6)


def build() -> Image.Image:
    canvas = rounded_square_gradient(SIZE, radius=56)
    draw_head(canvas)
    return canvas


if __name__ == "__main__":
    canvas = build()
    out = os.path.join(ROOT, "build", "icon.ico")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    canvas.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", out)
