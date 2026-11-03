"""Full-screenshot test images (held-out piece sets) with ground-truth FENs."""
import random, json, os, sys, io
import chess
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(__file__))
from gen import load_sets, THEMES, hex2rgb

out = sys.argv[1]; n = int(sys.argv[2]); names = sys.argv[3].split(',')
os.makedirs(out, exist_ok=True)
sets = load_sets(names); rng = random.Random(7)
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 13)
truth = []
for i in range(n):
    b = chess.Board()
    for _ in range(rng.randint(6, 70)):
        ms = list(b.legal_moves)
        if not ms or b.is_game_over(): break
        b.push(rng.choice(ms))
    last = b.peek() if b.move_stack else None
    flip = rng.random() < .4
    S = rng.choice([int(x) for x in os.environ.get("SIZES", "48,56,64,72,80,90,100").split(",")])
    light, dark = [hex2rgb(c) for c in rng.choice(THEMES[:-1])]
    pset = sets[rng.choice(names)]
    W, H = rng.choice([(1440, 900), (1280, 800), (1920, 1080), (8 * S + 40, 8 * S + 120)])
    W = max(W, 8 * S + 40); H = max(H, 8 * S + 100)
    img = Image.new('RGB', (W, H), rng.choice([(49, 46, 43), (22, 21, 18), (245, 245, 245), (38, 36, 33)]))
    d = ImageDraw.Draw(img, 'RGBA')
    bx = rng.randint(10, W - 8 * S - 10); by = rng.randint(50, H - 8 * S - 40)
    d.rectangle([bx, by - 40, bx + 300, by - 8], fill=(80, 80, 80)); d.text((bx + 8, by - 32), 'Opponent (1520)', font=font, fill=(230, 230, 230))
    d.rectangle([bx, by + 8 * S + 8, bx + 300, by + 8 * S + 38], fill=(80, 80, 80)); d.text((bx + 8, by + 8 * S + 14), 'You (1488)', font=font, fill=(230, 230, 230))
    if W - (bx + 8 * S) > 260: d.rectangle([bx + 8 * S + 20, by, W - 20, by + 8 * S], fill=(60, 58, 55))
    hl = rng.choice([(255, 255, 51, 128), (155, 199, 0, 105)])
    for r in range(8):
        for f in range(8):
            sq = chess.square(7 - f, r) if flip else chess.square(f, 7 - r)
            light_sq = (chess.square_file(sq) + chess.square_rank(sq)) % 2 == 1
            x, y = bx + f * S, by + r * S
            d.rectangle([x, y, x + S - 1, y + S - 1], fill=light if light_sq else dark)
            if last and sq in (last.from_square, last.to_square): d.rectangle([x, y, x + S - 1, y + S - 1], fill=hl)
            if f == 0: d.text((x + 3, y + 2), str(chess.square_rank(sq) + 1), font=font, fill=dark if light_sq else light)
            if r == 7: d.text((x + S - 11, y + S - 16), 'abcdefgh'[chess.square_file(sq)], font=font, fill=dark if light_sq else light)
            p = b.piece_at(sq)
            if p:
                im = pset[p.symbol()].resize((S, S), Image.LANCZOS); img.paste(im, (x, y), im)
    fn = f'{out}/t{i:02d}.' + ('jpg' if i % 3 == 0 else 'png')
    img.save(fn, quality=80) if fn.endswith('jpg') else img.save(fn)
    truth.append({'file': os.path.basename(fn), 'placement': b.board_fen(), 'flip': flip, 'box': [bx, by, 8 * S]})
json.dump(truth, open(f'{out}/truth.json', 'w'), indent=1)
print('ok', n)
