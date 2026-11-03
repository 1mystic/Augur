import '@fontsource-variable/outfit';
import '@fontsource-variable/jetbrains-mono';
import { Chess } from 'chess.js';
import { Board, pieceSrc } from './board.js';
import { Engine } from './engine.js';
import { pickMove } from './minibot.js';
import { detectMotifs } from './motifs.js';
import { detectBoard, fallbackBox } from './vision/detect.js';
import { loadModel, classifyBoard, guessFlipped, gridToPlacement } from './vision/classify.js';
import { summarise, terminalEval, judge, fmtWhite, whiteWin, openingName, inBook, CLASSES } from './coach.js';
import { PROVIDERS, loadLLM, saveLLM, clearLLM, llmReady, ask, TUTOR_SYSTEM } from './llm.js';
import { esc, badge, buildSummary, buildMoveCard, lessonCard, moveTitle } from './review.js';

const $ = s => document.querySelector(s);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const START_FEN = START + ' w KQkq - 0 1';
const COLORS = ['var(--a1)', 'var(--a2)', 'var(--a3)'];
const RAW = ['#6f86ff', '#4fbf8f', '#f08a6c'];
const store = { get(k, d) { try { const v = localStorage.getItem('augur:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('augur:' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

const PREF_DEFAULTS = { lines: 3, coords: true, dots: true, evalbar: true, anim: true, autoq: false, who: 'all', level: 'intermediate' };
const P = { ...PREF_DEFAULTS, ...store.get('prefs', {}) };
const S = {
  img: null, box: null, grid: null,
  orient: 'w', turn: 'w', castle: 'KQkq', placement: START,
  base: null, valid: true, moves: [], ply: 0,
  edit: false, tool: null, lines: [], uncertain: new Set(),
  mode: store.get('mode', 'analysis'), time: store.get('time', 0), hints: store.get('hints', false),
  bot: { level: store.get('level', 'intermediate'), human: store.get('human', 'w') },
};
const MODES = {
  get analysis() { return `Scan a position, explore lines and ask Stockfish for ${P.lines === 1 ? 'the best move' : `the top ${P.lines} moves`}.`; },
  pvp: 'Two players, one board. Moves alternate; Stockfish can give a single hint if you allow it.',
  bot: 'Play against Stockfish. Pick a difficulty and your colour.',
  tutor: 'Play the bot while a tutor explains every move in plain English, yours and the bot\'s.',
  review: 'Paste a finished game (PGN from chess.com, lichess…) for a full move-by-move review.',
};
// per-mode extras
const T = { entries: [], gen: 0 };                                   // tutor feed
const R = { status: 'idle', run: 0, rows: [], evals: [], ws: [], counts: { w: {}, b: {} }, acc: { w: 0, b: 0 }, headers: {}, opening: null, speed: ['fast', 'std', 'deep'].includes(store.get('speed')) ? store.get('speed') : 'std' };
// depth-limited (not time-limited): easy positions finish in a few ms, so reviews are quick; movetime is only a safety cap
// Two passes, the same trick fast review sites use: a shallow pass gives the whole review almost at once,
// then a deeper pass refines it in the background. Depth limits plus an early exit keep easy positions cheap.
const QUICK = 'depth 9';
const SPEEDS = {
  fast: { go: null, early: null, label: 'depth 9' },
  std: { go: 'depth 14 movetime 2000', early: { min: 10, n: 3, tol: 10 }, label: 'depth 9, refined to 14' },
  deep: { go: 'depth 18 movetime 4000', early: { min: 13, n: 4, tol: 8 }, label: 'depth 9, refined to 18' },
};
// chess clock (Player vs Player and Play the bot): starts after the first move, flag falls = loss on time
const C = { w: 0, b: 0, running: null, last: 0, flag: null };
const timed = () => (S.mode === 'pvp' || S.mode === 'bot') && S.time > 0;
const vsBot = () => S.mode === 'bot' || S.mode === 'tutor';
const LEVELS = {
  easy: { label: 'Easy', desc: 'Makes plenty of mistakes, good for learning (~1000).', opts: { UCI_LimitStrength: false, 'Skill Level': 1 }, go: 'depth 4 movetime 120' },
  intermediate: { label: 'Intermediate', desc: 'Solid club player, still beatable (~1700).', opts: { 'Skill Level': 20, UCI_LimitStrength: true, UCI_Elo: 1700 }, go: 'depth 10 movetime 300' },
  expert: { label: 'Expert', desc: 'Full-strength Stockfish. Good luck.', opts: { UCI_LimitStrength: false, 'Skill Level': 20 }, go: 'depth 14 movetime 700' },
};

// ---------- helpers ----------
function toast(msg, ms = 2200) {
  const t = $('#toast');
  // an open modal dialog sits in the browser's top layer, above any z-index: show the toast inside it so it stays visible
  const host = document.querySelector('dialog[open]') || document.body;
  if (t.parentElement !== host) host.appendChild(t);
  t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function parsePlacement(pl) {
  const map = {}; pl.split('/').forEach((row, i) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else { map['abcdefgh'[f] + (8 - i)] = ch; f++; } } });
  return map;
}
function mapToPlacement(map) {
  const rows = [];
  for (let r = 8; r >= 1; r--) { let s = '', e = 0; for (const f of 'abcdefgh') { const p = map[f + r]; if (!p) e++; else { if (e) s += e; e = 0; s += p; } } if (e) s += e; rows.push(s); }
  return rows.join('/');
}
function sanitizeCastle(map, c) {
  let out = '';
  if (map.e1 === 'K') { if (c.includes('K') && map.h1 === 'R') out += 'K'; if (c.includes('Q') && map.a1 === 'R') out += 'Q'; }
  if (map.e8 === 'k') { if (c.includes('k') && map.h8 === 'r') out += 'k'; if (c.includes('q') && map.a8 === 'r') out += 'q'; }
  return out || '-';
}
const curFen = () => (S.ply === 0 ? S.base : S.moves[S.ply - 1].fen);
const game = () => new Chess(curFen());

function checkPosition(fen) {
  const map = parsePlacement(fen.split(' ')[0]), v = Object.values(map);
  const cnt = p => v.filter(x => x === p).length;
  if (cnt('K') !== 1 || cnt('k') !== 1) return `Need exactly one king each (found ${cnt('K')} white, ${cnt('k')} black).`;
  if (Object.entries(map).some(([sq, p]) => 'Pp'.includes(p) && '18'.includes(sq[1]))) return 'Pawns on the first/last rank.';
  try { new Chess(fen); } catch (e) { return String(e.message || e); }
  const parts = fen.split(' '); parts[1] = parts[1] === 'w' ? 'b' : 'w'; parts[3] = '-';
  try { if (new Chess(parts.join(' ')).inCheck()) return `${parts[1] === 'w' ? 'White' : 'Black'} is in check but it's not their move, flip "To move"?`; } catch { /* ignore */ }
  return null;
}

// ---------- position / history ----------
function rebuildBase({ keepHistory = false } = {}) {
  const map = parsePlacement(S.placement);
  const castle = sanitizeCastle(map, S.castle);
  S.base = `${S.placement} ${S.turn} ${castle} - 0 1`;
  const err = checkPosition(S.base);
  S.valid = !err;
  $('#warn').textContent = err || ''; $('#warn').classList.toggle('hidden', !err);
  if (!keepHistory) { S.moves = []; S.ply = 0; T.entries = []; T.gen++; clockReset(); }
  S.lines = [];
  refresh();
  if (S.valid && autoOn() && !S.edit) analyse();
}

let batching = false;
function play(from, to, promotion, byBot = false) {
  if (S.mode === 'review') return false;
  if (vsBot() && !byBot && !batching && curFen().split(' ')[1] !== S.bot.human) return false;
  clockCharge();
  const g = game();
  let mv;
  try { mv = g.move({ from, to, promotion }); } catch { return false; }
  S.moves = S.moves.slice(0, S.ply);
  S.moves.push({ san: mv.san, from, to, promotion: mv.promotion, fen: g.fen() });
  T.entries.length = Math.min(T.entries.length, S.ply);
  if (S.mode === 'tutor' && !batching) { const idx = S.moves.length - 1; queueMicrotask(() => coachMove(idx)); }
  S.ply++; S.lines = []; S.uncertain = new Set();
  if (!batching) clockSync();
  if (batching) return true;
  refresh();
  if (autoOn()) analyse(); else stopEngine();
  return true;
}
function goto(ply) { if (S.mode === 'review') R.follow = false; S.ply = Math.max(0, Math.min(S.moves.length, ply)); S.lines = []; refresh(); if (autoOn()) analyse(); }
const autoOn = () => S.mode === 'analysis' && $('#auto').checked;
/** Engine lines that the current mode lets the player see. */
const shown = () => (S.mode === 'analysis' ? S.lines.slice(0, P.lines) : S.mode === 'pvp' && S.hints ? S.lines.slice(0, 1) : []);
const humanCanMove = () => S.mode === 'review' || C.flag || (timed() && S.ply !== S.moves.length) ? false : !vsBot() || curFen().split(' ')[1] === S.bot.human;

// ---------- rendering ----------
let board;
function refresh() {
  const fen = curFen(), g = S.valid ? new Chess(fen) : null;
  const pieces = parsePlacement(fen.split(' ')[0]);
  const turn = fen.split(' ')[1];
  const last = S.ply ? S.moves[S.ply - 1] : null;
  let check = null;
  if (g && g.inCheck()) check = Object.keys(pieces).find(sq => pieces[sq] === (turn === 'w' ? 'K' : 'k'));
  board.set({
    pieces, orientation: S.orient, edit: S.edit, lastMove: last, check, uncertain: S.ply === 0 ? S.uncertain : new Set(),
    legal: sq => (g && !S.edit && humanCanMove() ? g.moves({ square: sq, verbose: true }) : []),
    badge: plyBadge(),
    arrows: S.mode === 'review' ? reviewView() : shown().map((l, i) => ({ from: l.pv[0].slice(0, 2), to: l.pv[0].slice(2, 4), color: RAW[i], width: [15, 11, 8][i], label: String(i + 1) })),
  });
  // turn
  const t = $('#turn'); t.classList.toggle('b', turn === 'b');
  const winner = turn === 'w' ? 'Black' : 'White';
  let status = `${turn === 'w' ? 'White' : 'Black'} to move`;
  if (g && g.isCheckmate()) status = vsBot() ? (winner === (S.bot.human === 'w' ? 'White' : 'Black') ? 'Checkmate, you win!' : 'Checkmate, the bot wins') : `Checkmate, ${winner} wins`;
  else if (g && g.isStalemate()) status = 'Stalemate, draw';
  else if (g && g.isDraw()) status = 'Draw';
  else if (!S.valid) status = 'Position needs fixing';
  else if (S.mode === 'review') status = S.ply ? `After move ${Math.ceil(S.ply / 2)}${S.ply % 2 ? '' : '…'}` : 'Starting position';
  else if (vsBot()) status = S.ply !== S.moves.length ? 'Viewing an earlier move' : humanCanMove() ? 'Your move' : 'Bot is thinking…';
  if (C.flag) status = vsBot() ? (C.flag === S.bot.human ? 'Time out, the bot wins' : 'Time out, you win!') : `Time out, ${C.flag === 'w' ? 'Black' : 'White'} wins`;
  t.querySelector('span').textContent = status;
  t.classList.toggle('over', (!!g && g.isGameOver()) || !!C.flag);
  if (g && g.isGameOver() && S.moves.length && S.ply === S.moves.length && S.endShown !== fen) { S.endShown = fen; if (g.isCheckmate()) matePop(winner); else toast(status, 4000); }
  // move box follows the side to move
  const mine = humanCanMove();
  const over = !g || g.isGameOver() || S.edit || !mine, side = turn === 'w' ? 'White' : 'Black';
  const tag = $('#side-tag'); tag.classList.toggle('b', turn === 'b'); tag.classList.toggle('off', over); tag.querySelector('b').textContent = side;
  const mi = $('#move-in'); mi.disabled = over;
  mi.placeholder = !g ? 'Fix the position first' : S.edit ? 'Finish editing first' : g.isGameOver() || C.flag ? status : !mine ? (vsBot() && S.ply === S.moves.length ? 'Waiting for the bot…' : 'Go to the last move to play') : `${side}'s move… (e4, Nf3, O-O)`;
  renderMode(turn);
  // setup controls
  setSeg('#seg-orient', S.orient); setSeg('#seg-turn', turn);
  const bc = fen.split(' ')[2];
  document.querySelectorAll('#castle input').forEach(i => { i.checked = bc.includes(i.value); });
  $('#fen').value = fen;
  $('#btn-edit').classList.toggle('on', S.edit); $('#palette').classList.toggle('hidden', !S.edit);
  $('#evalbar').classList.toggle('flip', S.orient === 'b');
  renderMoves(); renderTimeline(); renderLines();
  syncBot();
  scheduleLayout();
}
/** Animated checkmate badge over the board: pops in, holds, fades out after 3 seconds. */
function matePop(winner) {
  $('#board .mate-pop')?.remove();
  const sub = vsBot() ? (winner === (S.bot.human === 'w' ? 'White' : 'Black') ? 'You win!' : 'The bot wins') : `${winner} wins`;
  const el = document.createElement('div');
  el.className = 'mate-pop'; el.setAttribute('role', 'status');
  el.innerHTML = `<div class="mp"><span class="mp-k">#</span><b>Checkmate</b><span class="mp-s">${sub}</span></div>`;
  $('#board').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
function setSeg(sel, v) { document.querySelectorAll(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }

function renderMoves() {
  const el = $('#movelist');
  if (!S.moves.length) { el.innerHTML = '<span class="empty">No moves yet.</span>'; return; }
  const startBlack = S.base.split(' ')[1] === 'b';
  let html = '', n = 1, i = 0;
  if (startBlack) { html += `<span class="n">${n}.</span><span class="m muted">…</span>`; }
  for (; i < S.moves.length; i++) {
    const isWhite = startBlack ? i % 2 === 1 : i % 2 === 0;
    if (isWhite) html += `<span class="n">${n}.</span>`;
    html += `<span class="m ${i + 1 === S.ply ? 'cur' : ''} ${i + 1 > S.ply ? 'future' : ''}" data-ply="${i + 1}">${S.moves[i].san}${badge(clsOf(i))}</span>`;
    if (!isWhite) n++;
  }
  el.innerHTML = html;
  const cur = el.querySelector('.cur');
  el.scrollTop = cur ? Math.max(0, cur.offsetTop - el.clientHeight / 2) : el.scrollHeight;
}

function fmtScore(l, turn) {
  const sgn = turn === 'w' ? 1 : -1;
  if (l.type === 'mate') { const m = l.value * sgn; return { txt: (m > 0 ? '#' : '-#') + Math.abs(m), w: m > 0 ? 1 : 0 }; }
  const cp = l.value * sgn / 100;
  return { txt: (cp > 0 ? '+' : '') + cp.toFixed(2), w: 1 / (1 + Math.exp(-cp * 0.55)) };
}
function renderLines() {
  const el = $('#lines'), fen = curFen(), turn = fen.split(' ')[1];
  if (S.mode === 'review') {
    const ev = R.evals[S.ply] || null;
    setEval(ev ? { w: R.ws[S.ply] / 100, txt: fmtWhite(ev, curFen().split(' ')[1]) } : null); return;
  }
  const lines = shown();
  if (!lines.length) { el.innerHTML = `<li class="empty">${!S.valid ? 'Fix the position first.' : S.mode === 'pvp' ? 'Press Hint when you are stuck.' : 'Ask for suggestions any time, for whichever side is to move.'}</li>`; setEval(null); return; }
  el.innerHTML = lines.map((l, i) => {
    const g = new Chess(fen); const sans = [];
    for (const u of l.pv.slice(0, 7)) { try { sans.push(g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; } }
    const sc = fmtScore(l, turn);
    return `<li data-i="${i}" title="Play ${sans[0]} (${i + 1})"><span class="c" style="background:${COLORS[i]}"></span><span class="ev">${sc.txt}</span><span class="pv"><b>${sans[0] || ''}</b> ${sans.slice(1).join(' ')}</span><span class="d">d${l.depth}</span></li>`;
  }).join('');
  setEval(fmtScore(lines[0], turn));
}
function setEval(sc) {
  if (S.mode !== 'analysis' && S.mode !== 'review') { $('#evalbar').classList.add('off'); return; }
  $('#evalbar').classList.remove('off');
  $('#evalbar .fill').style.height = sc ? `${(sc.w * 100).toFixed(1)}%` : '50%';
  $('#evaltext').textContent = sc ? sc.txt.replace('+', '') : '';
}

// ---------- engine ----------
let engine = null;
function analyse() {
  if (!S.valid || !engine || !(S.mode === 'analysis' || (S.mode === 'pvp' && S.hints))) return;
  const g = game(); if (g.isGameOver()) { S.lines = []; renderLines(); return; }
  const fen = curFen(), btn = $('#btn-suggest');
  const label = $('#suggest-label'), idle = suggestLabel();
  btn.disabled = true; label.textContent = 'Thinking…';
  engine.analyse(fen, S.mode === 'pvp' ? 1000 : +$('#think').value, (lines, done) => {
    if (curFen() !== fen) return;
    S.lines = lines; refresh();
    if (done) { btn.disabled = false; label.textContent = idle; }
  });
}
function playLine(i) { const l = shown()[i]; if (l) { const u = l.pv[0]; play(u.slice(0, 2), u.slice(2, 4), u[4]); } }

const suggestLabel = () => (S.mode === 'pvp' ? 'Show hint' : P.lines === 1 ? 'Suggest best move' : `Suggest top ${P.lines}`);
function stopEngine() { engine?.stop(); const b = $('#btn-suggest'); if (b) { b.disabled = false; $('#suggest-label').textContent = suggestLabel(); } }

// ---------- clock ----------
function clockReset() { C.w = C.b = S.time * 1000; C.running = null; C.last = performance.now(); C.flag = null; }
function clockCharge(now = performance.now()) { if (C.running) C[C.running] = Math.max(0, C[C.running] - (now - C.last)); C.last = now; }
/** Re-point the running clock at whoever is to move in the live position (call after any change to the game). */
function clockSync() {
  clockCharge();
  const live = S.moves.length ? S.moves[S.moves.length - 1].fen : null;
  C.running = timed() && live && !C.flag && !new Chess(live).isGameOver() ? live.split(' ')[1] : null;
  renderClocks();
}
const clockLeft = side => Math.max(0, C[side] - (C.running === side ? performance.now() - C.last : 0));
const fmtClock = ms => { const s = Math.ceil(ms / 100) / 10; return s < 20 ? `0:${s.toFixed(1).padStart(4, '0')}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
function renderClocks() {
  document.querySelectorAll('.player').forEach(el => {
    const c = el.querySelector('.clock'), side = el.dataset.side; if (!c) return;
    c.classList.toggle('hidden', !timed() || !side);
    if (!timed() || !side) return;
    const left = clockLeft(side); c.textContent = fmtClock(left);
    c.classList.toggle('run', C.running === side); c.classList.toggle('low', left < 20000 && left < S.time * 1000 && (C.running === side || left === 0));
  });
}
function clockTick() {
  if (!C.running) return;
  if (clockLeft(C.running) <= 0) {
    C[C.running] = 0; C.flag = C.running; C.running = null; botJob = null; botEngine?.stop(); stopEngine(); refresh();
    toast(vsBot() ? (C.flag === S.bot.human ? 'Time out, the bot wins' : 'Time out, you win!') : `Time out, ${C.flag === 'w' ? 'Black' : 'White'} wins`, 4000);
  } else renderClocks();
}
setInterval(clockTick, 100);

// ---------- bot ----------
let botEngine = null, botJob = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function botTurn() {
  if (!vsBot() || !S.valid || S.edit || S.ply !== S.moves.length) return null;
  const fen = curFen();
  return C.flag || new Chess(fen).isGameOver() || fen.split(' ')[1] === S.bot.human ? null : fen;
}
/** Idempotent: starts / cancels the bot's search so it matches the current position. */
function syncBot() {
  const want = botTurn();
  if (!(botJob && botJob.fen === want)) {
    if (botJob) { clearTimeout(botJob.timer); botEngine?.stop(); botJob = null; }
    if (want) startBotJob(want);
  }
  document.querySelectorAll('.player .think').forEach(el => el.classList.add('hidden'));
  if (botJob) botPlayerEl().querySelector('.think').classList.remove('hidden');
}
// Stockfish plays; if it fails to load or does not answer in time, the built-in engine (minibot.js) moves instead,
// and after repeated failures it takes over for the session. The game can never hang on the bot.
let botFails = 0;
function startBotJob(fen) {
  const lv = LEVELS[S.bot.level], job = botJob = { fen }, t0 = performance.now();
  const finish = async best => {
    if (botJob !== job) return;
    clearTimeout(job.timer);
    await sleep(Math.max(0, 200 - (performance.now() - t0)));   // just enough to feel natural
    if (botJob !== job || curFen() !== fen) return;
    botJob = null;
    if (best) play(best.slice(0, 2), best.slice(2, 4), best[4], true); else refresh();
  };
  const fallback = () => setTimeout(() => { if (botJob === job) finish(pickMove(fen, S.bot.level, 600)); }, 0);
  if (botFails >= 2) { fallback(); return; }
  warmBot();
  // generous on the first move (engine download + compile), tight once the engine is warm
  job.timer = setTimeout(() => { if (botJob === job) { botFailed(); fallback(); } }, botEngine.isReady ? 4000 : 15000);
  botEngine.analyse(fen, lv.go, (_l, done, best, failed) => {
    if (!done || botJob !== job) return;
    if (failed) { clearTimeout(job.timer); botFailed(); fallback(); return; }
    finish(best);
  });
}
function botFailed() {
  botFails++;
  try { botEngine?.terminate(); } catch { /* already gone */ }
  botEngine = null;
  if (botFails === 2) toast('Stockfish is not responding on this device, using the built-in engine', 4000);
}
const botPlayerEl = () => $(S.orient === S.bot.human ? '#pl-top' : '#pl-bot');

// ---------- modes ----------
function renderMode(turn) {
  document.body.dataset.mode = S.mode;
  document.body.classList.toggle('timed', timed());
  $('#card-game').classList.toggle('hidden', S.mode === 'analysis' || S.mode === 'review');   // these modes have no settings, only a description   // player labels + clocks beside the board only matter in timed games
  document.querySelectorAll('#seg-mode button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === S.mode)));
  $('#mode-desc').textContent = MODES[S.mode];
  $('#opts-pvp').classList.toggle('hidden', S.mode !== 'pvp'); $('#opts-bot').classList.toggle('hidden', !vsBot());
  $('#hints').checked = S.hints;
  document.querySelectorAll('#seg-level button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === S.bot.level)));
  document.querySelectorAll('#seg-human button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === S.bot.human)));
  $('#level-desc').textContent = LEVELS[S.bot.level].desc;
  $('#btn-takeback').disabled = !S.moves.length || S.ply === 0 || timed();
  $('#btn-takeback').title = timed() ? 'Not available in timed games' : '';
  $('#opts-time').classList.toggle('hidden', S.mode !== 'pvp' && S.mode !== 'bot');
  document.querySelectorAll('#seg-time button').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.v === S.time)));
  renderClocks();
  // engine card: top-3 in analysis, single hint in pvp, hidden when hints are off or vs the bot
  const eng = S.mode === 'analysis' || (S.mode === 'pvp' && S.hints);
  $('#card-engine').classList.toggle('hidden', !eng);
  $('#engine-title').textContent = S.mode === 'pvp' ? 'Hint' : 'Best moves';
  $('#eng-ctl').classList.toggle('hidden', S.mode !== 'analysis');
  if (!$('#btn-suggest').disabled) $('#suggest-label').textContent = suggestLabel();
  // player bars: bottom of the screen = S.orient
  const bot = vsBot();
  for (const [el, side] of [[$('#pl-top'), S.orient === 'w' ? 'b' : 'w'], [$('#pl-bot'), S.orient]]) {
    el.dataset.side = side; el.classList.toggle('black', side === 'b'); el.classList.toggle('active', turn === side && S.valid);
    const isBot = bot && side !== S.bot.human;
    el.querySelector('b').textContent = isBot ? `Bot · ${LEVELS[S.bot.level].label}` : bot ? 'You' : side === 'w' ? 'White' : 'Black';
    el.querySelector('.sub').textContent = bot ? (side === 'w' ? 'White' : 'Black') : '';
  }
  $('#card-coach').classList.toggle('hidden', S.mode !== 'tutor'); $('#card-review').classList.toggle('hidden', S.mode !== 'review');
  $('#card-play').classList.toggle('hidden', S.mode === 'review' && !R.rows.length);
  $('#mode-kicker').textContent = { analysis: 'Analysis', pvp: 'Game settings', bot: 'Bot settings', tutor: 'Lesson settings', review: 'Game review' }[S.mode];
  $('#tab-main-label').textContent = { analysis: 'Engine', pvp: 'Game', bot: 'Game', tutor: 'Lesson', review: 'Review' }[S.mode];
  $('#move-form').classList.toggle('hidden', S.mode === 'review'); $('#move-tip').classList.toggle('hidden', S.mode === 'review');
  if (S.mode === 'tutor') renderFeed();
  renderReview();
  $('#move-tip').textContent = bot ? 'Drag a piece or type your move. Take back to try a different line.' : 'Type a move, or drag pieces on the board. Paste a move list or PGN to rebuild a game.';
}
function warmBot() { if (botFails >= 2) return; botEngine ??= new Engine({ multipv: 1, single: true }); botEngine.setOptions(LEVELS[S.bot.level].opts); }
// ---------- adaptive layout ----------
// Desktop: the board gets the most space that still leaves room for the tabbed panel. Wide screens put the
// panel beside a full-height board; tall or narrow screens put it in the space below the board.
// The panel shows one view at a time (sub-navbar), so nothing scrolls sideways. Phones keep the stacked layout.
const DESKTOP = matchMedia('(min-width: 981px)');
const PANEL_W = 330, PANEL_H = 300, GAP = 18;
let layoutQueued = false;
function scheduleLayout() { if (!layoutQueued) { layoutQueued = true; requestAnimationFrame(() => { layoutQueued = false; relayout(); }); } }
function relayout() {
  const root = document.documentElement.style, layout = $('.layout');
  if (!DESKTOP.matches) { layout.classList.remove('below'); layout.style.height = ''; for (const v of ['--board', '--bw']) root.removeProperty(v); return; }
  layout.style.height = Math.floor(innerHeight - $('.top').offsetHeight) + 'px';   // exactly the space under the header: no page scroll
  const cs = getComputedStyle(layout), card = $('.board-card'), stack = $('.board-stack');
  const H = Math.floor(layout.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
  const W = layout.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const extraW = card.offsetWidth - stack.offsetWidth, extraH = card.offsetHeight - stack.offsetHeight;
  const minBoard = Math.max(360, Math.round(H * 0.6));
  // compare panel-beside vs panel-below and keep whichever gives the bigger board (beside wins ties: less scrolling)
  const side = Math.min(H - extraH, W - extraW - GAP - PANEL_W);
  const under = Math.min(W - extraW, H - extraH - GAP - PANEL_H);
  const below = under > side && side < minBoard;
  const S = Math.max(240, below ? under : side);
  layout.classList.toggle('below', below);
  root.setProperty('--board', S + 'px'); root.setProperty('--bw', S + extraW + 'px');
}

/** Panel sub-navbar: one group of cards at a time. */
function setTab(t) {
  S.tab = t; store.set('tab', t);
  document.querySelectorAll('#subnav [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  document.querySelectorAll('.pane').forEach(p => { p.hidden = p.dataset.pane !== t; });
}
function renderTimeline() {
  const el = $('#timeline');
  $('#tl-count').textContent = S.moves.length ? `${S.ply} / ${S.moves.length}` : '';
  if (!S.moves.length) { el.innerHTML = '<span class="empty">No moves yet.</span>'; return; }
  // a game that starts with Black leaves the first White cell empty, so the review's two-column list stays aligned
  el.innerHTML = (S.base.split(' ')[1] === 'b' ? '<span class="tchip-gap"></span>' : '') + S.moves.map((mv, i) => {
    const cls = clsOf(i), c = CLASSES[cls];
    return `<button type="button" class="tchip ${c ? 'graded' : ''} ${i + 1 === S.ply ? 'cur' : ''} ${i + 1 > S.ply ? 'future' : ''}" data-ply="${i + 1}"${c ? ` style="--c:${c.color}" title="${c.label}"` : ''}>${esc(moveTitle(mv.san, i, S.base, cls))}</button>`;
  }).join('');
  const cur = el.querySelector('.cur');
  el.scrollLeft = cur ? cur.offsetLeft - el.clientWidth / 2 + cur.offsetWidth / 2 : el.scrollWidth;
  el.scrollTop = cur ? cur.offsetTop - el.clientHeight / 2 + cur.offsetHeight / 2 : el.scrollHeight;   // vertical list in Review
}
function setMode(m) {
  if (m === S.mode) return;
  S.mode = m; store.set('mode', m);
  S.lines = []; stopEngine();
  if (m === 'bot' || m === 'tutor') { S.orient = S.bot.human; warmBot(); }
  clockReset();
  if (R.status === 'running') cancelReview();
  if (m === 'tutor') { T.entries = []; T.gen++; }
  setTab('main');
  refresh();
}
function setHuman(c) {
  S.bot.human = c; store.set('human', c); S.orient = c; S.lines = []; refresh();
}

// ---------- reset / new game ----------
function confirmDialog(title, msg, ok = 'Continue') {
  return new Promise(res => {
    const d = $('#confirm'); $('#confirm-title').textContent = title; $('#confirm-msg').textContent = msg; $('#confirm-yes').textContent = ok;
    const done = v => { d.close(); res(v); };
    $('#confirm-yes').onclick = () => done(true); $('#confirm-no').onclick = () => done(false); d.oncancel = () => res(false);
    d.showModal();
  });
}
function clearScan() {
  S.img = S.box = S.grid = null;
  pv.classList.add('hidden'); $('#drop-empty').classList.remove('hidden'); $('#crop-hint').classList.add('hidden'); $('#scan-time').textContent = '';
}
/** Back to the starting position. `settings` also restores every preference to its default. */
function resetState({ settings }) {
  botJob = null; botEngine?.stop(); stopEngine();
  cancelReview(); R.rows = [];
  clearScan();
  if (settings) {
    S.mode = 'analysis'; S.hints = false; S.time = 0; S.bot = { level: 'intermediate', human: 'w' };
    Object.assign(P, PREF_DEFAULTS); applyPrefs(); engine?.setOptions({ MultiPV: P.lines });
    $('#auto').checked = false; $('#think').value = '1500';
    delete document.documentElement.dataset.theme; $('#btn-theme use').setAttribute('href', matchMedia('(prefers-color-scheme: dark)').matches ? '#i-sun' : '#i-moon');
    for (const k of ['mode', 'hints', 'level', 'human', 'orient', 'auto', 'think', 'theme', 'speed', 'prefs', 'time']) try { localStorage.removeItem('augur:' + k); } catch { /* ignore */ }
  }
  Object.assign(S, { orient: vsBot() ? S.bot.human : 'w', turn: 'w', castle: 'KQkq', placement: START, edit: false, tool: null, lines: [], uncertain: new Set(), endShown: null });
  rebuildBase();
}
async function resetAll() {
  if ((S.moves.length || S.img || S.mode !== 'analysis') && !(await confirmDialog('Reset everything?', 'This clears the board, move history, scanned image and all settings back to their defaults.', 'Reset'))) return;
  resetState({ settings: true }); toast('Reset to defaults');
}
// ---------- new game menu (panel sub-navbar) ----------
const MODE_INFO = {
  analysis: { label: 'Analyse', icon: 'i-search', fresh: 'New analysis board' },
  pvp: { label: 'Player vs Player', icon: 'i-users', fresh: 'New two-player game' },
  bot: { label: 'Play the bot', icon: 'i-bot', fresh: 'New game vs the bot' },
  tutor: { label: 'Tutor lesson', icon: 'i-teacher', fresh: 'New tutor lesson' },
  review: { label: 'Game review', icon: 'i-chart', fresh: 'New game review' },
};
const item = (m, text, sub) => `<button type="button" role="menuitem" data-new="${m}" class="ng-item" data-v="${m}"><svg class="ic"><use href="#${MODE_INFO[m].icon}"/></svg><span><b>${text}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
function renderNewMenu() {
  const others = Object.keys(MODE_INFO).filter(m => m !== S.mode);
  $('#ng-menu').innerHTML = `<div class="ng-h">Same mode</div>${item(S.mode, MODE_INFO[S.mode].fresh, 'Keeps your current settings')}
    <div class="ng-h">Or switch to</div>${others.map(m => item(m, MODE_INFO[m].label)).join('')}`;
}
function toggleNewMenu(open) {
  const menu = $('#ng-menu'), btn = $('#btn-new'), show = open ?? menu.classList.contains('hidden');
  if (show) renderNewMenu();
  menu.classList.toggle('hidden', !show); btn.setAttribute('aria-expanded', String(show));
  if (show) menu.querySelector('.ng-item')?.focus();
}
/** Start fresh in `mode` (the current one or another), asking first if a game is in progress. */
async function startNew(mode) {
  toggleNewMenu(false);
  if (S.moves.length && !(await confirmDialog('Start a new game?', 'The current game will be cleared.', 'New game'))) return;
  if (mode !== S.mode) setMode(mode);
  if (mode === 'review') { cancelReview(); setTab('main'); refresh(); toast('Paste a game to review'); return; }
  resetState({ settings: false }); setTab('main'); toast(MODE_INFO[mode].fresh);
}
function wireNewGame() {
  $('#btn-new').addEventListener('click', e => { e.stopPropagation(); toggleNewMenu(); });
  $('#ng-menu').addEventListener('click', e => { const b = e.target.closest('[data-new]'); if (b) startNew(b.dataset.new); });
  document.addEventListener('click', e => { if (!e.target.closest('.ng')) toggleNewMenu(false); });
  $('#ng-menu').addEventListener('keydown', e => {
    const items = [...$('#ng-menu').querySelectorAll('.ng-item')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); toggleNewMenu(false); $('#btn-new').focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
  });
}

function takeBack() {
  if (!S.moves.length) return;
  botJob = null; botEngine?.stop();
  // back to the last position where it was the human's turn
  let p = S.ply - 1;
  while (p > 0 && S.moves[p - 1].fen.split(' ')[1] !== S.bot.human) p--;
  S.moves = S.moves.slice(0, Math.max(0, p)); S.ply = S.moves.length; S.lines = []; T.entries.length = Math.min(T.entries.length, S.ply);
  clockSync(); refresh();
}

// ---------- shared analysis (tutor + review) ----------
let evalEngine = null, evalChain = Promise.resolve();
const evalCache = new Map();
/** Serialised Stockfish evaluation of a position; cached, never rejects. */
function evalFen(fen, ms) {
  const key = fen + '|' + ms;
  if (evalCache.has(key)) return evalCache.get(key);
  const term = terminalEval(fen);
  const p = term ? Promise.resolve(term) : (evalChain = evalChain.then(() => new Promise(res => {
    if (!evalEngine || evalEngine.dead) evalEngine = new Engine({ multipv: 3, single: true });
    let fin = false; const done = v => { if (!fin) { fin = true; clearTimeout(t); res(v); } };
    const t = setTimeout(() => { evalEngine?.terminate(); done(summarise(fen, [])); }, ms + 10000);   // stuck worker: replace it next time
    evalEngine.analyse(fen, ms, (lines, d) => { if (d) done(summarise(fen, lines)); });
  })));
  evalCache.set(key, p);
  p.then(v => { if (!v.terminal && !v.lines.length) evalCache.delete(key); });   // never cache a failed evaluation
  return p;
}
/** Evaluate many positions in parallel on a small pool of single-thread workers, reporting each result as it lands.
 *  Cheap by design: stops searching once the best move is stable, and the pool is released shortly after use. */
let pool = [], poolTimer = null;
const releasePool = () => { clearTimeout(poolTimer); poolTimer = setTimeout(() => { pool.forEach(e => e.terminate()); pool = []; }, 15000); };
async function evalBatch(fens, goFor, early, onResult, stopped, { reverse = false } = {}) {
  clearTimeout(poolTimer);
  pool = pool.filter(e => !e.dead);
  const n = Math.min(Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))), fens.length);
  while (pool.length < n) pool.push(new Engine({ multipv: 2, single: true, hash: 16 }));
  // each worker takes a contiguous run of positions, so its hash table carries over between neighbouring positions;
  // the refining pass walks each run backwards (as Lichess's fishnet does) so deeper results feed earlier positions
  const size = Math.ceil(fens.length / n);
  await Promise.all(pool.slice(0, n).map(async (eng, k) => {
    const fresh = () => { const e = new Engine({ multipv: 2, single: true, hash: 16 }); pool[k] = e; return e; };
    const idx = []; for (let i = k * size; i < Math.min(fens.length, (k + 1) * size); i++) idx.push(i);
    if (reverse) idx.reverse();
    for (const i of idx) {
      if (stopped()) return;
      const go = goFor(i); if (!go) continue;
      const fen = fens[i], key = fen + '|b|' + go, term = terminalEval(fen);
      const ev = term || evalCache.get(key) || await new Promise(res => {
        if (eng.dead) eng = fresh();
        let fin = false; const finish = v => { if (!fin) { fin = true; clearTimeout(t); res(v); } };
        const t = setTimeout(() => { eng.terminate(); finish(summarise(fen, [])); }, 20000);   // stuck worker: swap in a new one
        eng.analyse(fen, go, (lines, d) => { if (d) finish(summarise(fen, lines)); }, early);
      });
      if (!term && ev.lines.length) evalCache.set(key, ev);
      if (!stopped()) onResult(i, ev);
    }
  }));
  releasePool();
}
const uciToSan = (fen, u) => { try { return new Chess(fen).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san; } catch { return u; } };
function pvToSan(fen, pv = [], n = 6) {
  const g = new Chess(fen), out = [];
  for (const u of pv.slice(0, n)) { try { out.push(g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; } }
  return out;
}
function movesText(sans, startBlack) {
  let out = '', n = 1;
  sans.forEach((m, i) => { const white = startBlack ? i % 2 === 1 : i % 2 === 0; if (white) out += `${n}. `; else if (i === 0) out += `${n}... `; out += m + ' '; if (!white) n++; });
  return out.trim();
}
const pawns = cp => (Math.abs(cp) >= 9000 ? 'a forced mate' : (cp > 0 ? '+' : '') + (cp / 100).toFixed(1));
/** Everything the LLM needs, all of it verified by Stockfish. `e` is a tutor entry or a review row. */
function tutorPrompt(e) {
  const opening = S.base === START_FEN && e.sans ? openingName(e.sans) : null;
  const alts = e.before.lines.slice(1, 3).map(l => `${uciToSan(e.fenBefore, l.pv[0])} (${pawns(l.type === 'mate' ? (l.value > 0 ? 9999 : -9999) : l.value)})`);
  return [
    `Position before the move (FEN): ${e.fenBefore}`,
    `Game so far: ${movesText(e.sans, S.base.split(' ')[1] === 'b')}`,
    `${e.who} (${e.side === 'w' ? 'White' : 'Black'}) just played ${e.san}.`,
    `Stockfish verdict: ${CLASSES[e.cls].label}. Evaluation from the mover's side: ${pawns(e.before.cp)} before the move, ${pawns(-e.after.cp)} after it.`,
    e.bestSan ? `Stockfish's preferred move was ${e.bestSan}${e.pv?.length ? ` (line: ${e.pv.join(' ')})` : ''}.` : '',
    alts.length ? `Other good options: ${alts.join(', ')}.` : '',
    opening ? `Opening: ${opening}.` : '',
    e.motifs?.length ? `Tactical facts verified on the board: ${e.motifs.map(x => x.text).join(' ')}` : '',
    `The student is ${LEVEL_TXT[P.level]}.`,
    'Explain this move to the student.',
  ].filter(Boolean).join('\n');
}
const LEVEL_TXT = { beginner: 'a beginner: avoid jargon and explain the basic idea', intermediate: 'a club player', advanced: 'an advanced player: be concise and concrete' };
const clsOf = i => (S.mode === 'tutor' ? T.entries[i]?.cls : S.mode === 'review' ? R.rows[i]?.cls : null);
function plyBadge() {
  const cls = S.ply ? clsOf(S.ply - 1) : null;
  return cls ? { sq: S.moves[S.ply - 1].to, color: CLASSES[cls].color, glyph: CLASSES[cls].glyph } : null;
}

// ---------- tutor ----------
const COACH_MS = 700;
function coachMove(i) {
  const mv = S.moves[i]; if (!mv || S.mode !== 'tutor') return;
  const fenBefore = i ? S.moves[i - 1].fen : S.base, fenAfter = mv.fen, side = fenBefore.split(' ')[1];
  const human = side === S.bot.human;
  const entry = { i, san: mv.san, side, human, who: human ? 'The student' : 'The opponent (a bot)', status: 'eval', fenBefore, fenAfter };
  T.entries[i] = entry; renderFeed();
  const gen = T.gen, live = () => T.gen === gen && T.entries[i] === entry;
  (async () => {
    for (let w = 0; botJob && w < 40; w++) await sleep(100);   // let the bot move first, then grade
    const [before, after] = await Promise.all([evalFen(fenBefore, COACH_MS), evalFen(fenAfter, COACH_MS)]);
    if (!live()) return;
    const sans = S.moves.slice(0, i + 1).map(m => m.san);
    const j = judge({ before, after, uci: mv.from + mv.to + (mv.promotion || ''), fenBefore, fenAfter, mover: side, prevCls: T.entries[i - 1]?.cls, book: S.base === START_FEN && inBook(sans, i + 1) });
    Object.assign(entry, j, { before, after, sans, uci: mv.from + mv.to + (mv.promotion || ''), bestSan: before.best ? uciToSan(fenBefore, before.best) : null, pv: pvToSan(fenBefore, before.lines[0]?.pv), evalAfter: fmtWhite(after, fenAfter.split(' ')[1]), status: 'done' });
    entry.motifs = motifsFor(entry);
    refresh();
    if (!llmReady() || (P.who === 'mine' && !human)) return;
    entry.status = 'llm'; renderFeed();
    try { entry.text = await ask({ system: TUTOR_SYSTEM, user: tutorPrompt(entry) }); entry.status = 'done'; }
    catch (e) { if (e.name === 'AbortError') return; entry.status = 'error'; entry.err = e.message; }
    if (live()) renderFeed();
  })();
}
const motifCache = new Map();
/** Tactical motifs for a graded move (cached: the review re-grades rows while it refines). */
function motifsFor(e) {
  const key = [e.fenBefore, e.uci, e.before.best, e.after.best, e.before.mate, e.after.mate, Math.round(e.drop)].join('|');
  if (!motifCache.has(key)) { try { motifCache.set(key, detectMotifs(e)); } catch { motifCache.set(key, []); } }
  return motifCache.get(key);
}
const motifChips = ms => (ms || []).slice(0, 3).map(x => `<span class="mchip ${x.tone}">${esc(x.label)}</span>`).join('');
/** Plain-English explanation built only from engine facts: used when no AI key is set (and never wrong about the numbers). */
const MOTIF_TIPS = {
  'missed-mate': 'Look at every check first: forcing moves come before anything else.',
  'allows-mate': 'Before you move, ask which checks your opponent will have next.',
  hanging: 'Before every move, list which of your pieces are attacked and whether they are still defended.',
  'missed-capture': 'Scan for captures on every move: checks, captures, then threats.',
  fork: 'Watch for squares where a knight or queen can hit two of your pieces at once.',
  pin: 'Avoid lining up your king or queen behind another piece on an open line.',
  skewer: 'Keep your king and queen off the same line as an enemy rook, bishop or queen.',
  discovered: 'When a piece moves, check which lines it opens for the pieces behind it.',
  'king-safety': 'Keep the pawns in front of a castled king unless you win something concrete.',
};
/** Template explanation split into the explanation itself and a coaching tip (better move + habit to build). */
function templateParts(e) {
  if (!e.cls || !e.before || !e.after) return { text: '', tip: '' };
  const ms = e.motifs || [], has = k => ms.some(x => x.key === k);
  const moverAfter = -e.after.cp, lost = (e.before.cp - moverAfter) / 100, line = (e.pv || []).slice(1, 4).join(' ');
  const good = ['best', 'great', 'brilliant', 'book', 'excellent', 'good'].includes(e.cls);
  let lead;
  if (has('mate')) lead = '';
  else if (['best', 'great', 'brilliant'].includes(e.cls)) lead = `${e.san} is Stockfish's first choice here${e.after.mate < 0 ? ' and keeps a forced mate on the board' : ''}.`;
  else if (e.cls === 'book') lead = `${e.san} is standard opening theory${S.base === START_FEN && e.sans ? ` (${openingName(e.sans) || 'a known line'})` : ''}.`;
  else if (['excellent', 'good'].includes(e.cls)) lead = `${e.san} is a solid move${e.bestSan ? `; ${e.bestSan} was a touch more precise` : ''}.`;
  else if (has('allows-mate') || has('missed-mate')) lead = `${e.san} is ${e.cls === 'inaccuracy' ? 'an' : 'a'} ${CLASSES[e.cls].label.toLowerCase()}.`;
  else lead = `${e.san} costs about ${Math.abs(lost).toFixed(1)} pawns of evaluation, and the winning chances drop by ${e.drop.toFixed(0)}%.`;
  const text = [lead, ms.slice(0, 2).map(x => x.text).join(' ')].filter(Boolean).join(' ');
  let tip = '';
  if (!good && e.bestSan && !has('missed-mate') && !has('missed-capture')) tip = `Better was <b>${esc(e.bestSan)}</b>${line ? `, for example ${esc(e.bestSan)} ${esc(line)}` : ''}.`;
  else if (good && line && !has('mate')) tip = `Main line: <b>${esc(e.san)}</b> ${esc(line)}`;
  const habit = !good && ms.map(x => MOTIF_TIPS[x.key]).find(Boolean);
  if (habit) tip += `${tip ? '<br>' : ''}${esc(habit)}`;
  return { text, tip };
}
function templateText(e) { const p = templateParts(e); return [p.text, p.tip.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '')].filter(Boolean).join(' '); }
/** Opening / middlegame / endgame for the position before a move. */
function phaseOf(fen, ply, book) {
  if (book || ply < 16) return 'opening';
  const placement = fen.split(' ')[0], v = { n: 3, b: 3, r: 5, q: 9 };
  let mat = 0; for (const ch of placement.toLowerCase()) mat += v[ch] || 0;
  return mat <= 26 ? 'endgame' : 'middlegame';
}
/** Tutor panel: one focused lesson card for the move on the board (latest by default), plus running stats. */
function renderFeed() {
  const el = $('#coach-feed'), note = $('#coach-note'), ok = llmReady();
  note.classList.toggle('hidden', ok);
  if (!ok) note.innerHTML = 'Explanations are built from the engine\'s numbers. <button class="linkish" data-open-settings type="button">Add an API key</button> for a conversational AI tutor.';
  const items = T.entries.filter(Boolean);
  if (!items.length) { el.innerHTML = lessonCard({ kicker: 'Tutor lesson', title: 'Your move', body: 'Play a move against the bot. Each move, yours and the bot\'s, is graded and explained here; use the timeline or ← → to revisit earlier ones.' }); return; }
  const e = (S.ply && T.entries[S.ply - 1]) || items[items.length - 1];
  const title = moveTitle(e.san, e.i, S.base, e.cls), kicker = `${e.human ? 'Your move' : 'Bot move'} · ${e.side === 'w' ? 'White' : 'Black'}`;
  const mine = items.filter(x => x.human && x.cls), acc = mine.length ? mine.reduce((a, x) => a + x.acc, 0) / mine.length : null;
  const stats = `<div class="lesson-stats"><div><span>Your accuracy</span><b>${acc == null ? '·' : acc.toFixed(0) + '%'}</b></div><div><span>Strong moves</span><b>${mine.filter(x => ['best', 'great', 'brilliant', 'excellent', 'book'].includes(x.cls)).length}</b></div><div><span>Mistakes</span><b>${mine.filter(x => ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(x.cls)).length}</b></div></div>`;
  if (!e.cls) { el.innerHTML = lessonCard({ kicker, title, body: '<span class="dots">Evaluating…</span>', footer: stats }); return; }
  const p = templateParts(e);
  const body = e.text ? esc(e.text) : e.status === 'llm' ? `${esc(p.text)}<br><span class="dots">The AI tutor is writing…</span>` : `${e.status === 'error' ? `<div class="err">${esc(e.err)}</div>` : ''}${esc(p.text)}`;
  el.innerHTML = lessonCard({ kicker, meta: esc(e.evalAfter || ''), title, cls: e.cls, chips: motifChips(e.motifs), body, tip: p.tip, footer: stats });
  revealLesson(e.i + ':' + (e.text ? 'llm' : e.status));
}
/** When a new lesson appears, scroll the panel so the whole lesson card is visible (desktop only). */
let lastLesson = '';
function revealLesson(key) {
  if (key === lastLesson) return;
  lastLesson = key;
  revealCard($('#card-coach'));
}
/** Scroll the panel (desktop) so `card` is in view at the top. */
function revealCard(card) {
  const pane = card?.closest('.pane');
  if (!DESKTOP.matches || !pane || pane.hidden) return;
  requestAnimationFrame(() => pane.scrollTo({ top: Math.max(0, pane.scrollTop + card.getBoundingClientRect().top - pane.getBoundingClientRect().top - 4), behavior: 'smooth' }));
}

// ---------- game review ----------
function tokenise(text) {
  const body = text.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  let flat = body, prev; do { prev = flat; flat = flat.replace(/\([^()]*\)/g, ' '); } while (flat !== prev);
  return flat.replace(/\$\d+/g, ' ').replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/)
    .map(t => t.replace(/[!?+#]+$/g, '').replace(/0/g, 'O')).filter(t => t && !/^(1-O|O-1|1\/2-1\/2|\*)$/.test(t));
}
/** PGN (chess.com / lichess / any app) or a bare move list -> {headers, startFen, moves}. Throws a readable Error. */
function parseGame(raw) {
  let text = raw.trim();
  if (!text) throw new Error('Paste a game first.');
  if (/^https?:\/\/\S+$/i.test(text)) throw new Error('That is a link, paste the PGN instead (chess.com: Share → PGN → copy).');
  text = text.split(/\r?\n\s*\r?\n(?=\[Event )/)[0];   // multi-game files: first game
  try {
    const g = new Chess(); g.loadPgn(text);
    const hist = g.history({ verbose: true });
    if (hist.length) return { headers: g.getHeaders(), startFen: hist[0].before, moves: hist.map(m => ({ san: m.san, from: m.from, to: m.to, promotion: m.promotion, fen: m.after })) };
  } catch { /* fall through to the tolerant parser */ }
  const fenTag = text.match(/\[FEN\s+"([^"]+)"\]/), startFen = fenTag ? fenTag[1] : START_FEN;
  const toks = tokenise(text);
  if (!toks.length) throw new Error('Could not find any moves in that text.');
  let g; try { g = new Chess(startFen); } catch { throw new Error('The PGN\'s starting position is invalid.'); }
  const moves = [];
  for (const t of toks) {
    try { const m = g.move(t); moves.push({ san: m.san, from: m.from, to: m.to, promotion: m.promotion, fen: g.fen() }); }
    catch { if (!moves.length) throw new Error(`Could not read the move "${t}". Is this a standard PGN?`); break; }
  }
  return { headers: {}, startFen, moves, partial: moves.length < toks.length };
}
function cancelReview() { R.run++; R.status = 'idle'; R.rows = []; R.evals = []; R.ws = []; }
async function startReview(game) {
  if (game.moves.length < 2) throw new Error('That game has fewer than 2 moves, nothing to review.');
  const run = ++R.run, cfg = SPEEDS[R.speed], standard = game.startFen === START_FEN, t0 = performance.now();
  Object.assign(S, { base: game.startFen, moves: game.moves, ply: 0, valid: true, edit: false, lines: [], uncertain: new Set() });
  const f = game.startFen.split(' '); Object.assign(S, { placement: f[0], turn: f[1], castle: f[2] === '-' ? '' : f[2] });
  const fens = [game.startFen, ...game.moves.map(m => m.fen)], sans = game.moves.map(m => m.san);
  Object.assign(R, { status: 'running', phase: 'quick', headers: game.headers || {}, rows: [], evals: [], ws: [], fens, total: game.moves.length, sans, standard, follow: true, got: 0,
    counts: { w: {}, b: {} }, sum: { w: 0, b: 0 }, n: { w: 0, b: 0 }, acc: { w: 100, b: 100 }, opening: standard ? openingName(sans) : null, info: null });
  refresh();
  const bar = $('#rv-bar'), txt = $('#rv-prog-txt'), stopped = () => R.run !== run;
  // pass 1: shallow, streamed move by move
  await evalBatch(fens, () => QUICK, null, (i, ev) => {
    R.evals[i] = ev; R.ws[i] = whiteWin(ev, fens[i].split(' ')[1]); R.got++;
    bar.style.width = `${(R.got / fens.length) * 100}%`; txt.textContent = `Analysing move ${Math.min(R.rows.length + 1, R.total)} of ${R.total}…`;
    let added = false;
    while (R.evals[R.rows.length] && R.evals[R.rows.length + 1]) { pushRow(R.rows.length); added = true; }
    if (added) { if (R.follow) S.ply = R.rows.length; refresh(); } else renderReview();
  }, stopped);
  if (stopped()) return;
  const quickMs = performance.now() - t0;
  R.info = { label: cfg.label, quickMs, refineMs: null, workers: Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2))) };
  if (R.follow) S.ply = 0;
  toast(game.partial ? 'Review ready, stopped at the first move it could not read' : `Review ready in ${(quickMs / 1000).toFixed(1)}s`, 3000);
  // pass 2: deeper, in the background; the review stays usable and updates in place
  if (cfg.go) {
    R.phase = 'refine'; let done = 0, timer = null;
    const todo = fens.map((_, i) => i).filter(i => !(standard && i > 0 && inBook(sans, i)) && !terminalEval(fens[i]));
    bar.style.width = '0%'; txt.textContent = `Refining with deeper analysis… 0 of ${todo.length}`;
    refresh();
    const want = new Set(todo);
    await evalBatch(fens, i => (want.has(i) ? cfg.go : null), cfg.early, (i, ev) => {
      if (ev.lines.length) { R.evals[i] = ev; R.ws[i] = whiteWin(ev, fens[i].split(' ')[1]); }
      done++; bar.style.width = `${(done / todo.length) * 100}%`; txt.textContent = `Refining with deeper analysis… ${done} of ${todo.length}`;
      timer ??= setTimeout(() => { timer = null; if (!stopped()) { rebuildRows(); refresh(); } }, 250);
    }, stopped, { reverse: true });
    clearTimeout(timer);
    if (stopped()) return;
    rebuildRows();
    R.info.refineMs = performance.now() - t0 - quickMs;
  }
  R.status = 'done'; R.phase = null; refresh();
}
/** Re-grade every move from the current evaluations (after the deeper pass), keeping tutor text where the verdict is unchanged. */
function rebuildRows() {
  const old = R.rows;
  Object.assign(R, { rows: [], counts: { w: {}, b: {} }, sum: { w: 0, b: 0 }, n: { w: 0, b: 0 } });
  for (let i = 0; i < R.total && R.evals[i] && R.evals[i + 1]; i++) {
    pushRow(i);
    if (old[i]?.text && old[i].cls === R.rows[i].cls) R.rows[i].text = old[i].text;
  }
}
/** Grade move i as soon as both neighbouring positions are evaluated. */
function pushRow(i) {
  const mv = S.moves[i], fens = R.fens, ev = R.evals, side = fens[i].split(' ')[1];
  const j = judge({ before: ev[i], after: ev[i + 1], uci: mv.from + mv.to + (mv.promotion || ''), fenBefore: fens[i], fenAfter: fens[i + 1], mover: side, prevCls: R.rows[i - 1]?.cls, book: R.standard && inBook(R.sans, i + 1) });
  const book = R.standard && inBook(R.sans, i + 1);
  const r = { ...j, side, phase: phaseOf(fens[i], i, book), san: mv.san, who: 'The player', best: ev[i].best, before: ev[i], after: ev[i + 1], fenBefore: fens[i], fenAfter: fens[i + 1], sans: R.sans.slice(0, i + 1),
    bestSan: ev[i].best ? uciToSan(fens[i], ev[i].best) : null, pv: pvToSan(fens[i], ev[i].lines[0]?.pv),
    evalAfter: fmtWhite(ev[i + 1], fens[i + 1].split(' ')[1]), evalBest: fmtWhite(ev[i], side) };
  r.uci = mv.from + mv.to + (mv.promotion || ''); r.motifs = motifsFor(r);
  R.rows.push(r);
  R.counts[side][r.cls] = (R.counts[side][r.cls] || 0) + 1; R.sum[side] += r.acc; R.n[side]++;
  R.acc = { w: R.n.w ? R.sum.w / R.n.w : 100, b: R.n.b ? R.sum.b / R.n.b : 100 };
}
function renderReview() {
  const on = S.mode === 'review', has = R.rows.length > 0;
  $('#card-rmove').classList.toggle('hidden', !(on && has && R.status !== 'idle'));
  if (!on) return;
  $('#rv-input').classList.toggle('hidden', R.status !== 'idle');
  $('#rv-progress').classList.toggle('hidden', R.status !== 'running');
  $('#rv-summary').classList.toggle('hidden', !(R.status !== 'idle' && has));
  $('#btn-rv-new').classList.toggle('hidden', R.status === 'idle');
  document.querySelectorAll('#seg-speed button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === R.speed)));
  if (R.status === 'idle' || !has) return;
  $('#rv-summary').innerHTML = buildSummary(R, S.ply);
  const i = S.ply - 1, row = R.rows[i];
  const parts = row ? templateParts(row) : { text: '', tip: '' };
  $('#card-rmove').innerHTML = buildMoveCard({ row, ply: S.ply, title: S.moves[i] ? moveTitle(S.moves[i].san, i, S.base, row?.cls) : '', evalAfter: row?.evalAfter, text: row?.text, busy: row?.busy, err: row?.err, canExplain: llmReady(), template: parts.text, tip: parts.tip, chips: row ? motifChips(row.motifs) : '', opening: R.opening, pending: R.status === 'running' && S.ply > 0 && !row });
}
function reviewView() {
  const row = S.ply ? R.rows[S.ply - 1] : null, arrows = [];
  if (row && !row.isBest && row.best && !['book', 'excellent', 'good'].includes(row.cls)) arrows.push({ from: row.best.slice(0, 2), to: row.best.slice(2, 4), color: '#4fbf8f', width: 12, label: '' });
  // the opponent's punishing reply, so you can see what the mistake allowed
  const reply = row?.after?.best;
  if (reply && ['mistake', 'blunder', 'miss'].includes(row.cls)) arrows.push({ from: reply.slice(0, 2), to: reply.slice(2, 4), color: '#e0693f', width: 9, label: '' });
  return arrows;
}
async function explainRow(i) {
  const row = R.rows[i]; if (!row || row.busy) return;
  row.busy = true; row.err = null; renderReview();
  try { row.text = await ask({ system: TUTOR_SYSTEM, user: tutorPrompt(row) }); } catch (e) { row.err = e.message; }
  row.busy = false; renderReview();
}
function jumpMoment(dir) {
  const bad = ['mistake', 'blunder', 'miss'], idx = R.rows.map((r, i) => (bad.includes(r.cls) ? i + 1 : 0)).filter(Boolean);
  const t = dir > 0 ? idx.find(p => p > S.ply) : [...idx].reverse().find(p => p < S.ply);
  if (t) { goto(t); revealCard($('#card-rmove')); } else toast(dir > 0 ? 'No more mistakes ahead' : 'No earlier mistakes');
}
function wireReview() {
  const warn = m => { const w = $('#rv-warn'); w.textContent = m || ''; w.classList.toggle('hidden', !m); };
  const run = async game => { warn(''); try { await startReview(game); } catch (e) { R.status = 'idle'; refresh(); warn(e.message); } };
  $('#btn-rv-run').addEventListener('click', () => { let g; try { g = parseGame($('#rv-pgn').value); } catch (e) { warn(e.message); return; } run(g); });
  $('#btn-rv-file').addEventListener('click', () => $('#rv-file').click());
  $('#rv-file').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { $('#rv-pgn').value = await f.text(); warn(''); } e.target.value = ''; });
  $('#btn-rv-current').addEventListener('click', () => {
    if (S.moves.length < 2) { warn('Play some moves first, or paste a game.'); return; }
    run({ headers: {}, startFen: S.base, moves: S.moves.map(m => ({ ...m })) });
  });
  $('#btn-rv-new').addEventListener('click', () => { cancelReview(); refresh(); });
  $('#btn-rv-cancel').addEventListener('click', () => {
    if (R.phase === 'refine') { R.run++; R.status = 'done'; R.phase = null; refresh(); toast('Kept the quick analysis'); }   // keep pass-1 results
    else { cancelReview(); refresh(); }
  });
  $('#seg-speed').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) { R.speed = b.dataset.v; store.set('speed', R.speed); renderReview(); } });
  $('#rv-summary').addEventListener('click', e => {
    const g = e.target.closest('#rv-graph');
    if (g) { const r = g.getBoundingClientRect(); goto(Math.round((e.clientX - r.left) / r.width * S.moves.length)); revealCard($('#card-rmove')); return; }
    const m = e.target.closest('[data-moment]'); if (m) jumpMoment(+m.dataset.moment);
  });
  $('#card-rmove').addEventListener('click', e => { if (e.target.closest('[data-explain]')) explainRow(S.ply - 1); });
}

// ---------- export & share ----------
const NAG = { brilliant: '$3', great: '$1', inaccuracy: '$6', mistake: '$2', miss: '$4', blunder: '$4' };
/** Grade + evaluations for move i, from the review or the tutor, when available. */
const annotOf = i => (S.mode === 'review' ? R.rows[i] : S.mode === 'tutor' ? (T.entries[i]?.cls ? T.entries[i] : null) : null);
const hasAnnotations = () => S.moves.some((_, i) => annotOf(i));
function pgnEval(ev, fen) {
  if (!ev || ev.terminal) return '';
  const sgn = fen.split(' ')[1] === 'w' ? 1 : -1;
  if (ev.mate !== undefined && ev.mate !== null) return `[%eval #${ev.mate * sgn}]`;
  return `[%eval ${((ev.cp * sgn) / 100).toFixed(2)}]`;
}
function gameResult() {
  if (C.flag) return C.flag === 'w' ? '0-1' : '1-0';
  const live = S.moves.length ? S.moves[S.moves.length - 1].fen : S.base, g = new Chess(live);
  if (g.isCheckmate()) return g.turn() === 'w' ? '0-1' : '1-0';
  if (g.isDraw() || g.isStalemate()) return '1/2-1/2';
  return '*';
}
/** Standard PGN (export format: seven tag roster, 80-column movetext, NAGs and [%eval] comments when annotating). */
function buildPgn({ annotate = false } = {}) {
  const d = new Date(), date = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  const bot = vsBot(), lv = LEVELS[S.bot.level]?.label;
  const names = { w: 'White', b: 'Black' };
  if (bot) { names[S.bot.human] = 'You'; names[S.bot.human === 'w' ? 'b' : 'w'] = `Stockfish (${lv})`; }
  const rh = S.mode === 'review' ? R.headers || {} : {};
  const result = rh.Result && rh.Result !== '*' && S.mode === 'review' ? rh.Result : gameResult();
  const tags = {
    Event: rh.Event || { analysis: 'Augur analysis', pvp: 'Augur casual game', bot: 'Augur vs bot', tutor: 'Augur tutor lesson', review: 'Augur review' }[S.mode],
    Site: rh.Site || 'Augur', Date: rh.Date || date, Round: rh.Round || '-',
    White: rh.White || names.w, Black: rh.Black || names.b, Result: result,
  };
  for (const k of ['WhiteElo', 'BlackElo', 'ECO', 'Opening', 'Termination']) if (rh[k]) tags[k] = rh[k];
  if (!rh.Opening && S.base === START_FEN) { const o = openingName(S.moves.map(m => m.san)); if (o) tags.Opening = o; }
  if (S.time && (S.mode === 'pvp' || S.mode === 'bot')) tags.TimeControl = String(S.time);
  if (S.base !== START_FEN) { tags.SetUp = '1'; tags.FEN = S.base; }
  if (annotate) tags.Annotator = 'Augur (Stockfish 19 lite)';
  const head = Object.entries(tags).map(([k, v]) => `[${k} "${String(v).replace(/\\/g, '').replace(/"/g, "'")}"]`).join('\n');
  // movetext
  const parts = [], fen0 = S.base.split(' ');
  let num = +fen0[5] || 1, black = fen0[1] === 'b', resume = false;
  S.moves.forEach((m, i) => {
    if (!black) parts.push(`${num}.`); else if (i === 0 || resume) parts.push(`${num}...`);
    resume = false;
    parts.push(m.san);
    const a = annotate ? annotOf(i) : null;
    if (a) {
      if (NAG[a.cls]) parts.push(NAG[a.cls]);
      const ev = pgnEval(a.after, m.fen);
      const note = ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(a.cls) && a.bestSan ? `${CLASSES[a.cls].label}. ${a.bestSan} was best.` : '';
      if (ev || note) { parts.push(`{ ${[ev, note].filter(Boolean).join(' ')} }`); resume = !black; }   // after a comment on White's move, Black's move restates "N..." 
    }
    if (black) num++;
    black = !black;
  });
  parts.push(result);
  const lines = []; let cur = '';
  for (const p of parts) { if (cur && (cur + ' ' + p).length > 79) { lines.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; }
  if (cur) lines.push(cur);
  return `${head}\n\n${lines.join('\n')}\n`;
}
/** Compact, upload-free share link: the moves (and a custom start) travel in the URL fragment. */
function shareLink() {
  const params = new URLSearchParams();
  if (S.base !== START_FEN) params.set('fen', S.base);
  params.set('moves', S.moves.map(m => m.from + m.to + (m.promotion || '')).join(' '));
  return `${location.origin}${location.pathname}#${params.toString()}`;
}
/** Open a shared link: rebuild the game from the fragment, then clean the address bar. */
function loadFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('moves') && !h.has('pgn')) return;
  try {
    let game;
    if (h.has('pgn')) game = parseGame(h.get('pgn'));
    else {
      const startFen = h.get('fen') || START_FEN, g = new Chess(startFen), moves = [];
      for (const u of (h.get('moves') || '').split(/[\s,]+/).filter(Boolean)) {
        const mv = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        moves.push({ san: mv.san, from: mv.from, to: mv.to, promotion: mv.promotion, fen: g.fen() });
      }
      game = { headers: {}, startFen, moves };
    }
    if (S.mode !== 'analysis') { S.mode = 'analysis'; store.set('mode', 'analysis'); }
    const f = game.startFen.split(' ');
    Object.assign(S, { placement: f[0], turn: f[1], castle: f[2] === '-' ? '' : f[2], uncertain: new Set(), edit: false });
    rebuildBase();
    S.moves = game.moves; S.ply = game.moves.length; refresh();
    toast(`Shared game loaded (${game.moves.length} moves)`);
  } catch { toast('That share link could not be read'); }
  history.replaceState(null, '', location.pathname + location.search);
}
function copyText(text, msg) {
  const fallback = () => { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast(msg); };
  navigator.clipboard?.writeText(text).then(() => toast(msg), fallback) ?? fallback();
}
function downloadText(text, name) {
  if (IS_TAURI) { copyText(text, 'PGN copied (save it from your clipboard)'); return; }   // webviews ignore download links
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('PGN downloaded');
}
function openExport() {
  if (!S.valid) { toast('Fix the position first'); return; }
  const can = hasAnnotations(), annot = $('#ex-annot');
  annot.disabled = !can; if (!can) annot.checked = false;
  $('#ex-annot-hint').textContent = can ? 'Move grades and engine evaluations as PGN comments' : 'Available after a game review or a tutor lesson';
  const paint = () => { $('#ex-pgn').value = buildPgn({ annotate: annot.checked }); };
  annot.onchange = paint; paint();
  $('#ex-fen').value = curFen();
  $('#export').showModal();
}
function wireExport() {
  const name = () => { const d = new Date(); return `augur-${d.toISOString().slice(0, 16).replace(/[T:]/g, '-')}.pgn`; };
  $('#btn-export').addEventListener('click', openExport);
  $('#ex-copy-pgn').addEventListener('click', () => copyText($('#ex-pgn').value, 'PGN copied'));
  $('#ex-download').addEventListener('click', () => downloadText($('#ex-pgn').value, name()));
  $('#ex-copy-fen').addEventListener('click', () => copyText($('#ex-fen').value, 'FEN copied'));
  $('#ex-link').addEventListener('click', () => copyText(shareLink(), 'Share link copied'));
  $('#ex-lichess').addEventListener('click', () => {
    // Lichess's analysis board takes a PGN in the URL; a custom start position goes in as a FEN
    const url = S.base === START_FEN
      ? 'https://lichess.org/analysis/pgn/' + encodeURIComponent(S.moves.map((m, i) => (i % 2 ? '' : `${i / 2 + 1}. `) + m.san).join(' '))
      : 'https://lichess.org/analysis/' + curFen().replace(/ /g, '_');
    window.open(url, '_blank', 'noopener');
  });
}

// ---------- custom select ----------
/** Replace a native <select> with a styled listbox; the select stays the source of truth (value + 'change'). */
function enhanceSelect(sel, { small = false } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'sel' + (small ? ' sm' : '');
  sel.before(wrap); wrap.appendChild(sel); sel.tabIndex = -1;
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sel-btn'; btn.setAttribute('aria-haspopup', 'listbox');
  if (sel.title) btn.title = sel.title;
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  const menu = document.createElement('ul'); menu.className = 'sel-menu hidden'; menu.setAttribute('role', 'listbox');
  wrap.append(btn, menu);
  let hl = -1;
  const items = () => [...menu.children];
  const paint = () => {
    const opts = [...sel.options];
    menu.innerHTML = opts.map((o, i) => `<li role="option" data-i="${i}" aria-selected="${o.value === sel.value}">${esc(o.textContent)}</li>`).join('');
    btn.textContent = sel.selectedOptions[0]?.textContent || '';
  };
  const mark = i => { hl = i; items().forEach((li, k) => li.classList.toggle('hl', k === i)); items()[i]?.scrollIntoView({ block: 'nearest' }); };
  const open = () => { paint(); menu.classList.remove('hidden'); wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); mark(sel.selectedIndex); };
  const close = () => { menu.classList.add('hidden'); wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  const choose = i => { const v = sel.options[i]?.value; close(); btn.focus(); if (v !== undefined && v !== sel.value) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); } };
  btn.addEventListener('click', () => (menu.classList.contains('hidden') ? open() : close()));
  btn.addEventListener('keydown', e => {
    const isOpen = !menu.classList.contains('hidden'), n = sel.options.length;
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); if (!isOpen) open(); else mark((hl + (e.key === 'ArrowDown' ? 1 : n - 1)) % n); }
    else if ((e.key === 'Enter' || e.key === ' ') && isOpen) { e.preventDefault(); choose(hl); }
    else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close();
  });
  menu.addEventListener('mousedown', e => e.preventDefault());
  menu.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i); });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
  // keep the label in sync when code sets sel.value or replaces options
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); paint(); } });
  paint();
}

// ---------- preferences ----------
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
function paintTheme() { $('#btn-theme use').setAttribute('href', isDark() ? '#i-sun' : '#i-moon'); }
function setTheme(t) {   // 'light' | 'dark' | 'system'
  if (t === 'system') { delete document.documentElement.dataset.theme; try { localStorage.removeItem('augur:theme'); } catch { /* ignore */ } }
  else { document.documentElement.dataset.theme = t; store.set('theme', t); }
  paintTheme(); syncPrefsUI();
}
function applyPrefs() {
  const c = document.body.classList;
  c.toggle('pref-nocoords', !P.coords); c.toggle('pref-nodots', !P.dots); c.toggle('pref-noeval', !P.evalbar); c.toggle('pref-noanim', !P.anim);
  $('#suggest-label') && !$('#btn-suggest').disabled && ($('#suggest-label').textContent = suggestLabel());
}
function setPref(k, v) {
  P[k] = v; store.set('prefs', P); applyPrefs();
  if (k === 'lines') { S.lines = []; stopEngine(); engine?.setOptions({ MultiPV: v }); refresh(); }
}
function syncPrefsUI() {
  const seg = (sel, v) => document.querySelectorAll(sel + ' button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === String(v))));
  seg('#set-theme', store.get('theme', 'system')); seg('#set-lines', P.lines); seg('#set-who', P.who); seg('#set-level', P.level); seg('#set-think', $('#think').value);
  for (const [id, k] of [['coords', 'coords'], ['dots', 'dots'], ['evalbar', 'evalbar'], ['anim', 'anim'], ['autoq', 'autoq']]) $('#set-' + id).checked = P[k];
  $('#set-auto').checked = $('#auto').checked;
}
function wirePrefs() {
  const on = (id, fn) => $(id).addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) { fn(b.dataset.v); syncPrefsUI(); } });
  on('#set-theme', setTheme);
  on('#set-lines', v => setPref('lines', +v));
  on('#set-who', v => setPref('who', v));
  on('#set-level', v => setPref('level', v));
  on('#set-think', v => { $('#think').value = v; store.set('think', v); });
  for (const k of ['coords', 'dots', 'evalbar', 'anim', 'autoq']) $('#set-' + k).addEventListener('change', e => setPref(k, e.target.checked));
  $('#set-auto').addEventListener('change', e => { $('#auto').checked = e.target.checked; $('#auto').dispatchEvent(new Event('change')); });
  $('#btn-prefs-reset').addEventListener('click', () => {
    Object.assign(P, PREF_DEFAULTS); try { localStorage.removeItem('augur:prefs'); } catch { /* ignore */ }
    $('#think').value = '1500'; store.set('think', '1500'); $('#auto').checked = false; store.set('auto', false);
    setTheme('system'); setPref('lines', 3); applyPrefs(); syncPrefsUI(); toast('Settings restored to defaults');
  });
}

// ---------- settings (AI tutor key) ----------
function syncSettingsForm() {
  const id = $('#llm-provider').value, p = PROVIDERS[id];
  $('#f-base').classList.toggle('hidden', id !== 'custom');
  $('#llm-base').placeholder = p.base; $('#llm-model').placeholder = p.model || 'model name';
  $('#llm-key').placeholder = id === 'anthropic' ? 'sk-ant-…' : id === 'custom' ? 'optional for local servers' : 'API key';
}
function settingsForm() { return { provider: $('#llm-provider').value, key: $('#llm-key').value.trim(), model: $('#llm-model').value.trim(), base: $('#llm-base').value.trim() }; }
function setLlmStatus(msg, kind) { const el = $('#llm-status'); el.textContent = msg || ''; el.className = 'small ' + (kind || 'muted'); el.classList.toggle('hidden', !msg); }
function openSettings() {
  const c = loadLLM();
  $('#llm-provider').value = c.provider; $('#llm-key').value = c.key; $('#llm-model').value = c.model; $('#llm-base').value = c.base;
  $('#llm-key').type = 'password'; $('#btn-key-show').textContent = 'Show';
  syncSettingsForm(); syncPrefsUI(); setLlmStatus(llmReady(c) ? 'A key is saved in this browser.' : ''); $('#settings').showModal();
}
function wireSettings() {
  $('#llm-provider').innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  $('#llm-provider').addEventListener('change', () => { $('#llm-model').value = ''; syncSettingsForm(); });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-coach-settings').addEventListener('click', openSettings);
  document.addEventListener('click', e => { if (e.target.closest('[data-open-settings]')) openSettings(); });
  $('#btn-key-show').addEventListener('click', () => { const k = $('#llm-key'), show = k.type === 'password'; k.type = show ? 'text' : 'password'; $('#btn-key-show').textContent = show ? 'Hide' : 'Show'; });
  $('#btn-llm-save').addEventListener('click', () => { saveLLM(settingsForm()); $('#settings').close(); toast(llmReady() ? 'AI tutor ready' : 'Saved'); renderFeed(); renderReview(); });
  $('#btn-llm-clear').addEventListener('click', () => { clearLLM(); $('#llm-key').value = ''; $('#llm-model').value = ''; $('#llm-base').value = ''; setLlmStatus('Key removed.'); renderFeed(); renderReview(); });
  $('#btn-llm-test').addEventListener('click', async () => {
    const cfg = settingsForm(); if (!llmReady(cfg)) { setLlmStatus(cfg.provider === 'custom' ? 'Enter a model name first.' : 'Enter an API key first.', 'err'); return; }
    setLlmStatus('Testing…');
    try { await ask({ system: 'Reply with the single word: ok', user: 'ping', maxTokens: 16 }, cfg); setLlmStatus('Connected, the provider accepted the request.', 'ok'); }
    catch (e) { setLlmStatus(e.message, 'err'); }
  });
}

// ---------- vision ----------
let modelReady = null;
async function scan(blob) {
  if (!blob) return;
  const drop = $('#drop'); drop.classList.add('scanning');
  const t0 = performance.now();
  try {
    S.img = await createImageBitmap(blob); setTab('position');
    await modelReady;
    S.box = detectBoard(S.img) || fallbackBox(S.img);
    const found = S.box.score > 0;
    await read(true);
    const dt = (performance.now() - t0) / 1000;
    $('#scan-time').textContent = `read in ${dt.toFixed(2)}s`;
    toast(found ? `Board read in ${dt.toFixed(2)}s${S.uncertain.size ? ` · ${S.uncertain.size} square(s) to double-check` : ''}` : 'No grid found, adjust the box on the preview');
  } catch (e) { console.error(e); toast('Could not read that image'); }
  drop.classList.remove('scanning');
}
async function read(detectOrientation) {
  S.grid = classifyBoard(S.img, S.box);
  if (detectOrientation) { S.orient = guessFlipped(S.grid) ? 'b' : 'w'; S.turn = S.orient; S.castle = 'KQkq'; if (vsBot()) S.bot.human = S.orient; }
  S.uncertain = new Set();
  const flip = S.orient === 'b';
  S.grid.forEach((row, r) => row.forEach((c, f) => { if (c.conf < 0.8) S.uncertain.add(flip ? 'abcdefgh'[7 - f] + (r + 1) : 'abcdefgh'[f] + (8 - r)); }));
  S.placement = gridToPlacement(S.grid, flip);
  S.edit = false;
  drawPreview(); rebuildBase();
}

const pv = $('#preview');
function drawPreview() {
  if (!S.img) return;
  $('#drop-empty').classList.add('hidden'); pv.classList.remove('hidden'); $('#crop-hint').classList.remove('hidden');
  const k = Math.min(1, 900 / Math.max(S.img.width, S.img.height));
  pv.width = Math.round(S.img.width * k); pv.height = Math.round(S.img.height * k); pv._k = k;
  const c = pv.getContext('2d'); c.drawImage(S.img, 0, 0, pv.width, pv.height);
  const b = S.box, x = b.x * k, y = b.y * k, s = b.size * k;
  c.fillStyle = 'rgba(30,30,60,.35)';
  c.fillRect(0, 0, pv.width, y); c.fillRect(0, y + s, pv.width, pv.height - y - s); c.fillRect(0, y, x, s); c.fillRect(x + s, y, pv.width - x - s, s);
  c.strokeStyle = 'rgba(124,140,255,.95)'; c.lineWidth = Math.max(2, pv.width / 300); c.strokeRect(x, y, s, s);
  c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.5)';
  for (let i = 1; i < 8; i++) { c.beginPath(); c.moveTo(x + s * i / 8, y); c.lineTo(x + s * i / 8, y + s); c.moveTo(x, y + s * i / 8); c.lineTo(x + s, y + s * i / 8); c.stroke(); }
  const h = Math.max(10, pv.width / 45); c.fillStyle = '#7c8cff'; c.fillRect(x + s - h, y + s - h, h, h);
}
let cropDrag = null;
pv.addEventListener('pointerdown', e => {
  e.preventDefault(); e.stopPropagation();
  const r = pv.getBoundingClientRect(), k = pv.width / r.width / pv._k;
  const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k, b = S.box;
  const near = Math.max(24, b.size * .08);
  if (Math.abs(px - (b.x + b.size)) < near && Math.abs(py - (b.y + b.size)) < near) cropDrag = { mode: 'size', px, py, b: { ...b }, k };
  else if (px > b.x && px < b.x + b.size && py > b.y && py < b.y + b.size) cropDrag = { mode: 'move', px, py, b: { ...b }, k };
  else { S.box = { x: px, y: py, size: 20, score: 0 }; cropDrag = { mode: 'size', px, py, b: { ...S.box }, k }; }
  pv.setPointerCapture(e.pointerId);
});
pv.addEventListener('pointermove', e => {
  if (!cropDrag) return;
  const r = pv.getBoundingClientRect(), d = cropDrag;
  const px = (e.clientX - r.left) * d.k, py = (e.clientY - r.top) * d.k;
  if (d.mode === 'move') S.box = { ...d.b, x: d.b.x + px - d.px, y: d.b.y + py - d.py };
  else S.box = { ...d.b, size: Math.max(40, d.b.size + Math.max(px - d.px, py - d.py)) };
  drawPreview();
});
pv.addEventListener('pointerup', () => { if (cropDrag) { cropDrag = null; read(false); } });
pv.addEventListener('click', e => e.preventDefault());

// ---------- edit mode ----------
function buildPalette() {
  const p = $('#palette'), tools = ['K', 'Q', 'R', 'B', 'N', 'P', 'k', 'q', 'r', 'b', 'n', 'p'];
  p.innerHTML = `<button data-t="" class="txt" title="Drag pieces">✋ move</button>` +
    tools.map(t => `<button data-t="${t}"><img src="${pieceSrc(t)}" alt="${t}"></button>`).join('') +
    `<button data-t="x" class="txt" title="Eraser">⌫ erase</button><button data-a="clear" class="txt">clear</button><button data-a="start" class="txt">start pos</button><button data-a="done" class="txt">✓ done</button>`;
  p.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.a === 'clear') { S.placement = '4k3/8/8/8/8/8/8/4K3'; rebuildBase(); return; }
    if (b.dataset.a === 'start') { S.placement = START; S.castle = 'KQkq'; S.turn = 'w'; rebuildBase(); return; }
    if (b.dataset.a === 'done') { toggleEdit(false); return; }
    S.tool = b.dataset.t || null; markTool();
  });
  markTool();
}
function markTool() { document.querySelectorAll('#palette button[data-t]').forEach(b => b.classList.toggle('on', (b.dataset.t || null) === S.tool)); }
function toggleEdit(on = !S.edit) {
  if (on && S.ply) { S.placement = curFen().split(' ')[0]; S.turn = curFen().split(' ')[1]; }
  S.edit = on; stopEngine(); rebuildBase();
}
function onEdit(sq, action, to) {
  if (!sq) return;
  const map = parsePlacement(S.placement);
  if (action === 'erase' || (action === 'place' && S.tool === 'x')) delete map[sq];
  else if (action === 'place' && S.tool) map[sq] = map[sq] === S.tool ? undefined : S.tool;
  else if (action === 'move') { const p = map[sq]; delete map[sq]; if (to) map[to] = p; }
  Object.keys(map).forEach(k => map[k] === undefined && delete map[k]);
  S.uncertain.delete(sq);
  S.placement = mapToPlacement(map); rebuildBase();
}

// ---------- wiring ----------
function init() {
  board = new Board($('#board'), { onMove: play, onEdit, editTool: () => S.tool, autoQueen: () => P.autoq });
  buildPalette();
  S.orient = vsBot() ? S.bot.human : store.get('orient', 'w'); $('#auto').checked = store.get('auto', false); $('#think').value = store.get('think', '1500');
  rebuildBase();

  // file / paste / drop
  $('#file').addEventListener('change', e => scan(e.target.files[0]));
  document.addEventListener('paste', e => {
    if (IS_TAURI && document.activeElement?.tagName !== 'INPUT') return; // handled natively on keydown
    const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (it) { e.preventDefault(); scan(it.getAsFile()); }
    else if (document.activeElement === $('#fen')) return;
    else if (document.activeElement?.closest?.('input, textarea')) return;
    else if (S.mode === 'review' && R.status === 'idle') { e.preventDefault(); $('#rv-pgn').value = e.clipboardData.getData('text'); toast('Game pasted, press Analyse'); }
    else {
      const txt = e.clipboardData.getData('text');
      const r = parsePositionText(txt);
      if (r && !/\[FEN/.test(txt)) { if (r.bottom) S.orient = r.bottom; loadFen(r.fen); toast('Position loaded from text'); }
      else reportImport(importMoves(txt));
    }
  });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => scan(e.dataTransfer.files[0]));
  drop.addEventListener('click', e => { if (S.img) e.preventDefault(); });
  $('#btn-paste').addEventListener('click', pasteFromClipboard);
  $('#ai-prompt').value = AI_PROMPT;
  $('#btn-ai').addEventListener('click', () => { $('#ai-warn').classList.add('hidden'); $('#ai').showModal(); $('#ai-reply').focus(); });
  $('#btn-ai-copy').addEventListener('click', () => { navigator.clipboard?.writeText(AI_PROMPT).then(() => toast('Prompt copied'), () => { $('#ai-prompt').select(); document.execCommand('copy'); toast('Prompt copied'); }); });
  $('#btn-ai-cancel').addEventListener('click', () => $('#ai').close());
  $('#btn-ai-load').addEventListener('click', () => {
    const r = parsePositionText($('#ai-reply').value);
    if (!r) { const w = $('#ai-warn'); w.textContent = 'Could not find a FEN or board in that text.'; w.classList.remove('hidden'); return; }
    if (r.bottom) S.orient = r.bottom;
    loadFen(r.fen); $('#ai').close(); $('#ai-reply').value = '';
    toast(S.valid ? 'Position loaded, check it, then play on' : 'Loaded, but the position needs a fix (see Scan card)');
  });
  $('#btn-open').addEventListener('click', () => $('#file').click());

  $('#seg-orient').addEventListener('click', e => { const v = e.target.dataset.v; if (!v) return;
    if (S.img && S.grid && S.ply === 0 && v !== S.orient) { S.orient = v; S.turn = v; read(false); } else { S.orient = v; refresh(); }
    store.set('orient', v); });
  $('#seg-turn').addEventListener('click', e => { const v = e.target.dataset.v; if (!v || v === curFen().split(' ')[1]) return; if (S.ply) { S.placement = curFen().split(' ')[0]; S.castle = curFen().split(' ')[2]; } S.turn = v; rebuildBase(); });
  $('#castle').addEventListener('change', () => { S.castle = [...document.querySelectorAll('#castle input:checked')].map(i => i.value).join(''); if (S.ply) S.placement = curFen().split(' ')[0]; rebuildBase(); });
  $('#fen').addEventListener('change', e => loadFen(e.target.value));
  $('#btn-copy').addEventListener('click', () => { navigator.clipboard?.writeText(curFen()); toast('FEN copied'); });

  $('#btn-flip').addEventListener('click', () => { S.orient = S.orient === 'w' ? 'b' : 'w'; refresh(); });
  $('#btn-edit').addEventListener('click', () => toggleEdit());
  $('#btn-back').addEventListener('click', () => goto(S.ply - 1));
  $('#btn-fwd').addEventListener('click', () => goto(S.ply + 1));
  $('#btn-reset').addEventListener('click', () => goto(0));
  $('#movelist').addEventListener('click', e => { const p = e.target.dataset.ply; if (p) goto(+p); });
  $('#btn-suggest').addEventListener('click', analyse);
  $('#lines').addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) playLine(+li.dataset.i); });
  $('#auto').addEventListener('change', e => { store.set('auto', e.target.checked); if (e.target.checked) analyse(); });
  $('#think').addEventListener('change', e => store.set('think', e.target.value));
  $('#btn-help').addEventListener('click', () => $('#help').showModal());
  wireReview(); wireSettings(); wirePrefs(); applyPrefs(); wireExport();
  addEventListener('resize', scheduleLayout); DESKTOP.addEventListener('change', scheduleLayout);
  document.fonts?.ready.then(scheduleLayout);
  $('#subnav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  $('#timeline').addEventListener('click', e => { const b = e.target.closest('[data-ply]'); if (b) goto(+b.dataset.ply); });
  setTab(['main', 'moves', 'position'].includes(store.get('tab', 'main')) ? store.get('tab', 'main') : 'main');
  enhanceSelect($('#llm-provider')); enhanceSelect($('#think'), { small: true });
  document.addEventListener('click', e => { const c = e.target.closest('[data-close]'); if (c) c.closest('dialog').close(); });
  $('#settings').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.currentTarget.close(); });
  $('#btn-reset-all').addEventListener('click', resetAll);
  $('#btn-theme').addEventListener('click', () => { setTheme(isDark() ? 'light' : 'dark'); });
  paintTheme();
  wireNewGame();
  $('#btn-takeback').addEventListener('click', takeBack);
  $('#seg-time').addEventListener('click', async e => {
    const b = e.target.closest('button[data-v]'); if (!b || +b.dataset.v === S.time) return;
    if (S.moves.length && !(await confirmDialog('Change time control?', 'The clocks will restart from the new time.', 'Change'))) return;
    S.time = +b.dataset.v; store.set('time', S.time); clockReset(); clockSync(); refresh();
  });
  $('#seg-mode').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) setMode(b.dataset.v); });
  $('#seg-level').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (!b) return; S.bot.level = b.dataset.v; store.set('level', b.dataset.v); botJob = null; botEngine?.stop(); refresh(); });
  $('#seg-human').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) setHuman(b.dataset.v); });
  $('#hints').addEventListener('change', e => { S.hints = e.target.checked; store.set('hints', S.hints); S.lines = []; stopEngine(); refresh(); });

  $('#move-in').addEventListener('keydown', e => {
    if (e.key === ' ' && !e.target.value.trim()) { e.preventDefault(); analyse(); }   // Space on empty box = suggest
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.value) { e.preventDefault(); goto(S.ply + (e.key === 'ArrowLeft' ? -1 : 1)); }
  });
  $('#move-in').addEventListener('paste', e => {
    const txt = e.clipboardData.getData('text');
    if (/\s/.test(txt.trim()) && S.valid && !S.edit) { e.preventDefault(); e.stopPropagation(); reportImport(importMoves(txt)); }
  });
  $('#move-form').addEventListener('submit', e => {
    e.preventDefault(); const inp = $('#move-in'), v = inp.value.trim(); if (!v) return;
    let ok = false;
    if (/^[123]$/.test(v)) { if (shown()[+v - 1]) { playLine(+v - 1); inp.value = ''; } else { toast('Ask for suggestions first (Space)'); } inp.focus(); return; }
    if (S.valid && !S.edit && /\s/.test(v)) { if (reportImport(importMoves(v))) inp.value = ''; return; }
    if (S.valid && !S.edit) {
      const m = v.match(/^([a-h][1-8])-?([a-h][1-8])([qrbn])?$/i);
      if (m) ok = play(m[1].toLowerCase(), m[2].toLowerCase(), m[3]?.toLowerCase());
      else { try { const g = game(); const mv = g.move(v.replace(/0/g, 'O')); ok = play(mv.from, mv.to, mv.promotion); } catch { ok = false; } }
    }
    if (ok) { inp.value = ''; inp.focus(); } else { inp.classList.remove('bad'); void inp.offsetWidth; inp.classList.add('bad'); }
  });

  document.addEventListener('keydown', e => {
    if (IS_TAURI && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && !e.target.closest('input, textarea')) { e.preventDefault(); pasteFromClipboard(); return; }
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;   // shortcuts are for the board, not for open dialogs
    const k = e.key;
    if (k === ' ' && e.target.closest('button, summary')) return;   // let Space activate the focused control
    if (k === ' ') { e.preventDefault(); analyse(); }
    else if (k === 'ArrowLeft') goto(S.ply - 1);
    else if (k === 'ArrowRight') goto(S.ply + 1);
    else if (k === 'f') $('#btn-flip').click();
    else if (k === 'e') toggleEdit();
    else if (k === 't') $(`#seg-turn button[data-v="${curFen().split(' ')[1] === 'w' ? 'b' : 'w'}"]`).click();
    else if ('123'.includes(k)) playLine(+k - 1);
    else if (k === 'Escape' && S.edit) toggleEdit(false);
  });

  // engine + model -> one status indicator
  const st = { model: 'loading', engine: 'loading', threads: 1 };
  const paint = () => {
    const el = $('#status'), all = Object.values({ m: st.model, e: st.engine });
    const state = all.includes('err') ? 'err' : all.every(v => v === 'ok') ? 'ok' : 'loading';
    el.className = 'status ' + state;
    el.querySelector('span').textContent = state === 'ok' ? 'Ready' : state === 'err' ? 'Problem' : 'Loading…';
    const d = v => ({ ok: 'ready', err: 'failed to load', loading: 'loading…' }[v]);
    el.title = `Vision model: ${d(st.model)}\nStockfish 19 lite: ${d(st.engine)}${st.engine === 'ok' ? (st.threads > 1 ? ` (${st.threads} threads)` : ' (1 thread)') : ''}`;
  };
  paint();
  try {
    engine = new Engine({ multipv: P.lines });
    engine.ready.then(() => { st.engine = 'ok'; st.threads = engine.threads; paint(); }, () => { st.engine = 'err'; paint(); });
  } catch (e) { st.engine = 'err'; paint(); }
  if (vsBot()) warmBot();
  modelReady = loadModel().then(() => { st.model = 'ok'; paint(); }).catch(() => { st.model = 'err'; paint(); toast('Vision model failed to load'); });

  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/** Apply a pasted move list / PGN. Full games ("1. e4 …", PGN headers) start from the initial
 *  position (or the PGN's [FEN]); a bare list like "Nf3 d5 c4" continues from the current position. */
function importMoves(text) {
  const fenTag = text.match(/\[FEN\s+"([^"]+)"\]/);
  const fullGame = !!fenTag || /\[\w+\s+"/.test(text) || /^\s*1\.(?!\.)/.test(text);
  const toks = tokenise(text);
  if (!toks.length) return null;
  const snapshot = { placement: S.placement, turn: S.turn, castle: S.castle, moves: S.moves, ply: S.ply, base: S.base };
  if (fullGame) {
    if (fenTag) { const p = fenTag[1].split(' '); S.placement = p[0]; S.turn = p[1] || 'w'; S.castle = p[2] && p[2] !== '-' ? p[2] : ''; }
    else { S.placement = START; S.turn = 'w'; S.castle = 'KQkq'; }
    S.uncertain = new Set(); rebuildBase();
  }
  if (!S.valid) { Object.assign(S, snapshot); rebuildBase({ keepHistory: true }); return { ok: 0, total: toks.length, bad: 'position' }; }
  batching = true; let ok = 0, bad = null;
  for (const t of toks) {
    let done = false;
    const m = t.match(/^([a-h][1-8])-?([a-h][1-8])=?([qrbnQRBN])?$/);
    try {
      if (m) done = play(m[1], m[2], m[3]?.toLowerCase());
      else { const mv = game().move(t); done = play(mv.from, mv.to, mv.promotion); }
    } catch { done = false; }
    if (!done) { bad = t; break; }
    ok++;
  }
  batching = false; clockSync();
  if (!ok && fullGame) { Object.assign(S, snapshot); }
  S.lines = []; refresh();
  if (ok && autoOn()) analyse();
  return { ok, total: toks.length, bad };
}
function reportImport(r) {
  if (!r) return false;
  if (r.bad === 'position') toast('Could not set up the PGN start position');
  else if (r.bad) toast(`Played ${r.ok} move${r.ok === 1 ? '' : 's'} · stopped at "${r.bad}" (illegal here)`, 3500);
  else toast(`Played ${r.ok} move${r.ok === 1 ? '' : 's'}, step through with ← →`);
  return r.ok > 0;
}

const IS_TAURI = !!window.__TAURI__;
async function pasteFromClipboard() {
  if (IS_TAURI) {
    try {
      const buf = await window.__TAURI__.core.invoke('clipboard_image');
      const dv = new DataView(buf), w = dv.getUint32(0, true), h = dv.getUint32(4, true);
      scan(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h));
    } catch { toast('No image on the clipboard'); }
    return;
  }
  try {
    for (const item of await navigator.clipboard.read()) {
      const t = item.types.find(x => x.startsWith('image/'));
      if (t) { scan(await item.getType(t)); return; }
    }
    toast('No image on the clipboard');
  } catch { toast('Press Ctrl/⌘+V to paste'); }
}

const AI_PROMPT = `Read the chess position in the attached screenshot.

Reply with ONLY this JSON, nothing else:
{"fen": "<full FEN>", "bottom": "white" or "black"}

Rules:
- FEN ranks go from rank 8 down to rank 1 (White's view), even if the board is shown from Black's side. Use the coordinate labels / king and pawn placement to tell which side is at the bottom.
- Uppercase = white pieces (KQRBNP), lowercase = black. Each rank must add up to exactly 8 squares.
- Side to move: use the move indicator / clock / highlighted last move if visible; otherwise assume the side at the bottom is to move.
- Castling: only rights whose king and rook are still on their home squares. En passant: "-".
- Before answering, re-check every rank square by square.`;

/** Pull a position out of free text: JSON {fen, bottom}, an 8x8 board array, or a bare FEN. */
function parsePositionText(txt) {
  const out = {};
  const json = txt.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const o = JSON.parse(json[0]);
      if (o.fen) out.fen = String(o.fen);
      else if (Array.isArray(o.board) && o.board.length === 8) out.fen = o.board.map(r => (Array.isArray(r) ? r.join('') : String(r)).replace(/[.\-_ ]/g, '1')).join('/').replace(/1+/g, m => m.length) + ' ' + (o.to_move || o.turn || 'w')[0].toLowerCase();
      const b = String(o.bottom || o.orientation || '').toLowerCase(); if (b) out.bottom = b.startsWith('b') ? 'b' : 'w';
    } catch { /* fall through to regex */ }
  }
  if (!out.fen) { const m = txt.match(/([pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8}(\s+[wb](\s+(-|[KQkq]{1,4}))?)?/); if (m) out.fen = m[0]; }
  if (!out.bottom && /black (is )?(at|on) the bottom|from black/i.test(txt)) out.bottom = 'b';
  return out.fen ? out : null;
}

function loadFen(fen) {
  const p = fen.trim().split(/\s+/);
  if (p[0].split('/').length !== 8) { toast('That is not a FEN'); return; }
  S.placement = p[0]; S.turn = p[1] === 'b' ? 'b' : 'w'; S.castle = p[2] === undefined ? 'KQkq' : p[2] === '-' ? '' : p[2];
  S.uncertain = new Set(); rebuildBase();
}

init();
loadFromHash();
window.addEventListener('hashchange', loadFromHash);
window.__augur = { S, scan, curFen };
