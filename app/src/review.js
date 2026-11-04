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
  return `
    <div class="rv-title"><b>${esc(name('White'))} vs ${esc(name('Black'))}</b><span>${sub || 'Game review'}</span></div>
    <div class="acc">
      <div><div class="who"><i></i>${esc(name('White'))}${elo('White')}</div><div class="n">${R.acc.w.toFixed(1)}<small>%</small></div></div>
      <div><div class="who"><i class="b"></i>${esc(name('Black'))}${elo('Black')}</div><div class="n">${R.acc.b.toFixed(1)}<small>%</small></div></div>
    </div>
    <div class="graph" id="rv-graph" title="Click to jump to a move">${buildGraph(R.ws.slice(0, R.rows.length + 1), ply, R.total)}</div>
    <table class="ctable"><tbody>${rows}</tbody></table>
    ${phaseTable(R)}
    ${R.info ? `<details class="prov"><summary>How was this produced?</summary><ul>
      <li>Stockfish 19 lite (WebAssembly) running in your browser; nothing is uploaded.</li>
      <li>Search: ${esc(R.info.label)}, top 2 lines per position, ${R.info.workers} worker${R.info.workers > 1 ? 's' : ''}.</li>
      <li>Timing: quick pass ${(R.info.quickMs / 1000).toFixed(1)}s${R.info.refineMs != null ? `, refinement ${(R.info.refineMs / 1000).toFixed(1)}s` : R.phase === 'refine' ? ', refining…' : ''}.</li>
      <li>Grades come from the drop in winning chances (Lichess win-probability model); accuracy uses the Lichess accuracy formula.</li>
      <li>Explanations without an API key are templates built only from these engine numbers.</li>
    </ul></details>` : ''}`;
}

function phaseTable(R) {
  const P = ['opening', 'middlegame', 'endgame'], cell = (side, ph) => {
    const rs = R.rows.filter(r => r.side === side && r.phase === ph);
    return rs.length ? (rs.reduce((a, r) => a + r.acc, 0) / rs.length).toFixed(0) + '%' : '·';
  };
  if (!R.rows.some(r => r.phase)) return '';
  return `<table class="ctable phase"><tbody><tr><td class="muted">Accuracy by phase</td><td>White</td><td>Black</td></tr>${P.map(ph => `<tr><td>${ph[0].toUpperCase() + ph.slice(1)}</td><td>${cell('w', ph)}</td><td>${cell('b', ph)}</td></tr>`).join('')}</tbody></table>`;
}

const GLYPH = { brilliant: '!!', great: '!', inaccuracy: '?!', mistake: '?', miss: '?', blunder: '??' };
/** "18... Qxd4??" style title for move index i (0-based) of a game starting from `baseFen`. */
export function moveTitle(san, i, baseFen, cls) {
  const f = baseFen.split(' '), blackFirst = f[1] === 'b', full = +f[5] || 1;
  const k = i + (blackFirst ? 1 : 0), num = full + Math.floor(k / 2), black = k % 2 === 1;
  return `${num}${black ? '...' : '.'} ${san}${GLYPH[cls] || ''}`;
}
/** The focused move card used by the tutor and the review. */
export function lessonCard({ kicker, meta, title, cls, chips, body, tip, footer }) {
  const c = CLASSES[cls];
  return `<div class="lesson" style="--c:${c?.color || 'var(--accent)'}">
    <div class="lesson-head"><div><span class="kicker">${esc(kicker)}</span><div class="lesson-title">${esc(title)}</div></div>${meta ? `<span class="muted small">${meta}</span>` : ''}</div>
    ${c || chips ? `<div class="pills">${c ? `<span class="pill" style="color:${c.color}">${c.label}</span>` : ''}${chips || ''}</div>` : ''}
    ${body ? `<div class="callout">${body}</div>` : ''}
    ${tip ? `<div class="tipbox"><svg class="ic"><use href="#i-bulb"/></svg><span>${tip}</span></div>` : ''}
    ${footer || ''}
  </div>`;
}

/** Review move card: fixed height, scrolling body, and a footer pinned at the bottom so nothing shifts while stepping. */
export function buildMoveCard({ row, ply, title, evalAfter, text, busy, err, canExplain, template, tip, chips, opening, pending, custom, best = '', exploring }) {
  const nav = `<div class="rm-nav${exploring ? ' three' : ''}"><button class="btn sm" data-moment="-1" type="button">‹ Prev mistake</button>${exploring ? '<button class="btn sm back" data-reset-line type="button">↺ Back to game</button>' : ''}<button class="btn sm" data-moment="1" type="button">Next mistake ›</button></div>`;
  const frame = (lesson, extra = '') => `<div class="card-b rm-body"><div class="rm-scroll">${lesson}</div><div class="rm-foot">${best}${extra}${nav}</div></div>`;
  if (custom) return frame(lessonCard(custom));
  if (!row && pending) return frame(lessonCard({ kicker: 'Move analysis', title: title || '', body: '<span class="dots">Still analysing this move…</span>' }));
  if (!row) {
    return frame(lessonCard({ kicker: 'Move analysis', title: ply === 0 ? 'Starting position' : 'Final position', body: `${opening ? `<b>${esc(opening)}</b>. ` : ''}Step through the game with ← → or click a point on the graph or a move in the list. Drag a piece at any step to try your own line.` }));
  }
  const body = text ? esc(text) : busy ? `<span class="dots">The tutor is thinking…</span>` : `${err ? `<div class="err">${esc(err)}</div>` : ''}${esc(template || '')}`;
  const facts = `<div class="lesson-actions"><span class="rm-evals"><span>Eval after <b>${esc(evalAfter)}</b></span><span>Accuracy <b>${row.acc.toFixed(0)}%</b></span></span>${canExplain && !text && !busy ? '<button class="btn sm" data-explain type="button">Explain with AI</button>' : ''}</div>`;
  return frame(lessonCard({ kicker: `Move analysis · ${row.side === 'w' ? 'White' : 'Black'}`, title, cls: row.cls, chips, body, tip }), facts);
}
