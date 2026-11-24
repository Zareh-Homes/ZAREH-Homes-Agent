"""Free 90s Christmas Reel for Zareh Homes, built from Daniel's photos.

Usage: python3 build_reel.py <photo_dir> <out.mp4>
Renders 1080x1920 @ 24fps: Ken Burns moves, warm 90s film grade, grain,
falling snow, serif text cards. No paid tools.
"""
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

W, H, FPS = 1080, 1920, 24
SERIF = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"
SERIF_I = "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf"
SERIF_B = "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"
rng = np.random.default_rng(7)

# (file, seconds, focus x 0-1, zoom start, zoom end, caption)
SHOTS = [
    ("c4aac03f-image.png", 5.0, 0.50, 1.00, 1.10, "This year, a lot of buyers\nalmost gave up."),
    ("f0a51533-image.jpg", 4.5, 0.55, 1.12, 1.00, "Rates. Bidding wars.\nOffers that didn't go through."),
    ("416a40b5-image.jpg", 4.5, 0.70, 1.00, 1.10, "Some of them\nkept going anyway."),
    ("d7c53084-image.jpg", 4.5, 0.66, 1.08, 1.00, "And this Christmas,\nthey're home."),
    ("777f0090-image.jpg", 4.5, 0.60, 1.00, 1.08, "That part never gets old."),
]
TITLE_S, END_S, FADE = 4.0, 5.0, 0.6


def grade(img):
    """Warm tungsten 90s Kodak look: warm mids, faded blacks, soft glow."""
    a = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
    a = a * np.array([1.06, 1.0, 0.88]) + np.array([0.02, 0.01, 0.0])
    a = 0.06 + a * 0.90                       # faded blacks, soft highlights
    lum = a.mean(axis=2, keepdims=True)
    a = lum + (a - lum) * 0.85                # slightly muted colour
    a = np.clip(a, 0, 1)
    out = Image.fromarray((a * 255).astype(np.uint8))
    glow = out.filter(ImageFilter.GaussianBlur(18))
    return Image.blend(out, ImageChops_screen(out, glow), 0.25)


def ImageChops_screen(a, b):
    from PIL import ImageChops
    return ImageChops.screen(a, b)


def prep(path, focus_x):
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    iw, ih = img.size
    # crop to 9:16 around focus, keep extra resolution for zoom
    cw = min(iw, int(ih * W / H))
    ch = int(cw * H / W)
    x0 = int(np.clip(focus_x * iw - cw / 2, 0, iw - cw))
    y0 = max(0, (ih - ch) // 2)
    img = img.crop((x0, y0, x0 + cw, y0 + ch)).resize((int(W * 1.2), int(H * 1.2)), Image.LANCZOS)
    return grade(img)


def kenburns(img, t, z0, z1):
    z = z0 + (z1 - z0) * (0.5 - 0.5 * np.cos(np.pi * t))   # eased
    bw, bh = img.size
    cw, ch = bw / (1.2 * z), bh / (1.2 * z)
    cx, cy = bw / 2, bh / 2
    box = (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2)
    return img.resize((W, H), Image.BICUBIC, box=box)


def vignette():
    y, x = np.ogrid[-1:1:H * 1j, -1:1:W * 1j]
    v = 1 - 0.45 * np.clip((x ** 2 + y ** 2) / 1.6, 0, 1)
    return v[..., None].astype(np.float32)


VIG = vignette()
_g = np.clip((np.linspace(0, 1, H) - 0.58) / 0.3, 0, 1) * 0.6
BOTTOM = (1 - _g)[:, None, None].astype(np.float32)
GRAIN = [rng.normal(0, 6, (H // 2, W // 2, 1)).astype(np.float32).repeat(2, 0).repeat(2, 1) for _ in range(6)]

# snow flakes: x, y, radius, speed, drift phase
N = 170
flakes = np.stack([rng.uniform(0, W, N), rng.uniform(0, H, N), rng.uniform(1.5, 6, N),
                   rng.uniform(40, 120, N), rng.uniform(0, 6.28, N)], axis=1)


def snow_layer(t):
    layer = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(layer)
    for x, y, r, s, ph in flakes:
        yy = (y + s * t * (r / 3)) % (H + 20) - 10
        xx = (x + 25 * np.sin(t * 0.8 + ph)) % W
        d.ellipse((xx - r, yy - r, xx + r, yy + r), fill=int(120 + 25 * r))
    return layer.filter(ImageFilter.GaussianBlur(1.2))


def draw_text(img, text, y_center, size, font=SERIF, alpha=1.0, spacing=1.25):
    if alpha <= 0:
        return img
    f = ImageFont.truetype(font, size)
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    lines = text.split("\n")
    lh = int(size * spacing)
    y = y_center - lh * len(lines) / 2
    for line in lines:
        w = d.textlength(line, font=f)
        x = (W - w) / 2
        for dx, dy in ((2, 3), (0, 2)):
            d.text((x + dx, y + dy), line, font=f, fill=(0, 0, 0, int(150 * alpha)))
        d.text((x, y), line, font=f, fill=(255, 244, 225, int(255 * alpha)))
        y += lh
    return Image.alpha_composite(img.convert("RGBA"), over).convert("RGB")


def night_bg():
    y = np.linspace(0, 1, H)[:, None, None]
    top, bot = np.array([14, 22, 44]), np.array([46, 58, 88])
    a = (top + (bot - top) * y) * np.ones((1, W, 1))
    return Image.fromarray(a.astype(np.uint8))


def finish(frame, t, i, fade):
    a = np.asarray(frame).astype(np.float32)
    snow = np.asarray(snow_layer(t)).astype(np.float32)[..., None] / 255.0
    a = a * (1 - snow) + 250 * snow
    a = a * VIG + GRAIN[i % len(GRAIN)]
    a = a * fade
    return np.clip(a, 0, 255).astype(np.uint8)


def ease_alpha(t, dur, fin=0.5, fout=0.5):
    return float(np.clip(min(t / fin, (dur - t) / fout), 0, 1))


def main(photo_dir, out):
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
         "-shortest", "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    n = 0
    bg = night_bg()

    # title card
    for k in range(int(TITLE_S * FPS)):
        t = k / FPS
        f = draw_text(bg, "Home for Christmas", H * 0.45, 104, SERIF_I, ease_alpha(t - 0.3, TITLE_S - 0.3, 0.9, 0.6))
        f = draw_text(f, "A ZAREH HOMES STORY", H * 0.53, 38, SERIF, ease_alpha(t - 1.0, TITLE_S - 1.0, 0.9, 0.6), 1.0)
        ff.stdin.write(finish(f, n / FPS, n, 1.0).tobytes()); n += 1

    for name, dur, fx, z0, z1, cap in SHOTS:
        img = prep(f"{photo_dir}/{name}", fx)
        frames = int(dur * FPS)
        for k in range(frames):
            t = k / FPS
            f = kenburns(img, k / frames, z0, z1)
            f = Image.fromarray((np.asarray(f).astype(np.float32) * BOTTOM).astype(np.uint8))
            f = draw_text(f, cap, H * 0.78, 64, SERIF, ease_alpha(t - 0.4, dur - 0.4, 0.6, 0.5))
            fade = min(1.0, t / FADE, (dur - t) / FADE + 0.15)
            ff.stdin.write(finish(f, n / FPS, n, max(fade, 0)).tobytes()); n += 1

    # end card
    for k in range(int(END_S * FPS)):
        t = k / FPS
        f = draw_text(bg, "Merry Christmas", H * 0.42, 100, SERIF_I, ease_alpha(t - 0.2, END_S, 0.9, 99))
        f = draw_text(f, "ZAREH HOMES", H * 0.52, 72, SERIF_B, ease_alpha(t - 1.0, END_S, 0.9, 99), 1.0)
        f = draw_text(f, "Daniel Zareh", H * 0.575, 42, SERIF, ease_alpha(t - 1.6, END_S, 0.9, 99), 1.0)
        fade = min(1.0, t / FADE, (END_S - t) / 0.8 + 0.0) if t > END_S - 0.8 else min(1.0, t / FADE)
        ff.stdin.write(finish(f, n / FPS, n, fade).tobytes()); n += 1

    ff.stdin.close()
    ff.wait()
    print(f"{n} frames, {n / FPS:.1f}s -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
