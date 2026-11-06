// Practice lessons (Praeceptor). A small mixture-of-experts encoder reads what a mistake was about, or what you ask for
// in plain words, retrieves Lichess puzzles on that idea at your level, edits bystander pieces to make a fresh position
// (kept only if Stockfish still finds one clear best move and the encoder still reads the same idea), and tracks a
// rating per motif. Model + 16k-puzzle bank: public/lesson/praeceptor-v0.js, loaded on first use (≈2.3 MB gzipped).
import { Chess } from 'chess.js';
import { Engine } from './engine.js';
import { fetchProgress } from './net.js';

export const MOTIFS = {
  fork: ['Fork', 'One piece attacks two targets at once.'],
  pin: ['Pin', 'A piece cannot move without exposing something more valuable behind it.'],
  skewer: ['Skewer', 'Attack a valuable piece and win the one standing behind it.'],
  hangingPiece: ['Hanging piece', 'An undefended piece you can simply take, or must save.'],
  discoveredAttack: ['Discovered attack', 'Moving one piece unleashes an attack by another.'],
  discoveredCheck: ['Discovered check', 'Move a piece to reveal check from the one behind it.'],
  deflection: ['Deflection', 'Drag a defender away from the square or piece it guards.'],
  attraction: ['Attraction', 'Lure a piece, often the king, onto a fatal square.'],
  capturingDefender: ['Remove the defender', 'Capture the piece that guards your real target.'],
  clearance: ['Clearance', 'Move a piece out of the way to open a line or a square.'],
  intermezzo: ['In-between move', 'Insert a stronger move before the expected recapture.'],
  sacrifice: ['Sacrifice', 'Give up material to get something bigger back.'],
  quietMove: ['Quiet move', 'A calm move with no check or capture that sets up the win.'],
  defensiveMove: ['Defensive move', 'Find the one move that holds against the threat.'],
  trappedPiece: ['Trapped piece', 'A piece with no safe squares can be won.'],
  exposedKing: ['Exposed king', 'Attack a king that has lost its shelter.'],
  backRankMate: ['Back-rank mate', 'The king is boxed in behind its own pawns.'],
  attackingF2F7: ['Attacking f2 / f7', 'The weakest square next to an uncastled king.'],
  operaMate: ['Opera mate', 'Rook and bishop combine to mate on the back rank.'],
  pillsburysMate: ["Pillsbury's mate", 'Rook and bishop mate along the g- or h-file.'],
  advancedPawn: ['Advanced pawn', 'A pawn deep in enemy territory decides the game.'],
  promotion: ['Promotion', 'Push a pawn through to a new queen.'],
  zugzwang: ['Zugzwang', 'Every move the opponent has makes things worse.'],
};
const nameOf = k => MOTIFS[k]?.[0] || k;
const SET_SIZE = 5, SEEN_MAX = 300, K_ELO = 32;

// ---------- storage: per-motif Elo + recently seen puzzles ----------
const ls = { get(k, d) { try { const v = localStorage.getItem('augur:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('augur:' + k, JSON.stringify(v)); } catch { /* private mode */ } } };
const elo = () => ls.get('lessonElo', { base: 1200, r: {} });
const ratingOf = k => { const e = elo(); return Math.round(e.r[k] ?? e.base); };
function updateElo(motifs, rho, o) {
  const e = elo(), out = {};
  for (const k of motifs) {
    if (!MOTIFS[k]) continue;
    const r = e.r[k] ?? e.base, exp = 1 / (1 + 10 ** ((rho - r) / 400));
    e.r[k] = r + K_ELO * (o - exp); out[k] = Math.round(e.r[k] - r);
  }
  ls.set('lessonElo', e); return out;
}

// ---------- model + engine (lazy) ----------
let model = null, loading = null, dl = null;   // dl: download progress 0..1 while the model is fetched
const MODEL_BYTES = 4331618;
/** Fetch the self-contained module once with progress, then import it from memory (no second request). */
function loadModel() {
  loading ??= (async () => {
    dl = 0; render();
    const blob = await fetchProgress(new URL('./lesson/praeceptor-v0.js', document.baseURI).href, (got, tot) => { dl = got / tot; paintDl(); }, MODEL_BYTES, true);
    const url = URL.createObjectURL(new Blob([blob], { type: 'text/javascript' }));
    try { const m = await import(/* @vite-ignore */ url); model = m.default.load(); } finally { URL.revokeObjectURL(url); }
    dl = null; render(); return model;
  })().catch(e => { loading = null; dl = null; render(); throw e; });
  return loading;
}
/** Practice tab opened: start the download so the first lesson is ready sooner. */
export function preloadLessons() { if (!model) loadModel().catch(() => {}); }
function paintDl() {
  const bar = document.querySelector('#ls-dl i'), txt = document.querySelector('#ls-dl small');
  if (!bar) return;
  bar.style.width = Math.round((dl || 0) * 100) + '%'; txt.textContent = `Downloading the lesson model · ${Math.round((dl || 0) * 100)}% of ${(MODEL_BYTES / 1048576).toFixed(1)} MB (first time only)`;
}
let eng = null;
const engine = () => (eng && !eng.dead ? eng : (eng = new Engine({ multipv: 2, single: true })));
function freeEngine() { try { eng?.terminate(); } catch { /* gone */ } eng = null; }
/** One search: resolves {lines, best} or null when the engine is unusable. */
const search = (fen, go) => new Promise(res => engine().analyse(fen, go, (lines, done, best, failed) => { if (done) res(failed ? null : { lines, best }); }));
const scoreOf = l => (!l ? null : l.type === 'mate' ? (l.value > 0 ? 10000 - l.value : -10000 - l.value) : l.value);
const l2 = v => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, x => x / n); };
const add = (a, b, wb = 1) => Float32Array.from(a, (x, i) => x + wb * b[i]);

// ---------- verified mutation (paper, Algorithm 1) ----------
const FILES = 'abcdefgh';
const mirrorSq = sq => FILES[7 - FILES.indexOf(sq[0])] + sq[1];
const mirrorUci = u => mirrorSq(u.slice(0, 2)) + mirrorSq(u.slice(2, 4)) + u.slice(4);
const around = sq => { const f = FILES.indexOf(sq[0]), r = +sq[1], out = []; for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) { const ff = f + df, rr = r + dr; if (ff >= 0 && ff < 8 && rr >= 1 && rr <= 8) out.push(FILES[ff] + rr); } return out; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
/** Replay a UCI line; returns the playable prefix that ends on the solver's move (odd length). */
function playable(fen, line) {
  const g = new Chess(fen), ok = [];
  for (const u of line) { try { g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); ok.push(u); } catch { break; } }
  return ok.length % 2 ? ok : ok.slice(0, -1);
}
function legalStart(fen) {
  try {
    const g = new Chess(fen); if (g.isGameOver()) return false;
    const p = fen.split(' '); p[1] = p[1] === 'w' ? 'b' : 'w'; p[3] = '-';
    return !new Chess(p.join(' ')).inCheck();   // the side not to move must not be in check
  } catch { return false; }
}
function edits(fen, line) {
  const g = new Chess(fen), keep = new Set(), ops = [];
  for (const u of line) { for (const s of around(u.slice(0, 2))) keep.add(s); for (const s of around(u.slice(2, 4))) keep.add(s); }
  for (const row of g.board()) for (const p of row) if (p && p.type === 'k') around(p.square).forEach(s => keep.add(s));
  for (const row of g.board()) for (const p of row) {
    if (!p || p.type === 'k' || keep.has(p.square)) continue;
    ops.push({ kind: 'remove', sq: p.square });
    if (p.type === 'p') { const to = p.square[0] + (+p.square[1] + (p.color === 'w' ? 1 : -1)); if (/[2-7]$/.test(to) && !g.get(to) && !keep.has(to)) ops.push({ kind: 'shift', sq: p.square, to }); }
  }
  const f = fen.split(' ');
  if (f[2] === '-' && f[3] === '-') ops.push({ kind: 'mirror' });
  return shuffle(ops);
}
function applyEdit(fen, line, op) {
  if (op.kind === 'mirror') {
    const rows = fen.split(' ')[0].split('/').map(r => r.replace(/\d/g, d => '1'.repeat(+d)).split('').reverse().join('').replace(/1+/g, m => String(m.length)));
    const f = fen.split(' '); f[0] = rows.join('/');
    return { fen: f.join(' '), line: line.map(mirrorUci) };
  }
  const g = new Chess(fen), p = g.get(op.sq); g.remove(op.sq);
  if (op.kind === 'shift') g.put(p, op.to);
  const f = g.fen().split(' '); f[3] = '-';
  return { fen: f.join(' '), line };
}
async function mutate(item, tries = 4) {
  const line0 = item.s.split(' ');
  for (const op of edits(item.f, line0).slice(0, tries)) {
    let cand; try { cand = applyEdit(item.f, line0, op); } catch { continue; }
    if (!legalStart(cand.fen)) continue;
    const line = playable(cand.fen, cand.line); if (!line.length) continue;
    const r = await search(cand.fen, 'nodes 150000'); if (!r) return null;   // engine unusable: keep originals
    const [a, b] = r.lines, sa = scoreOf(a), sb = scoreOf(b);
    if (!a || a.pv[0] !== line[0] || (b && sa - sb < 150)) continue;
    const read = model.readPosition(cand.fen, line[0]);
    if (!item.m.includes(read.top[0][0])) continue;
    return { fen: cand.fen, line, mutated: true };
  }
  return null;
}

// ---------- session state ----------
const L = { work: null, run: 0, on: false, view: 'game', motif: null, items: [], i: 0, j: 0, failed: false, hinted: false, wrong: 0, done: false, results: [], msg: '', busy: '', scan: null, ask: null };
let ctx;
export const lessonActive = () => L.on;
export const lessonCanMove = () => L.on && !L.done && !L.busy && L.items[L.i] && L.j % 2 === 0;
export function lessonStatus() {
  if (!L.on) return '';
  if (L.busy) return L.busy;
  const it = L.items[L.i]; if (!it) return 'Lesson';
  if (L.done) return L.msg;
  const side = it.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  return L.msg || `${side} to move: find the best move`;
}
export function lessonArrows() {
  const it = L.items[L.i];
  if (!L.on || !it || !L.hinted || L.done) return [];
  const u = it.line[L.j]; return u ? [{ from: u.slice(0, 2), to: u.slice(2, 4), color: '#8fb2f0', width: 13 }] : [];
}
const seen = () => ls.get('lessonSeen', []);
function markSeen(id) { const s = seen().filter(x => x !== id); s.push(id); ls.set('lessonSeen', s.slice(-SEEN_MAX)); }

// ---------- 1) lessons from your own game ----------
async function scanGame() {
  if (L.work) return;   // the scan and a practice set share one Stockfish worker
  L.work = 'scan';
  try { await scanGameInner(); } finally { L.work = null; render(); }
}
async function scanGameInner() {
  const { moves, base, human } = ctx.gameInfo();
  if (moves.length < 4) { L.scan = { error: 'Play a few moves against the bot first (or open a game from History), then come back to find what to practise.' }; render(); return; }
  L.scan = { progress: 0 }; render();
  try { await loadModel(); } catch { L.scan = { error: 'The lesson model could not be loaded. Check your connection and try again.' }; render(); return; }
  const fens = [base, ...moves.map(m => m.fen)].slice(-81), off = Math.max(0, moves.length + 1 - fens.length);
  const ev = [];
  for (let i = 0; i < fens.length; i++) {
    const g = new Chess(fens[i]);
    if (g.isCheckmate()) ev.push({ cp: -10000, best: null }); else if (g.isGameOver()) ev.push({ cp: 0, best: null });
    else { const r = await search(fens[i], 350); if (!r) { L.scan = { error: 'Stockfish could not start on this device.' }; freeEngine(); render(); return; } ev.push({ cp: scoreOf(r.lines[0]) ?? 0, best: r.lines[0]?.pv[0] || r.best }); }
    L.scan.progress = (i + 1) / fens.length; render();
  }
  freeEngine();
  const W = i => Math.max(-1500, Math.min(1500, ev[i].cp * (fens[i].split(' ')[1] === 'w' ? 1 : -1)));   // white's view
  const found = [], agg = new Float32Array(model.labels().length); let z = new Float32Array(64), wsum = 0;
  for (let i = 0; i + 1 < fens.length; i++) {
    const mover = fens[i].split(' ')[1], sgn = mover === 'w' ? 1 : -1;
    if (human && mover !== human) continue;
    const before = W(i) * sgn, after = W(i + 1) * sgn, drop = before - after;
    if (drop < 150 || before <= -400 || !ev[i + 1].best) continue;
    const r = model.readPosition(fens[i + 1], ev[i + 1].best), w = Math.min(drop, 600) / 600;
    r.probs.forEach((p, k) => { agg[k] += w * p; }); z = add(z, r.emb, w); wsum += w;
    const ply = off + i, mv = moves[ply];
    found.push({ ply, san: mv.san, num: Math.floor(ply / 2) + 1, black: mover === 'b', drop, top: r.top[0][0] });
  }
  if (!found.length) { L.scan = { none: true }; render(); return; }
  const labels = model.labels(), order = [...agg.keys()].sort((a, b) => agg[b] - agg[a]).slice(0, 3);
  L.scan = { found, emb: l2(z), lessons: order.map(k => ({ k: labels[k], score: agg[k] / wsum, n: found.filter(f => f.top === labels[k]).length })) };
  render();
}

// ---------- 2) lessons from a typed request ----------
async function askText(text) {
  if (!text.trim()) return;
  L.ask = { busy: true, text }; render();
  try { await loadModel(); } catch { L.ask = { error: 'The lesson model could not be loaded.', text }; render(); return; }
  const r = model.readText(text), labels = model.labels();
  const order = [...r.probs.keys()].sort((a, b) => r.probs[b] - r.probs[a]).slice(0, 3);
  L.ask = { text, emb: r.emb, lessons: order.map(k => ({ k: labels[k], p: r.probs[k] })) };
  render();
}

// ---------- practice session ----------
async function startPractice(k, emb) {
  if (L.on || L.work) return;
  const run = ++L.run; L.work = 'build';
  L.busy = 'Loading the lesson model…'; render();
  try { await loadModel(); } catch { L.busy = ''; L.work = null; ctx.toast('The lesson model could not be loaded'); render(); return; }
  if (run !== L.run) return;
  const q = l2(emb ? add(emb, model.anchor(k)) : model.anchor(k)), rk = ratingOf(k), skip = new Set(seen());
  let pool = [];
  for (const [lo, hi] of [[rk - 100, rk + 200], [rk - 300, rk + 400], [0, 4000]]) {
    pool = model.retrieve(q, lo, hi, 300).filter(x => !skip.has(x.i));
    if (pool.length >= SET_SIZE * 2) break;
  }
  pool.sort((a, b) => (b.m.includes(k) - a.m.includes(k)) || (b.sim - a.sim));
  const picks = pool.slice(0, SET_SIZE);
  if (!picks.length) { L.busy = ''; L.work = null; ctx.toast('No puzzles found for that lesson'); render(); return; }
  Object.assign(L, { on: true, motif: k, items: [], i: 0, results: [], snap: ctx.snapshot() });
  ctx.onStart();
  for (let n = 0; n < picks.length; n++) {
    L.busy = `Building fresh positions… ${n + 1} / ${picks.length}`; render(); ctx.refresh();
    const it = picks[n], m = await mutate(it).catch(() => null);
    if (!L.on || run !== L.run) return;   // left while building
    L.items.push({ id: it.i, rating: it.r, motifs: it.m, ...(m || { fen: it.f, line: playable(it.f, it.s.split(' ')), mutated: false }) });
  }
  freeEngine();
  L.work = null; L.busy = ''; showPuzzle(0);
}
function showPuzzle(i) {
  Object.assign(L, { i, j: 0, failed: false, hinted: false, wrong: 0, done: false, msg: '' });
  const it = L.items[i]; ctx.showPosition(it.fen);
  render();
}
/** Board move while practising: right moves continue the line, wrong ones are refused. */
export function lessonMove(from, to, promotion) {
  const it = L.items[L.i]; if (!lessonCanMove()) return false;
  const want = it.line[L.j], uci = from + to + (promotion || '');
  const g = new Chess(ctx.currentFen());
  let mates = false; try { const mv = g.move({ from, to, promotion: promotion || 'q' }); mates = g.isCheckmate(); if (!mv) return false; } catch { return false; }
  const right = uci === want || (from + to === want.slice(0, 4) && (!want[4] || (promotion || 'q') === want[4])) || mates;
  if (!right) {
    L.failed = true; L.wrong++; L.msg = L.wrong >= 2 ? 'Not that one. The hint arrow shows the move.' : 'Not that one, try again';
    if (L.wrong >= 2) L.hinted = true;
    render(); ctx.refresh(); return false;
  }
  ctx.pushMove(from, to, promotion || (want[4] || undefined));
  L.j++; L.msg = 'Good, keep going';
  if (mates || L.j >= it.line.length) { finishPuzzle(); return true; }
  render(); ctx.refresh();
  setTimeout(() => {   // the opponent's reply from the solution line
    if (!L.on || L.items[L.i] !== it) return;
    const u = it.line[L.j]; ctx.pushMove(u.slice(0, 2), u.slice(2, 4), u[4]); L.j++;
    if (L.j >= it.line.length) finishPuzzle(); else { L.msg = 'Your move'; render(); ctx.refresh(); }
  }, 420);
  return true;
}
function finishPuzzle() {
  const it = L.items[L.i], o = L.failed || L.hinted ? 0 : 1, delta = updateElo(it.motifs, it.rating, o);
  markSeen(it.id);
  L.results.push({ o, delta, motifs: it.motifs });
  const d = delta[L.motif] ?? Object.values(delta)[0] ?? 0;
  L.done = true; L.msg = o ? `Solved! ${d >= 0 ? '+' : ''}${d} ${nameOf(L.motif)}` : `Solved with help · ${d >= 0 ? '+' : ''}${d}`;
  render(); ctx.refresh();
}
function skipPuzzle() {
  const it = L.items[L.i]; if (!it || L.done) return;
  L.failed = true; L.hinted = true;
  const d = updateElo(it.motifs, it.rating, 0); markSeen(it.id);
  L.results.push({ o: 0, delta: d, motifs: it.motifs, skipped: true });
  L.done = true; L.msg = 'Skipped'; render(); ctx.refresh();
}
function next() { if (L.i + 1 < L.items.length) showPuzzle(L.i + 1); else { L.i = L.items.length; L.done = true; L.msg = 'Lesson complete'; render(); ctx.refresh(); } }
export function endLesson() {
  if (!L.on) { if (L.work === 'build') { L.run++; L.work = null; L.busy = ''; render(); } return; }   // still loading: cancel it
  const snap = L.snap; L.run++; Object.assign(L, { work: null, on: false, items: [], i: 0, j: 0, busy: '', msg: '', done: false, snap: null });
  freeEngine(); ctx.restore(snap); render();
}

// ---------- UI ----------
const pct = x => Math.round(x * 100) + '%';
function render() {
  const el = document.querySelector('#lessons-body'); if (!el || !ctx) return;
  const esc = ctx.esc;
  if (L.on) { el.innerHTML = renderSession(esc); return; }
  const dlBar = dl !== null ? `<div class="ls-dl" id="ls-dl"><small></small><div class="ls-prog"><i style="width:${Math.round(dl * 100)}%"></i></div></div>` : '';
  if (L.busy) { el.innerHTML = dlBar + `<div class="ls-busy"><span class="spin"></span>${esc(L.busy)}</div>`; if (dlBar) paintDl(); return; }
  const tab = b => `<button type="button" role="radio" data-lv="${b}" aria-checked="${L.view === b}">${{ game: 'From my game', ask: 'Ask', themes: 'Themes' }[b]}</button>`;
  let body = '';
  if (L.view === 'game') {
    const s = L.scan;
    body = `<p class="muted small">Stockfish finds the moves that cost you the most, and the lesson model reads what each one was about.</p>`;
    if (!s) body += `<button class="primary" data-act="scan" type="button">Find my lessons in this game</button>`;
    else if (s.error) body += `<p class="note">${esc(s.error)}</p><button class="btn" data-act="scan" type="button">Try again</button>`;
    else if (s.progress !== undefined && !s.lessons) body += `<div class="ls-prog"><i style="width:${pct(s.progress)}"></i></div><p class="muted small">Analysing your moves… ${pct(s.progress)}</p>`;
    else if (s.none) body += `<p class="note">No clear mistakes (150 cp or more) in your moves. Nice! Pick a theme or ask for one instead.</p><button class="btn" data-act="scan" type="button">Scan again</button>`;
    else {
      body += `<div class="ls-list">${s.lessons.map(x => lessonRow(x.k, `${x.n ? `${x.n} mistake${x.n > 1 ? 's' : ''}` : 'related idea'} · rating ${ratingOf(x.k)}`, 'game')).join('')}</div>`;
      body += `<details class="ls-mist"><summary>${s.found.length} mistake${s.found.length > 1 ? 's' : ''} found</summary><ul>${s.found.map(f => `<li><b>${f.num}${f.black ? '…' : '.'} ${esc(f.san)}</b><span>−${(f.drop / 100).toFixed(1)}</span><em>${esc(nameOf(f.top))}</em></li>`).join('')}</ul></details>`;
      body += `<button class="btn sm" data-act="scan" type="button">Scan again</button>`;
    }
  } else if (L.view === 'ask') {
    const a = L.ask;
    body = `<p class="muted small">Describe what keeps going wrong, in your own words.</p>
      <form class="ls-ask" data-act="ask"><input id="ls-q" type="text" placeholder="e.g. I keep missing forks" value="${esc(a?.text || '')}" autocomplete="off" /><button class="btn" type="submit">Find</button></form>`;
    if (a?.busy) body += `<p class="muted small">Reading…</p>`;
    else if (a?.error) body += `<p class="note">${esc(a.error)}</p>`;
    else if (a?.lessons) body += `<div class="ls-list">${a.lessons.map(x => lessonRow(x.k, `match ${pct(x.p)} · rating ${ratingOf(x.k)}`, 'ask')).join('')}</div>`;
  } else {
    body = `<p class="muted small">Pick an idea to drill. The number is your rating for it, and puzzles are chosen just above it.</p>
      <div class="ls-grid">${Object.keys(MOTIFS).map(k => `<button type="button" class="ls-tile" data-practise="${k}" data-src="theme" title="${esc(MOTIFS[k][1])}"><b>${esc(nameOf(k))}</b><span>${ratingOf(k)}</span></button>`).join('')}</div>`;
  }
  const base = elo().base;
  el.innerHTML = dlBar + `<div class="seg ls-tabs" role="radiogroup" aria-label="Lesson source">${['game', 'ask', 'themes'].map(tab).join('')}</div>${body}
    <div class="ls-foot"><span class="muted small">Starting rating</span><div class="seg" role="radiogroup" aria-label="Starting rating">${[800, 1200, 1600, 2000].map(v => `<button type="button" role="radio" data-base="${v}" aria-checked="${base === v}">${v}</button>`).join('')}</div></div>`;
  if (dlBar) paintDl();
  function lessonRow(k, sub, src) {
    return `<div class="ls-row"><div><b>${esc(nameOf(k))}</b><small>${esc(MOTIFS[k]?.[1] || '')}</small><em>${esc(sub)}</em></div><button class="btn sm" type="button" data-practise="${k}" data-src="${src}">Practise</button></div>`;
  }
}
function renderSession(esc) {
  const k = L.motif, it = L.items[L.i], total = L.items.length || SET_SIZE;
  const dots = Array.from({ length: total }, (_, n) => `<i class="${n < L.results.length ? (L.results[n].o ? 'ok' : 'miss') : n === L.i ? 'cur' : ''}"></i>`).join('');
  if (L.busy || !it) {
    if (!L.busy && L.results.length) {   // finished set
      const solved = L.results.filter(r => r.o).length, d = L.results.reduce((a, r) => a + (r.delta[k] || 0), 0);
      return `<div class="ls-head"><span class="kicker">${esc(nameOf(k))}</span><div class="ls-dots">${dots}</div></div>
        <div class="ls-sum"><b>${solved} / ${L.results.length}</b><span>solved first try</span></div>
        <p class="muted small">${esc(nameOf(k))} rating ${ratingOf(k)} (${d >= 0 ? '+' : ''}${d} this set).</p>
        <div class="ls-actions"><button class="primary" data-act="again" type="button">Practise again</button><button class="btn" data-act="exit" type="button">Back to my game</button></div>`;
    }
    return `<div class="ls-head"><span class="kicker">${esc(nameOf(k))}</span></div><div class="ls-busy"><span class="spin"></span>${esc(L.busy || 'Preparing…')}</div>
      <div class="ls-actions"><button class="btn" data-act="exit" type="button">Cancel</button></div>`;
  }
  const side = it.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  return `<div class="ls-head"><span class="kicker">${esc(nameOf(k))}</span><div class="ls-dots">${dots}</div></div>
    <div class="ls-meta"><span>Puzzle ${L.i + 1} of ${total}</span><span>rated ${it.rating}</span>${it.mutated ? '<span class="ls-fresh" title="Edited from a real puzzle and verified by Stockfish">fresh position</span>' : ''}</div>
    <p class="ls-status ${L.done ? (L.results[L.results.length - 1]?.o ? 'ok' : 'miss') : L.failed ? 'miss' : ''}">${esc(L.done ? L.msg : L.msg || `${side} to move. Find the best move.`)}</p>
    <p class="callout">${esc(MOTIFS[k]?.[1] || '')}</p>
    <div class="ls-actions">${L.done ? `<button class="primary" data-act="next" type="button">${L.i + 1 < total ? 'Next puzzle' : 'See results'}</button>` : `<button class="btn" data-act="hint" type="button">Hint</button><button class="btn" data-act="skip" type="button">Skip</button>`}<button class="btn" data-act="exit" type="button">Exit</button></div>`;
}
function onClick(e) {
  const t = e.target.closest('button'); if (!t) return;
  if (L.work && (t.dataset.practise || t.dataset.act === 'scan')) { ctx.toast('One moment, still analysing'); return; }
  if (t.dataset.lv) { L.view = t.dataset.lv; render(); return; }
  if (t.dataset.base) { const e2 = elo(); e2.base = +t.dataset.base; ls.set('lessonElo', e2); render(); return; }
  if (t.dataset.practise) { const src = t.dataset.src; startPractice(t.dataset.practise, src === 'game' ? L.scan?.emb : src === 'ask' ? L.ask?.emb : null); return; }
  const a = t.dataset.act;
  if (a === 'scan') scanGame();
  else if (a === 'hint') { L.hinted = true; L.msg = 'Hint: follow the arrow'; render(); ctx.refresh(); }
  else if (a === 'skip') skipPuzzle();
  else if (a === 'next') next();
  else if (a === 'exit') endLesson();
  else if (a === 'again') { const k = L.motif; endLesson(); startPractice(k, null); }
}
export function initLessons(c) {
  ctx = c;
  const el = document.querySelector('#lessons-body');
  el.addEventListener('click', onClick);
  el.addEventListener('submit', e => { e.preventDefault(); askText(el.querySelector('#ls-q').value); });
  render();
}
export const renderLessons = () => render();
