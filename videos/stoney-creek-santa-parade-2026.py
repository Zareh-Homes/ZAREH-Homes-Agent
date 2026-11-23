import math, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS, DUR = 1080, 1920, 30, 14
N = FPS * DUR
OUT = sys.argv[1]
random.seed(7)
F_B = "/usr/share/fonts/opentype/inter/Inter-Bold.otf"
F_XB = "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf"
F_SB = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"
font = lambda p, s: ImageFont.truetype(p, s)

LIGHTS = [(255, 70, 70), (80, 220, 110), (255, 210, 60), (90, 160, 255), (255, 120, 220), (255, 160, 50)]

# ---------- static backdrop (sky + buildings), drawn wide for parallax ----------
BW = W * 2
bg = Image.new("RGB", (BW, H))
d = ImageDraw.Draw(bg)
for y in range(H):
    t = y / H
    d.line([(0, y), (BW, y)], fill=(int(10 + 20 * t), int(14 + 18 * t), int(38 + 30 * t)))
x = 0
while x < BW:
    bw = random.randint(160, 300); bh = random.randint(500, 900)
    top = 1250 - bh
    col = random.choice([(34, 30, 44), (44, 36, 40), (30, 34, 50), (50, 40, 36)])
    d.rectangle([x, top, x + bw, 1300], fill=col)
    for wy in range(top + 40, 1220, 90):
        for wx in range(x + 25, x + bw - 40, 60):
            if random.random() < 0.6:
                d.rectangle([wx, wy, wx + 30, wy + 45], fill=random.choice([(255, 210, 130), (255, 190, 110), (240, 230, 190)]))
    # string lights along rooflines
    for lx in range(x, x + bw, 22):
        ly = top + 8 + int(10 * math.sin(lx / 30))
        d.ellipse([lx - 5, ly - 5, lx + 5, ly + 5], fill=random.choice(LIGHTS))
    x += bw + random.randint(0, 20)
# street
d.rectangle([0, 1300, BW, H], fill=(48, 46, 52))
d.rectangle([0, 1300, BW, 1325], fill=(120, 120, 128))  # curb far
bg = bg.filter(ImageFilter.GaussianBlur(4))

# ---------- parade floats ----------
def draw_lights(dr, x0, x1, y, f, sag=14, step=26):
    for i, lx in enumerate(range(int(x0), int(x1), step)):
        p = (lx - x0) / max(1, (x1 - x0))
        ly = y + sag * math.sin(p * math.pi)
        c = LIGHTS[(i + f // 6) % len(LIGHTS)]
        on = ((i * 7 + f // 5) % 9) != 0
        r = 9 if on else 6
        if on:
            dr.ellipse([lx - 18, ly - 18, lx + 18, ly + 18], fill=tuple(int(v * 0.35) for v in c))
        dr.ellipse([lx - r, ly - r, lx + r, ly + r], fill=c if on else tuple(v // 3 for v in c))

def wheel(dr, cx, cy, r=42):
    dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(20, 20, 22))
    dr.ellipse([cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2], fill=(140, 140, 150))

def tree(dr, cx, base, h, f):
    dr.polygon([(cx, base - h), (cx - h * 0.38, base), (cx + h * 0.38, base)], fill=(30, 120, 60))
    for k in range(10):
        yy = base - h + h * (k + 1) / 11
        half = h * 0.38 * (k + 1) / 11
        xx = cx + half * math.sin(k * 2.3) * 0.8
        c = LIGHTS[(k + f // 8) % 6]
        dr.ellipse([xx - 7, yy - 7, xx + 7, yy + 7], fill=c)
    dr.regular_polygon((cx, base - h - 8, 18), 5, fill=(255, 220, 80))

def truck(dr, x, y, color):
    dr.rounded_rectangle([x, y - 230, x + 300, y], 26, fill=color)
    dr.rounded_rectangle([x + 170, y - 210, x + 280, y - 120], 12, fill=(150, 190, 230))
    dr.rectangle([x + 280, y - 60, x + 310, y - 30], fill=(255, 240, 180))  # headlight
    dr.ellipse([x + 285, y - 75, x + 380, y - 15], fill=(80, 75, 50))  # glow
    wheel(dr, x + 70, y); wheel(dr, x + 230, y)

def float_trailer(dr, x, y, w, color, f):
    dr.rectangle([x, y - 150, x + w, y], fill=color)
    dr.rectangle([x, y - 150, x + w, y - 130], fill=(240, 240, 240))
    draw_lights(dr, x, x + w, y - 140, f, sag=0, step=30)
    draw_lights(dr, x, x + w, y - 8, f + 3, sag=0, step=30)
    wheel(dr, x + 90, y); wheel(dr, x + w - 90, y)

def santa(dr, cx, base, f):
    bob = 6 * math.sin(f / 5)
    b = base + bob
    # sleigh
    dr.rounded_rectangle([cx - 190, b - 150, cx + 190, b], 40, fill=(190, 25, 35))
    dr.rectangle([cx - 190, b - 30, cx + 190, b - 10], fill=(230, 190, 60))
    # body
    dr.ellipse([cx - 85, b - 330, cx + 85, b - 120], fill=(215, 30, 40))
    dr.rectangle([cx - 85, b - 210, cx + 85, b - 185], fill=(30, 25, 25))
    dr.rectangle([cx - 20, b - 212, cx + 20, b - 183], fill=(230, 190, 60))
    # head
    dr.ellipse([cx - 55, b - 430, cx + 55, b - 320], fill=(245, 205, 175))
    dr.ellipse([cx - 62, b - 385, cx + 62, b - 285], fill=(250, 250, 250))  # beard
    dr.ellipse([cx - 22, b - 395, cx + 22, b - 370], fill=(250, 250, 250))  # moustache
    dr.ellipse([cx - 26, b - 405, cx - 14, b - 393], fill=(30, 30, 30))
    dr.ellipse([cx + 14, b - 405, cx + 26, b - 393], fill=(30, 30, 30))
    dr.polygon([(cx - 60, b - 418), (cx + 60, b - 418), (cx + 85, b - 500)], fill=(215, 30, 40))
    dr.rounded_rectangle([cx - 66, b - 432, cx + 66, b - 408], 12, fill=(250, 250, 250))
    dr.ellipse([cx + 72, b - 515, cx + 100, b - 487], fill=(250, 250, 250))
    # waving arm
    a = math.sin(f / 4) * 0.5
    ax, ay = cx + 80, b - 260
    hx, hy = ax + 110 * math.cos(-1.1 + a), ay + 110 * math.sin(-1.1 + a)
    dr.line([(ax, ay), (hx, hy)], fill=(215, 30, 40), width=38)
    dr.ellipse([hx - 24, hy - 24, hx + 24, hy + 24], fill=(250, 250, 250))
    draw_lights(dr, cx - 190, cx + 190, b - 150, f, sag=-20, step=28)

def gifts(dr, x, base):
    cols = [(60, 140, 220), (240, 200, 60), (220, 60, 90), (90, 200, 120)]
    for i, (dx, s) in enumerate([(0, 110), (120, 140), (275, 95), (60, 80)]):
        yb = base if i < 3 else base - 110
        c = cols[i]
        dr.rectangle([x + dx, yb - s, x + dx + s, yb], fill=c)
        dr.rectangle([x + dx + s // 2 - 8, yb - s, x + dx + s // 2 + 8, yb], fill=(250, 250, 250))
        dr.rectangle([x + dx, yb - s // 2 - 8, x + dx + s, yb - s // 2 + 8], fill=(250, 250, 250))

ROAD_Y = 1560
def parade_layer(f):
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dr = ImageDraw.Draw(lay)
    speed = 7
    unit = 1700  # length of one truck+float
    offset = (f * speed) % (unit * 3)
    for k in range(-1, 4):
        x0 = -unit * 3 + offset + k * unit
        kind = k % 3
        tc = [(30, 90, 170), (170, 40, 40), (40, 120, 70)][kind]
        float_trailer(dr, x0, ROAD_Y, 1000, [(120, 30, 40), (30, 70, 120), (60, 40, 90)][kind], f)
        truck(dr, x0 + 1040, ROAD_Y, tc)
        if kind == 0:
            santa(dr, x0 + 500, ROAD_Y - 150, f)
            tree(dr, x0 + 130, ROAD_Y - 150, 260, f); tree(dr, x0 + 870, ROAD_Y - 150, 260, f)
        elif kind == 1:
            for i, cx in enumerate([180, 420, 660, 880]):
                tree(dr, x0 + cx, ROAD_Y - 150, 300 + 60 * (i % 2), f + i * 5)
        else:
            gifts(dr, x0 + 120, ROAD_Y - 150); gifts(dr, x0 + 560, ROAD_Y - 150)
    return lay.filter(ImageFilter.GaussianBlur(2.2))

# crowd silhouettes foreground
crowd = Image.new("RGBA", (W, H), (0, 0, 0, 0))
cd = ImageDraw.Draw(crowd)
for i in range(16):
    cx = i * 75 + random.randint(-15, 15); top = 1700 + random.randint(-40, 50)
    cd.ellipse([cx - 40, top - 85, cx + 40, top], fill=(12, 12, 18, 255))
    cd.rounded_rectangle([cx - 75, top - 10, cx + 75, H + 40], 60, fill=(12, 12, 18, 255))
    if random.random() < 0.35:  # toque
        cd.pieslice([cx - 42, top - 110, cx + 42, top - 40], 180, 360, fill=random.choice([(150, 20, 30, 255), (20, 90, 50, 255)]))
crowd = crowd.filter(ImageFilter.GaussianBlur(6))

flakes = [[random.uniform(0, W), random.uniform(0, H), random.uniform(2, 7), random.uniform(1.5, 4)] for _ in range(170)]

# ---------- captions ----------
def ease(t):
    t = max(0.0, min(1.0, t)); return 1 - (1 - t) ** 3

def wrap_box(img, lines, fnt, cy, fg, bgc, t, pad=(46, 22), radius=28):
    if t <= 0: return None
    a = ease(t)
    dr = ImageDraw.Draw(img)
    lh = fnt.size * 1.18
    sizes = [dr.textbbox((0, 0), l, font=fnt) for l in lines]
    total_h = lh * len(lines)
    y = cy - total_h / 2 + (1 - a) * 40
    y0 = y; first = None
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0)); ld = ImageDraw.Draw(layer)
    for l, bb in zip(lines, sizes):
        w = bb[2] - bb[0]
        x = (W - w) / 2
        ld.rounded_rectangle([x - pad[0], y - pad[1] + 4, x + w + pad[0], y + lh + pad[1] - 10], radius, fill=bgc + (int(255 * a),))
        if first is None: first = (x - pad[0], y - pad[1] + 4)
        y += lh
    y = y0
    for l, bb in zip(lines, sizes):
        w = bb[2] - bb[0]
        ld.text(((W - w) / 2 - bb[0], y + (lh - fnt.size) / 2 - bb[1] * 0.3), l, font=fnt, fill=fg + (int(255 * a),))
        y += lh
    img.alpha_composite(layer)
    return first

def santa_hat(img, x, y, a):
    if a <= 0: return
    l = Image.new("RGBA", img.size, (0, 0, 0, 0)); d2 = ImageDraw.Draw(l)
    A = int(255 * a)
    d2.polygon([(x, y + 70), (x + 90, y + 70), (x + 110, y)], fill=(215, 30, 40, A))
    d2.rounded_rectangle([x - 8, y + 60, x + 98, y + 88], 14, fill=(255, 255, 255, A))
    d2.ellipse([x + 98, y - 14, x + 126, y + 14], fill=(255, 255, 255, A))
    img.alpha_composite(l)

f_cap = font(F_B, 76)
f_red = font(F_XB, 80)
f_ev1 = font(F_XB, 58); f_ev2 = font(F_B, 50); f_ev3 = font(F_SB, 40)
f_brand = font(F_XB, 44); f_brand2 = font(F_SB, 32)

def event_card(img, t):
    if t <= 0: return
    a = ease(t)
    l = Image.new("RGBA", img.size, (0, 0, 0, 0)); d2 = ImageDraw.Draw(l)
    y0 = 120 - (1 - a) * 60
    d2.rounded_rectangle([70, y0, W - 70, y0 + 330], 36, fill=(15, 55, 35, int(235 * a)), outline=(230, 190, 60, int(255 * a)), width=5)
    rows = [("STONEY CREEK", f_ev1, (255, 255, 255)), ("SANTA CLAUS PARADE", f_ev1, (255, 215, 90)),
            ("Saturday, December 5  •  2:00 PM", f_ev2, (255, 255, 255))]
    yy = y0 + 38
    for txt, fn, c in rows:
        bb = d2.textbbox((0, 0), txt, font=fn)
        d2.text(((W - (bb[2] - bb[0])) / 2 - bb[0], yy), txt, font=fn, fill=c + (int(255 * a),))
        yy += fn.size + 30
    img.alpha_composite(l)

def brand(img, t):
    if t <= 0: return
    a = ease(t)
    l = Image.new("RGBA", img.size, (0, 0, 0, 0)); d2 = ImageDraw.Draw(l)
    y0 = 1740 + (1 - a) * 40
    d2.rounded_rectangle([250, y0, W - 250, y0 + 120], 60, fill=(255, 255, 255, int(240 * a)))
    for txt, fn, c, dy in [("ZAREH HOMES", f_brand, (20, 20, 25), 14), ("See you there!", f_brand2, (190, 30, 40), 68)]:
        bb = d2.textbbox((0, 0), txt, font=fn)
        d2.text(((W - (bb[2] - bb[0])) / 2 - bb[0], y0 + dy), txt, font=fn, fill=c + (int(255 * a),))
    img.alpha_composite(l)

ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "19", "-preset", "medium", "-movflags", "+faststart", OUT], stdin=subprocess.PIPE)

for f in range(N):
    s = f / FPS
    px = int((f * 1.2) % (BW - W))
    frame = bg.crop((px, 0, px + W, H)).convert("RGBA")
    frame.alpha_composite(parade_layer(f))
    frame.alpha_composite(crowd)
    sd = ImageDraw.Draw(frame)
    for fl in flakes:
        fl[1] += fl[3]; fl[0] += math.sin((f + fl[2] * 10) / 20) * 0.8
        if fl[1] > H: fl[1] = -10; fl[0] = random.uniform(0, W)
        sd.ellipse([fl[0] - fl[2], fl[1] - fl[2], fl[0] + fl[2], fl[1] + fl[2]], fill=(255, 255, 255, 200))
    # slight darkening for legibility
    frame.alpha_composite(Image.new("RGBA", (W, H), (0, 0, 0, 40)))

    t1 = (s - 0.4) / 0.5
    fb = wrap_box(frame, ["Some kids believe in", "Santa..."], f_cap, 620, (15, 15, 15), (255, 255, 255), t1)
    if fb: santa_hat(frame, int(fb[0]) - 30, int(fb[1]) - 62, ease(t1))
    wrap_box(frame, ["Some adults believe", "mortgage rates", "will return to 3%"], f_red, 960, (255, 255, 255), (232, 96, 82), (s - 2.4) / 0.5)
    wrap_box(frame, ["Different ages. Same", "Christmas wish."], f_cap, 1310, (15, 15, 15), (255, 255, 255), (s - 4.6) / 0.5)
    event_card(frame, (s - 6.6) / 0.6)
    brand(frame, (s - 7.6) / 0.6)
    ff.stdin.write(frame.convert("RGB").tobytes())

ff.stdin.close(); ff.wait()
print("done", OUT)
