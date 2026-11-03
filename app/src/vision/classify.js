const mkCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
// Tiny CNN (3x conv3x3+relu+maxpool, 2 dense) — pure JS forward pass.
// Weights are trained offline (see /train) and shipped as a ~400KB float32 blob.
export const CLASSES = ['.', 'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];
const T = 32;
let W = null;

export async function loadModel(base = './model/') {
  if (W) return W;
  const [meta, buf] = await Promise.all([
    fetch(base + 'augur.json').then(r => r.json()),
    fetch(base + 'augur.bin').then(r => r.arrayBuffer()),
  ]);
  const all = new Float32Array(buf);
  W = {}; let off = 0;
  for (const k of meta.order) {
    const n = meta.shapes[k].reduce((a, b) => a * b, 1);
    W[k] = all.subarray(off, off + n); W[k + '_shape'] = meta.shapes[k]; off += n;
  }
  return W;
}

function conv3(x, H, Wd, Cin, w, b, Cout) {
  const out = new Float32Array(H * Wd * Cout);
  const acc = new Float32Array(Cout);
  for (let y = 0; y < H; y++) for (let xx = 0; xx < Wd; xx++) {
    acc.set(b);
    for (let ky = 0; ky < 3; ky++) {
      const yy = y + ky - 1; if (yy < 0 || yy >= H) continue;
      for (let kx = 0; kx < 3; kx++) {
        const xi = xx + kx - 1; if (xi < 0 || xi >= Wd) continue;
        const ib = (yy * Wd + xi) * Cin, wb = (ky * 3 + kx) * Cin * Cout;
        for (let ci = 0; ci < Cin; ci++) {
          const v = x[ib + ci]; if (v === 0) continue;
          const wo = wb + ci * Cout;
          for (let co = 0; co < Cout; co++) acc[co] += v * w[wo + co];
        }
      }
    }
    const ob = (y * Wd + xx) * Cout;
    for (let co = 0; co < Cout; co++) out[ob + co] = acc[co] > 0 ? acc[co] : 0;
  }
  return out;
}

function pool2(x, H, Wd, C) {
  const h = H >> 1, w = Wd >> 1, out = new Float32Array(h * w * C);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) for (let c = 0; c < C; c++) {
    const i = ((2 * y) * Wd + 2 * xx) * C + c;
    out[(y * w + xx) * C + c] = Math.max(x[i], x[i + C], x[i + Wd * C], x[i + Wd * C + C]);
  }
  return out;
}

function dense(x, w, b, nIn, nOut, relu) {
  const out = new Float32Array(nOut);
  out.set(b);
  for (let i = 0; i < nIn; i++) { const v = x[i]; if (v === 0) continue; const o = i * nOut; for (let j = 0; j < nOut; j++) out[j] += v * w[o + j]; }
  if (relu) for (let j = 0; j < nOut; j++) if (out[j] < 0) out[j] = 0;
  return out;
}

function forward(tile) {
  let x = tile, H = T, Wd = T, C = 3;
  for (let i = 0; i < 3; i++) {
    const Cout = W[`c${i}w_shape`][3];
    x = conv3(x, H, Wd, C, W[`c${i}w`], W[`c${i}b`], Cout); C = Cout;
    x = pool2(x, H, Wd, C); H >>= 1; Wd >>= 1;
  }
  const d0 = W.d0w_shape, d1 = W.d1w_shape;
  x = dense(x, W.d0w, W.d0b, d0[0], d0[1], true);
  const lo = dense(x, W.d1w, W.d1b, d1[0], d1[1], false);
  const m = Math.max(...lo); let s = 0; const p = lo.map(v => { const e = Math.exp(v - m); s += e; return e; });
  return p.map(v => v / s);
}

/** Classify all 64 squares. box in source px. Returns grid[row][col] (row 0 = top of image). */
export function classifyBoard(img, box) {
  const c = mkCanvas(T, T), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const s = box.size / 8, grid = [];
  // pre-shrink the board once to ~8*T*2 px so per-tile downscaling is gentle
  const mid = mkCanvas(T * 16, T * 16), mctx = mid.getContext('2d');
  mctx.imageSmoothingEnabled = true; mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(img, box.x, box.y, box.size, box.size, 0, 0, T * 16, T * 16);
  const ms = T * 2;
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let f = 0; f < 8; f++) {
      ctx.clearRect(0, 0, T, T);
      ctx.drawImage(mid, f * ms, r * ms, ms, ms, 0, 0, T, T);
      const d = ctx.getImageData(0, 0, T, T).data, x = new Float32Array(T * T * 3);
      for (let i = 0, j = 0; i < d.length; i += 4) { x[j++] = d[i] / 255; x[j++] = d[i + 1] / 255; x[j++] = d[i + 2] / 255; }
      const p = forward(x);
      let k = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[k]) k = i;
      row.push({ piece: CLASSES[k], conf: p[k], p });
    }
    grid.push(row);
  }
  void s;
  applyConstraints(grid);
  return grid;
}

const argmaxExcept = (p, banned) => { let k = -1; for (let i = 0; i < p.length; i++) if (!banned.has(i) && (k < 0 || p[i] > p[k])) k = i; return k; };

/** Chess sanity on top of per-square guesses: exactly one king per side, pawns never on the
 *  top/bottom row (true whatever the orientation). Re-labels the least likely offenders. */
function applyConstraints(grid) {
  const cells = grid.flat();
  const K = CLASSES.indexOf('K'), k = CLASSES.indexOf('k'), P = CLASSES.indexOf('P'), p = CLASSES.indexOf('p');
  grid.forEach((row, r) => row.forEach(c => {
    if ((r === 0 || r === 7) && (c.piece === 'P' || c.piece === 'p')) {
      const j = argmaxExcept(c.p, new Set([P, p])); c.piece = CLASSES[j]; c.conf = Math.min(c.conf, c.p[j]);
    }
  }));
  for (const [ki, other] of [[K, k], [k, K]]) {
    const best = cells.reduce((a, c) => (c.p[ki] > a.p[ki] ? c : a));
    for (const c of cells) {
      if (c === best) { if (c.piece !== CLASSES[ki] && c.p[ki] > 0.05) { c.piece = CLASSES[ki]; c.conf = Math.min(c.conf, c.p[ki]); } continue; }
      if (c.piece === CLASSES[ki]) { const j = argmaxExcept(c.p, new Set([ki, other])); c.piece = CLASSES[j]; c.conf = Math.min(c.conf, c.p[j]); }
    }
  }
}

/** Guess if the screenshot shows the board from Black's side. */
export function guessFlipped(grid) {
  let score = 0;
  grid.forEach((row, r) => row.forEach(({ piece }) => {
    if (piece === '.') return;
    const w = piece === piece.toUpperCase();
    const wgt = 'Kk'.includes(piece) ? 3 : 'Pp'.includes(piece) ? 1 : 0.5;
    score += (w ? 1 : -1) * (r - 3.5) * wgt;  // white low on screen -> positive
  }));
  return score < 0;
}

/** Build FEN placement field from the grid in the chosen orientation. */
export function gridToPlacement(grid, flipped) {
  const rows = [];
  for (let rank = 0; rank < 8; rank++) {
    let s = '', e = 0;
    for (let file = 0; file < 8; file++) {
      const r = flipped ? 7 - rank : rank, f = flipped ? 7 - file : file;
      const p = grid[r][f].piece;
      if (p === '.') e++; else { if (e) s += e; e = 0; s += p; }
    }
    if (e) s += e; rows.push(s);
  }
  return rows.join('/');
}
