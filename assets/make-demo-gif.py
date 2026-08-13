#!/usr/bin/env python3
"""Render assets/demo.gif — the same animation as demo.svg, frame by frame.

GIF is the fallback for renderers that drop SMIL. Frames are drawn directly
rather than rasterised from the SVG so the timing stays identical and the
palette stays small enough for a compact file.
"""

from PIL import Image, ImageDraw, ImageFont

W, H = 820, 280
FPS = 12.5
DURATION = 7.0
FRAME_MS = int(1000 / FPS)
FRAMES = int(DURATION * FPS)

BG = (13, 17, 23)
TITLE = (22, 27, 34)
BORDER = (48, 54, 61)
TEXT = (201, 209, 217)
MUTED = (125, 133, 144)
TRACK = (22, 27, 34)
GREEN = (86, 211, 100)
GREEN_DIM = (63, 185, 80)
YELLOW = (227, 179, 65)
PROMPT = (126, 231, 135)
STRING = (165, 214, 255)

MENLO = "/System/Library/Fonts/Menlo.ttc"
f15 = ImageFont.truetype(MENLO, 15, index=0)
f14 = ImageFont.truetype(MENLO, 14, index=0)
f13b = ImageFont.truetype(MENLO, 13, index=1)
f12 = ImageFont.truetype(MENLO, 12, index=0)

CMD_PROMPT = "$ "
CMD_HEAD = "grep "
CMD_ARG = '"createServer"'
FULL_CMD = CMD_PROMPT + CMD_HEAD + CMD_ARG

BAR_X, BAR_W = 120, 560
SLOW_Y, FAST_Y = 126, 168
CHAR_W = 9  # Menlo 15px advance

# Timeline, in seconds.
TYPE_START, TYPE_END = 0.20, 1.35
RUN_START = 1.55
FAST_END = RUN_START + 0.06
SLOW_END = 5.05
VERDICT_AT = 5.25


def lerp(a, b, t):
    return a + (b - a) * max(0.0, min(1.0, t))


def frame(index):
    t = index / FPS
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=10, fill=BG, outline=BORDER)
    d.rounded_rectangle([1, 1, W - 2, 37], radius=9, fill=TITLE)
    d.rectangle([1, 28, W - 2, 37], fill=TITLE)
    d.line([1, 37, W - 2, 37], fill=BORDER)
    for cx, color in ((24, (255, 95, 87)), (44, (254, 188, 46)), (64, (40, 200, 64))):
        d.ellipse([cx - 6, 13, cx + 6, 25], fill=color)
    d.text((410, 12), "17 MB repository — 4,000 files", font=f12, fill=MUTED, anchor="ma")

    # Command line, revealed one character at a time.
    shown = len(FULL_CMD)
    if t < TYPE_START:
        shown = 0
    elif t < TYPE_END:
        shown = int(len(FULL_CMD) * (t - TYPE_START) / (TYPE_END - TYPE_START))
    if shown:
        text = FULL_CMD[:shown]
        d.text((28, 66), text[:2], font=f15, fill=PROMPT)
        if len(text) > 2:
            head = text[2 : 2 + len(CMD_HEAD)]
            d.text((28 + 2 * CHAR_W, 66), head, font=f15, fill=TEXT)
        if len(text) > 2 + len(CMD_HEAD):
            arg = text[2 + len(CMD_HEAD) :]
            d.text((28 + (2 + len(CMD_HEAD)) * CHAR_W, 66), arg, font=f15, fill=STRING)
    # Cursor: blinks between typing and launch, then gets out of the way.
    if TYPE_END <= t < RUN_START and int((t - TYPE_END) / 0.25) % 2 == 0:
        cx = 28 + shown * CHAR_W
        d.rectangle([cx, 63, cx + 8, 81], fill=TEXT)

    d.line([28, 100, W - 28, 100], fill=(33, 38, 45))

    d.text((28, 132), "ripgrep", font=f14, fill=MUTED)
    d.rounded_rectangle([BAR_X, SLOW_Y, BAR_X + BAR_W, SLOW_Y + 18], radius=3, fill=TRACK)
    if t >= RUN_START:
        w = lerp(0, BAR_W, (t - RUN_START) / (SLOW_END - RUN_START))
        if w >= 1:
            d.rounded_rectangle([BAR_X, SLOW_Y, BAR_X + w, SLOW_Y + 18], radius=3, fill=YELLOW)
    if t >= SLOW_END:
        d.text((694, 132), "147.7 ms", font=f14, fill=YELLOW)

    d.text((28, 174), "snapgrep", font=f14, fill=TEXT)
    d.rounded_rectangle([BAR_X, FAST_Y, BAR_X + BAR_W, FAST_Y + 18], radius=3, fill=TRACK)
    if t >= RUN_START:
        w = lerp(0, 8, (t - RUN_START) / (FAST_END - RUN_START))
        if w >= 1:
            d.rectangle([BAR_X, FAST_Y, BAR_X + w, FAST_Y + 18], fill=GREEN)
    if t >= FAST_END:
        d.text((140, 174), "2.1 ms", font=f14, fill=GREEN)
    if t >= VERDICT_AT:
        d.text((205, 174), "72× faster — same results, byte for byte", font=f13b, fill=GREEN_DIM)

    d.line([28, 212, W - 28, 212], fill=(33, 38, 45))
    d.text((28, 231), "Bars are drawn to true scale. The green one is 8 pixels wide because", font=f12, fill=MUTED)
    d.text((28, 251), "that is what 2.1 ms looks like next to 147.7 ms.", font=f12, fill=MUTED)
    return img


frames = [frame(i) for i in range(FRAMES)]
frames[0].save(
    "assets/demo.gif",
    save_all=True,
    append_images=frames[1:],
    duration=FRAME_MS,
    loop=0,
    optimize=True,
)
print(f"wrote assets/demo.gif — {FRAMES} frames at {FPS} fps")
