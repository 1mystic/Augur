const mkCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
// Board localisation for digital screenshots.
// Idea: on a checkerboard every internal grid line is one long, unbroken
// colour edge that spans exactly the board's height (or width). Find columns
// whose longest edge-run is long, group them by run span, and the group whose
// spacing == span/8 is the board.

const EDGE_T = 14;

function edgeRuns(px, W, H, vertical) {
  // returns per-line {len, a, b}: longest run along the line where an edge exists
  const N = vertical ? W - 1 : H - 1;   // lines between pixel columns/rows
  const L = vertical ? H : W;          // length along the line
  const gapMax = Math.max(4, Math.round(Math.min(W, H) * 0.008));
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    let best = { len: 0, a: 0, b: 0 }, start = -1, last = -1;
    for (let j = 0; j < L; j++) {
      const p = vertical ? (j * W + i) * 4 : (i * W + j) * 4;
      const q = vertical ? p + 4 : p + W * 4;
      const d = Math.max(Math.abs(px[p] - px[q]), Math.abs(px[p + 1] - px[q + 1]), Math.abs(px[p + 2] - px[q + 2]));
      if (d > EDGE_T) {
        if (start < 0 || j - last > gapMax) start = j;
        last = j;
        if (last - start > best.len) best = { len: last - start, a: start, b: last };
      }
    }
    out[i] = best;
  }
  return out;
}

function findGrid(runs, minLen) {
  // merge adjacent candidate lines (anti-aliased edges are 2px wide)
  const cand = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.len < minLen) continue;
    const prev = cand[cand.length - 1];
    if (prev && i - prev.last <= 2 && Math.abs(prev.a - r.a) < 6 && Math.abs(prev.b - r.b) < 6) {
      prev.sum += i; prev.n++; prev.last = i; if (r.len > prev.len) Object.assign(prev, { len: r.len, a: r.a, b: r.b });
    } else cand.push({ sum: i, n: 1, last: i, len: r.len, a: r.a, b: r.b });
  }
  cand.forEach(c => (c.pos = c.sum / c.n + 0.5));
  let best = null;
  for (const ref of cand) {
    const span = ref.b - ref.a, step = span / 8, tol = Math.max(2.5, step * 0.06);
    const group = cand.filter(c => Math.abs(c.a - ref.a) <= tol * 1.5 && Math.abs(c.b - ref.b) <= tol * 1.5);
    if (group.length < 5) continue;
    for (const g of group) for (let k = 0; k <= 8; k++) {
      const x0 = g.pos - k * step;
      let hits = 0, sx = 0, sk = 0, skk = 0, sxk = 0;
      for (let kk = 1; kk <= 7; kk++) {
        const want = x0 + kk * step;
        const m = group.find(c => Math.abs(c.pos - want) < tol);
        if (m) { hits++; sx += m.pos; sk += kk; skk += kk * kk; sxk += m.pos * kk; }
      }
      if (hits >= 5 && (!best || hits > best.hits || (hits === best.hits && span > best.span))) {
        // least-squares refine origin with fixed step
        const fx0 = (sx - step * sk) / hits;
        best = { hits, span, start: fx0, step, a: ref.a, b: ref.b };
      }
    }
  }
  return best;
}

/** @returns {{x,y,size,score}|null} box in source pixel coords */
export function detectBoard(img) {
  const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
  const W = Math.round(img.width * scale), H = Math.round(img.height * scale);
  const c = mkCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const minLen = Math.max(80, Math.min(W, H) * 0.18);
  const v = findGrid(edgeRuns(px, W, H, true), minLen);    // gives x grid, y span
  const h = findGrid(edgeRuns(px, W, H, false), minLen);   // gives y grid, x span
  let box = null;
  if (v && h && Math.abs(v.span - h.span) < Math.max(v.span, h.span) * 0.05) {
    // the vertical lines' run span IS the board's y-extent, the horizontal lines' run span its x-extent
    box = { x: h.a, y: v.a, size: (v.span + h.span) / 2 + 1, score: v.hits + h.hits };
  } else if (v || h) {
    const g = !h || (v && v.hits >= h.hits) ? v : h;
    box = g === v ? { x: v.start, y: v.a, size: v.span + 1, score: v.hits } : { x: h.a, y: h.start, size: h.span + 1, score: h.hits };
  }
  if (!box) return null;
  return { x: box.x / scale, y: box.y / scale, size: box.size / scale, score: box.score };
}

/** Fallback when no grid is found: treat the largest centred square as the board. */
export function fallbackBox(img) {
  const s = Math.min(img.width, img.height);
  return { x: (img.width - s) / 2, y: (img.height - s) / 2, size: s, score: 0 };
}
