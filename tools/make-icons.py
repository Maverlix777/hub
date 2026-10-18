# Генерирует значки PWA: icons/icon-{180,192,512}.png. Фон непрозрачный на весь квадрат,
# рисунок (сетка 2x2 плиток) внутри безопасной зоны maskable (центральные 60%).
# Запуск: python3 tools/make-icons.py  (нужен Pillow)
from pathlib import Path
from PIL import Image, ImageDraw

BG, FG, DIM = (47, 91, 211), (255, 255, 255), (255, 255, 255, 110)
OUT = Path(__file__).resolve().parent.parent / "icons"

def icon(size):
    s = 4  # рисуем крупнее и уменьшаем: сглаживание краёв
    n = size * s
    img = Image.new("RGBA", (n, n), BG + (255,))
    layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    box, gap = n * 0.60, n * 0.06
    cell = (box - gap) / 2
    x0 = y0 = (n - box) / 2
    for i, (cx, cy) in enumerate([(0, 0), (1, 0), (0, 1), (1, 1)]):
        x, y = x0 + cx * (cell + gap), y0 + cy * (cell + gap)
        d.rounded_rectangle([x, y, x + cell, y + cell], radius=cell * 0.22, fill=FG if i != 3 else DIM)
    img = Image.alpha_composite(img, layer).convert("RGB")
    return img.resize((size, size), Image.LANCZOS)

OUT.mkdir(exist_ok=True)
for size in (180, 192, 512):
    icon(size).save(OUT / f"icon-{size}.png", optimize=True)
    print(f"icons/icon-{size}.png")
