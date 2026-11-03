"""Synthetic tile generator for the Augur square classifier.

Renders a 3x3 neighbourhood of board squares (so crops can bleed into
neighbours like real misaligned crops do), drops a piece in the middle,
adds the clutter real chess UIs draw (last-move highlights, coordinates,
move dots, arrows, check glow), then crops + downsamples to 32x32.
"""
import io, os, random, sys, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import cairosvg

CLASSES = ['.', 'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k']
T = 32
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = [f for f in glob.glob('/usr/share/fonts/truetype/dejavu/*.ttf') if 'Sans' in f]

THEMES = [  # (light, dark) pairs seen on lichess / chess.com / apps
    ('#f0d9b5', '#b58863'), ('#dee3e6', '#8ca2ad'), ('#ffffdd', '#86a666'),
    ('#ebecd0', '#739552'), ('#eeeed2', '#769656'), ('#e8edf9', '#b7c0d8'),
    ('#9f90b0', '#7d4a8d'), ('#ececec', '#c1c18e'), ('#d9d9d9', '#a9a9a9'),
    ('#f0f1f0', '#c4d8e4'), ('#e8e9b7', '#ed7272'), ('#eae9d2', '#4b7399'),
    ('#f1f6b2', '#59935d'), ('#e3c16f', '#b88b4a'), ('#dfc49f', '#a87a53'),
    ('#cad7e2', '#5d8aa8'), ('#fce4b2', '#d08b18'), ('#e6e6e6', '#7c7c7c'),
    ('#f3dcc2', '#c49a6c'), ('#d8e3e7', '#6e8fa0'), ('#ffffff', '#000000'),
]
HIGHLIGHTS = [((255, 255, 51), .5), ((155, 199, 0), .41), ((20, 85, 30), .5),
              ((235, 97, 80), .8), ((0, 120, 255), .35), ((246, 246, 105), .8),
              ((186, 202, 68), .9), ((130, 151, 105), .6)]


def hex2rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def load_sets(names=None):
    sets = {}
    for d in sorted(glob.glob(os.path.join(HERE, 'pieces', '*'))):
        name = os.path.basename(d)
        if names and name not in names: continue
        imgs = {}
        for c in CLASSES[1:]:
            fn = ('w' if c.isupper() else 'b') + c.upper()
            png = cairosvg.svg2png(url=os.path.join(d, fn + '.svg'), output_width=160, output_height=160)
            imgs[c] = Image.open(io.BytesIO(png)).convert('RGBA')
        sets[name] = imgs
    return sets


def rand_theme(rng):
    if rng.random() < .65:
        l, d = rng.choice(THEMES); l, d = hex2rgb(l), hex2rgb(d)
    else:
        import colorsys
        h = rng.random(); s = rng.uniform(0, .6)
        l = tuple(int(255 * v) for v in colorsys.hls_to_rgb(h, rng.uniform(.72, .95), s))
        d = tuple(int(255 * v) for v in colorsys.hls_to_rgb(h + rng.uniform(-.1, .1), rng.uniform(.3, .62), s))
    jit = lambda c: tuple(int(np.clip(v + rng.gauss(0, 6), 0, 255)) for v in c)
    return jit(l), jit(d)


def make_tile(sets, rng, cls=None):
    if cls is None:
        cls = '.' if rng.random() < .28 else rng.choice(CLASSES[1:])
    pset = sets[rng.choice(list(sets))]
    S = rng.randint(26, 110)
    light, dark = rand_theme(rng)
    canvas = Image.new('RGB', (3 * S, 3 * S))
    dr = ImageDraw.Draw(canvas, 'RGBA')
    center_light = rng.random() < .5
    texture = rng.random() < .15
    for gy in range(3):
        for gx in range(3):
            is_light = center_light ^ ((gx + gy) % 2 == 1)
            dr.rectangle([gx * S, gy * S, gx * S + S - 1, gy * S + S - 1], fill=light if is_light else dark)
    if texture:  # wood-ish / marble-ish noise
        arr = np.asarray(canvas).astype(np.float32)
        n = np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, rng.uniform(3, 12), (3 * S, 1 if rng.random() < .5 else 3 * S, 1))
        arr = np.clip(arr + n, 0, 255).astype(np.uint8); canvas = Image.fromarray(arr)
        dr = ImageDraw.Draw(canvas, 'RGBA')
    # highlights (center + random neighbours)
    for gy in range(3):
        for gx in range(3):
            p = .28 if (gx, gy) == (1, 1) else .06
            if rng.random() < p:
                col, a = rng.choice(HIGHLIGHTS)
                dr.rectangle([gx * S, gy * S, gx * S + S - 1, gy * S + S - 1], fill=col + (int(255 * a * rng.uniform(.7, 1.1)) & 255,))
    # check glow on kings
    if cls in 'Kk' and rng.random() < .15:
        glow = Image.new('RGBA', (S, S), (0, 0, 0, 0)); g = ImageDraw.Draw(glow)
        for r in range(S // 2, 0, -2):
            g.ellipse([S / 2 - r, S / 2 - r, S / 2 + r, S / 2 + r], fill=(255, 0, 0, int(200 * (1 - r / (S / 2)))))
        canvas.paste(glow, (S, S), glow)
    # coordinates
    if rng.random() < .35 and FONTS:
        f = ImageFont.truetype(rng.choice(FONTS), max(7, int(S * rng.uniform(.14, .24))))
        col = dark if center_light else light
        if rng.random() < .5: dr.text((S + S * .05, S + S * .03), str(rng.randint(1, 8)), font=f, fill=col)
        if rng.random() < .5: dr.text((S + S * .78, S + S * .72), rng.choice('abcdefgh'), font=f, fill=col)

    def put_piece(c, gx, gy, partial=False):
        img = pset[c]
        if rng.random() < .3:  # outline thickness change
            a = img.getchannel('A')
            a = a.filter(ImageFilter.MaxFilter(rng.choice([3, 5])) if rng.random() < .5 else ImageFilter.MinFilter(3))
            r, g, b, _ = img.split(); img = Image.merge('RGBA', (r, g, b, a))
        if rng.random() < .35:  # recolour: hue shift / desaturate / tint pieces
            arr = np.asarray(img).astype(np.float32)
            rgb = arr[..., :3]
            lum = rgb @ np.array([.299, .587, .114], np.float32)
            mode = rng.random()
            if mode < .4: rgb = lum[..., None].repeat(3, -1)
            elif mode < .8:
                tint = np.array([rng.uniform(.75, 1.15) for _ in range(3)], np.float32)
                rgb = np.clip(rgb * tint, 0, 255)
            else:
                rgb = rgb[..., list(np.random.default_rng(rng.randint(0, 1 << 30)).permutation(3))]
            gam = rng.uniform(.8, 1.25); rgb = 255 * (rgb / 255) ** gam
            arr[..., :3] = rgb; img = Image.fromarray(arr.astype(np.uint8), 'RGBA')
        sc = rng.uniform(.68, 1.03)
        sw, sh = max(4, int(S * sc * rng.uniform(.92, 1.08))), max(4, int(S * sc * rng.uniform(.92, 1.08)))
        im = img.resize((sw, sh), Image.LANCZOS)
        if rng.random() < .25: im = im.rotate(rng.uniform(-5, 5), Image.BICUBIC, expand=False)
        ox = int(gx * S + (S - sw) / 2 + rng.gauss(0, S * .025))
        oy = int(gy * S + (S - sh) / 2 + rng.gauss(0, S * .025) + (S * rng.uniform(0, .06) if rng.random() < .3 else 0))
        canvas.paste(im, (ox, oy), im)

    for gy in range(3):
        for gx in range(3):
            if (gx, gy) != (1, 1) and rng.random() < .35:
                put_piece(rng.choice(CLASSES[1:]), gx, gy)
    if cls != '.':
        put_piece(cls, 1, 1)
    dr = ImageDraw.Draw(canvas, 'RGBA')
    # move dots / capture rings
    if rng.random() < .1:
        r = S * rng.uniform(.12, .18)
        if cls == '.' or rng.random() < .3:
            dr.ellipse([1.5 * S - r, 1.5 * S - r, 1.5 * S + r, 1.5 * S + r], fill=(0, 0, 0, rng.randint(25, 70)))
        else:
            dr.ellipse([S + 2, S + 2, 2 * S - 2, 2 * S - 2], outline=(0, 0, 0, 60), width=max(2, S // 12))
    # arrows
    if rng.random() < .08:
        col = rng.choice([(255, 170, 0), (21, 120, 27), (130, 0, 0), (0, 48, 136)])
        pts = [(rng.uniform(0, 3 * S), rng.uniform(0, 3 * S)) for _ in range(2)]
        dr.line(pts, fill=col + (rng.randint(110, 200),), width=max(3, int(S * .18)))
    # crop with jitter
    cs = S * rng.uniform(.95, 1.05)
    cx = 1.5 * S + rng.gauss(0, S * .035); cy = 1.5 * S + rng.gauss(0, S * .035)
    box = (cx - cs / 2, cy - cs / 2, cx + cs / 2, cy + cs / 2)
    tile = canvas.crop(tuple(int(round(v)) for v in box))
    if rng.random() < .15: tile = tile.filter(ImageFilter.GaussianBlur(rng.uniform(.3, 1.2)))
    if rng.random() < .3:
        buf = io.BytesIO(); tile.save(buf, 'JPEG', quality=rng.randint(35, 90)); tile = Image.open(buf).convert('RGB')
    if rng.random() < .08: tile = tile.convert('L').convert('RGB')
    tile = tile.resize((T, T), rng.choice([Image.BILINEAR, Image.BOX, Image.LANCZOS, Image.BICUBIC]))
    a = np.asarray(tile).astype(np.float32)
    a = a * rng.uniform(.85, 1.12) + rng.uniform(-15, 15)
    return np.clip(a, 0, 255).astype(np.uint8), CLASSES.index(cls)


def build(n, set_names, seed, out):
    sets = load_sets(set_names)
    rng = random.Random(seed)
    X = np.zeros((n, T, T, 3), np.uint8); Y = np.zeros(n, np.int8)
    for i in range(n):
        X[i], Y[i] = make_tile(sets, rng)
    np.savez_compressed(out, X=X, Y=Y)


if __name__ == '__main__':
    n, seed, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    names = sys.argv[4].split(',') if len(sys.argv) > 4 else None
    build(n, names, seed, out)
