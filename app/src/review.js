// HTML builders for the Game-review and Tutor panels (kept string-based, like the rest of the UI).
import { CLASSES, CLASS_ORDER } from './coach.js';

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const badge = cls => (CLASSES[cls] ? `<span class="badge" style="background:${CLASSES[cls].color}" title="${CLASSES[cls].label}">${CLASSES[cls].glyph}</span>` : '');

/** Eval graph: White's winning chances over the game. `ws` has N+1 values (0..100), one per position. */
export function buildGraph(ws, ply, total) {
  if (ws.length < 2) return '';
  const W = 600, H = 86, n = Math.max(1, total ?? ws.length - 1);
  const X = i => (i / n) * W, Y = v => H - (v / 100) * H;
  const pts = ws.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
  const area = `M0,${H} L${pts.join(' L')} L${X(ws.length - 1)},${H} Z`;
  const cx = X(Math.min(ply, n));
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evaluation graph">
    <path d="${area}" fill="#f1f2fa"/>
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#8a8fb0" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
    <line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="#5865f2" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

export function buildSummary(R, ply) {
  const h = R.headers || {};
  const name = c => h[c] && h[c] !== '?' ? h[c] : (c === 'White' ? 'White' : 'Black');
  const elo = c => (h[c + 'Elo'] && h[c + 'Elo'] !== '?' ? ` <small>(${esc(h[c + 'Elo'])})</small>` : '');
  const sub = [h.Result && h.Result !== '*' ? h.Result : '', R.opening || h.Opening || '', h.Date && !h.Date.includes('?') ? h.Date.replace(/\./g, '-') : '', h.Site && /chess\.com|lichess/i.test(h.Site) ? h.Site : ''].filter(Boolean).map(esc).join(' · ');
  const rows = CLASS_ORDER.map(c => {
    const w = R.counts.w[c] || 0, b = R.counts.b[c] || 0;
    if (!w && !b && !['best', 'mistake', 'blunder'].includes(c)) return '';
    return `<tr><td><span class="cls-tag">${badge(c)}${CLASSES[c].label}</span></td><td class="${w ? '' : 'zero'}">${w}</td><td class="${b ? '' : 'zero'}">${b}</td></tr>`;
  }).join('');
  const bad = R.rows.some(r => ['mistake', 'blunder', 'miss'].includes(r.cls));
  return `
    <div class="rv-title"><b>${esc(name('White'))} vs ${esc(name('Black'))}</b><span>${sub || 'Game review'}</span></div>
    <div class="acc">
      <div><div class="who"><i></i>${esc(name('White'))}${elo('White')}</div><div class="n">${R.acc.w.toFixed(1)}<small>%</small></div></div>
      <div><div class="who"><i class="b"></i>${esc(name('Black'))}${elo('Black')}</div><div class="n">${R.acc.b.toFixed(1)}<small>%</small></div></div>
    </div>
    <div class="graph" id="rv-graph" title="Click to jump to a move">${buildGraph(R.ws.slice(0, R.rows.length + 1), ply, R.total)}</div>
    <table class="ctable"><tbody>${rows}</tbody></table>
    <div class="moments">
      <button class="btn" data-moment="-1" type="button" ${bad ? '' : 'disabled'}>‹ Previous mistake</button>
      <button class="btn" data-moment="1" type="button" ${bad ? '' : 'disabled'}>Next mistake ›</button>
    </div>`;
}

export function buildMoveCard({ row, ply, san, side, bestSan, evalAfter, evalBest, text, busy, err, canExplain, opening, pending }) {
  if (!row && pending) return `<div class="card-h"><h2>Move analysis</h2></div><div class="card-b"><div class="dots muted">Still analysing this move…</div></div>`;
  if (!row) {
    return `<div class="card-h"><h2>Move analysis</h2></div><div class="card-b"><div class="rm-top"><b>${ply === 0 ? 'Starting position' : 'Final position'}</b></div>
      <p class="muted small" style="margin:0">${opening ? esc(opening) + ' · ' : ''}Step through the game with ← → or click a point on the graph.</p></div>`;
  }
  const c = CLASSES[row.cls];
  const verdict = {
    brilliant: 'a brilliant move', great: 'a great move', best: 'the best move', excellent: 'an excellent move', good: 'a good move', book: 'a book move',
    inaccuracy: 'an inaccuracy', mistake: 'a mistake', miss: 'a missed chance', blunder: 'a blunder',
  }[row.cls];
  const fix = !row.isBest && bestSan && !['book', 'excellent', 'good'].includes(row.cls) ? `<div class="muted">Best was <b>${esc(bestSan)}</b>${evalBest ? ` (${esc(evalBest)})` : ''}.</div>` : '';
  return `<div class="card-h"><h2>Move analysis</h2><span class="muted small">${side === 'w' ? 'White' : 'Black'} · move ${Math.ceil(ply / 2)}</span></div>
    <div class="card-b">
      <div class="rm-top">${badge(row.cls).replace('class="badge"', 'class="badge"')}<b>${esc(san)} is ${verdict}</b></div>
      ${fix}
      <div class="rm-evals"><span>Eval after: <b>${esc(evalAfter)}</b></span><span>Accuracy: <b>${row.acc.toFixed(0)}%</b></span></div>
      ${text ? `<div class="txt" style="white-space:pre-wrap">${esc(text)}</div>` : busy ? '<div class="dots">The tutor is thinking…</div>' : err ? `<div class="err">${esc(err)}</div>` : ''}
      ${canExplain && !text && !busy ? '<button class="btn sm" data-explain type="button">Explain this move</button>' : ''}
    </div>`;
}
