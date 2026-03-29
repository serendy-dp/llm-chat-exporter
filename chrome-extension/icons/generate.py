#!/usr/bin/env python3
"""LLM Chat Exporter - icon generator (requires Pillow)"""

from PIL import Image, ImageDraw
import os

OUT_DIR = os.path.dirname(__file__)
SIZES = [16, 48, 128]

# カラーパレット
BG       = (10,  14,  26,  255)   # #0a0e1a
BORDER   = (0,  229, 255, 110)    # #00e5ff 43%
GRID     = (0,  200, 255,  18)    # subtle grid
CYAN     = (0,  229, 255, 255)    # #00e5ff
CYAN_DIM = (0,  180, 210, 180)    # dimmed second line


def create_icon(size: int) -> Image.Image:
    # 4x super-sampling で描画してからリサイズ → アンチエイリアス
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # ── 背景 (rounded rect) ──────────────────────────────
    radius = S // 6
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=BG)

    # ── グリッドライン ────────────────────────────────────
    step = S // 8
    for x in range(0, S, step):
        d.line([(x, 0), (x, S)], fill=GRID, width=1)
    for y in range(0, S, step):
        d.line([(0, y), (S, y)], fill=GRID, width=1)

    # ── ボーダー ──────────────────────────────────────────
    bw = max(3, S // 28)
    d.rounded_rectangle(
        [bw, bw, S - 1 - bw, S - 1 - bw],
        radius=radius - bw,
        outline=BORDER,
        width=bw,
    )

    # ── デザイン本体: "> ──" × 2 (terminal + chat) ────────
    # ">" シェブロン
    cx   = S * 0.30
    cy   = S * 0.50
    arm  = S * 0.18   # 腕の長さ
    lw   = max(4, S // 18)

    tip_x = cx + arm * 0.85
    tip_y = cy
    top_x = cx - arm * 0.3
    top_y = cy - arm
    bot_x = cx - arm * 0.3
    bot_y = cy + arm

    # 上の線
    d.line([(top_x, top_y), (tip_x, tip_y)], fill=CYAN, width=lw)
    # 下の線
    d.line([(tip_x, tip_y), (bot_x, bot_y)], fill=CYAN, width=lw)

    # 右側の水平バー 2本 (chat messages)
    x0  = S * 0.52
    x1a = S * 0.87
    x1b = S * 0.78   # 2本目はやや短い
    y1  = S * 0.37
    y2  = S * 0.63
    bh  = max(3, S // 22)

    d.line([(x0, y1), (x1a, y1)], fill=CYAN,     width=bh)
    d.line([(x0, y2), (x1b, y2)], fill=CYAN_DIM, width=bh)

    # コーナーアクセント (小さな輝点)
    dot = max(2, S // 30)
    margin = S * 0.08
    corner_color = (0, 229, 255, 60)
    for cx2, cy2 in [
        (margin, margin),
        (S - margin, margin),
        (margin, S - margin),
        (S - margin, S - margin),
    ]:
        d.ellipse(
            [cx2 - dot, cy2 - dot, cx2 + dot, cy2 + dot],
            fill=corner_color,
        )

    # ── ダウンサンプリング ────────────────────────────────
    return img.resize((size, size), Image.LANCZOS)


for size in SIZES:
    icon = create_icon(size)
    path = os.path.join(OUT_DIR, f"icon{size}.png")
    icon.save(path, "PNG")
    print(f"  Generated: {path}")

print("Done.")
