"""End-to-end: feed test screenshots to the running app, compare FEN with truth, time it.
usage: python tests/e2e.py [url] [shots_dir]"""
import sys, json, base64, os, time
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
d = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'shots')
truth = json.load(open(os.path.join(d, 'truth.json')))


def expand(pl):
    out = []
    for row in pl.split('/'):
        for ch in row: out += ['.'] * int(ch) if ch.isdigit() else [ch]
    return out


with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1360, 'height': 900})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(url); pg.wait_for_function("document.querySelector('#pill-model').classList.contains('ok')", timeout=15000)
    tot_sq = bad_sq = perfect = orient_ok = det_ok = 0; times = []
    for t in truth:
        data = base64.b64encode(open(os.path.join(d, t['file']), 'rb').read()).decode()
        mime = 'image/jpeg' if t['file'].endswith('jpg') else 'image/png'
        r = pg.evaluate("""async ([b64, mime]) => {
            const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const t0 = performance.now(); await window.__augur.scan(new Blob([bin], {type: mime}));
            const S = window.__augur.S; return {ms: performance.now() - t0, placement: S.placement, orient: S.orient, box: S.box};
        }""", [data, mime])
        got, want = expand(r['placement']), expand(t['placement'])
        nb = sum(a != b for a, b in zip(got, want))
        bx = t['box']; db = max(abs(r['box']['x'] - bx[0]), abs(r['box']['y'] - bx[1]), abs(r['box']['size'] - bx[2]))
        det_ok += db < bx[2] / 32; orient_ok += (r['orient'] == 'b') == t['flip']
        tot_sq += 64; bad_sq += nb; perfect += nb == 0; times.append(r['ms'])
        print(f"{t['file']}: {nb:2d} wrong  box_err={db:5.1f}px  orient={'ok' if (r['orient'] == 'b') == t['flip'] else 'WRONG'}  {r['ms']:.0f}ms")
    n = len(truth)
    print(f"\nsquares {100 * (1 - bad_sq / tot_sq):.2f}% | perfect boards {perfect}/{n} | board found {det_ok}/{n} | orientation {orient_ok}/{n} | median {sorted(times)[n // 2]:.0f}ms max {max(times):.0f}ms")
    if errs: print('page errors:', errs[:5])
