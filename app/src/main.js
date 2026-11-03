import { Chess } from 'chess.js';
import { Board, pieceSrc } from './board.js';
import { Engine } from './engine.js';
import { detectBoard, fallbackBox } from './vision/detect.js';
import { loadModel, classifyBoard, guessFlipped, gridToPlacement } from './vision/classify.js';

const $ = s => document.querySelector(s);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const COLORS = ['var(--a1)', 'var(--a2)', 'var(--a3)'];
const RAW = ['#6f86ff', '#4fbf8f', '#f08a6c'];
const store = { get(k, d) { try { const v = localStorage.getItem('augur:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('augur:' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

const S = {
  img: null, box: null, grid: null,
  orient: 'w', turn: 'w', castle: 'KQkq', placement: START,
  base: null, valid: true, moves: [], ply: 0,
  edit: false, tool: null, lines: [], uncertain: new Set(),
  mode: store.get('mode', 'analysis'), hints: store.get('hints', false),
  bot: { level: store.get('level', 'intermediate'), human: store.get('human', 'w') },
};
const MODES = {
  analysis: 'Scan a position, explore lines and ask Stockfish for the top 3 moves.',
  pvp: 'Two players, one board. Moves alternate; Stockfish can give a single hint if you allow it.',
  bot: 'Play against Stockfish. Pick a difficulty and your colour.',
};
const LEVELS = {
  easy: { label: 'Easy', desc: 'Makes plenty of mistakes — good for learning (~1000).', opts: { UCI_LimitStrength: false, 'Skill Level': 1 }, go: 'movetime 200' },
  intermediate: { label: 'Intermediate', desc: 'Solid club player, still beatable (~1700).', opts: { 'Skill Level': 20, UCI_LimitStrength: true, UCI_Elo: 1700 }, go: 'movetime 500' },
  expert: { label: 'Expert', desc: 'Full-strength Stockfish. Good luck.', opts: { UCI_LimitStrength: false, 'Skill Level': 20 }, go: 'movetime 1200' },
};

// ---------- helpers ----------
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms); }
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
  try { if (new Chess(parts.join(' ')).inCheck()) return `${parts[1] === 'w' ? 'White' : 'Black'} is in check but it's not their move — flip "To move"?`; } catch { /* ignore */ }
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
  if (!keepHistory) { S.moves = []; S.ply = 0; }
  S.lines = [];
  refresh();
  if (S.valid && autoOn() && !S.edit) analyse();
}

let batching = false;
function play(from, to, promotion, byBot = false) {
  if (S.mode === 'bot' && !byBot && !batching && curFen().split(' ')[1] !== S.bot.human) return false;
  const g = game();
  let mv;
  try { mv = g.move({ from, to, promotion }); } catch { return false; }
  S.moves = S.moves.slice(0, S.ply);
  S.moves.push({ san: mv.san, from, to, fen: g.fen() });
  S.ply++; S.lines = []; S.uncertain = new Set();
  if (batching) return true;
  refresh();
  if (autoOn()) analyse(); else stopEngine();
  return true;
}
function goto(ply) { S.ply = Math.max(0, Math.min(S.moves.length, ply)); S.lines = []; refresh(); if (autoOn()) analyse(); }
const autoOn = () => S.mode === 'analysis' && $('#auto').checked;
/** Engine lines that the current mode lets the player see. */
const shown = () => (S.mode === 'analysis' ? S.lines.slice(0, 3) : S.mode === 'pvp' && S.hints ? S.lines.slice(0, 1) : []);
const humanCanMove = () => S.mode !== 'bot' || curFen().split(' ')[1] === S.bot.human;

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
    arrows: shown().map((l, i) => ({ from: l.pv[0].slice(0, 2), to: l.pv[0].slice(2, 4), color: RAW[i], width: [15, 11, 8][i], label: String(i + 1) })),
  });
  // turn
  const t = $('#turn'); t.classList.toggle('b', turn === 'b');
  const winner = turn === 'w' ? 'Black' : 'White';
  let status = `${turn === 'w' ? 'White' : 'Black'} to move`;
  if (g && g.isCheckmate()) status = S.mode === 'bot' ? (winner === (S.bot.human === 'w' ? 'White' : 'Black') ? 'Checkmate — you win!' : 'Checkmate — the bot wins') : `Checkmate — ${winner} wins`;
  else if (g && g.isStalemate()) status = 'Stalemate — draw';
  else if (g && g.isDraw()) status = 'Draw';
  else if (!S.valid) status = 'Position needs fixing';
  else if (S.mode === 'bot') status = humanCanMove() ? 'Your move' : 'Bot is thinking…';
  t.querySelector('span').textContent = status;
  t.classList.toggle('over', !!g && g.isGameOver());
  if (g && g.isGameOver() && S.moves.length && S.ply === S.moves.length && S.endShown !== fen) { S.endShown = fen; toast(status, 4000); }
  // move box follows the side to move
  const mine = humanCanMove();
  const over = !g || g.isGameOver() || S.edit || !mine, side = turn === 'w' ? 'White' : 'Black';
  const tag = $('#side-tag'); tag.classList.toggle('b', turn === 'b'); tag.classList.toggle('off', over); tag.querySelector('b').textContent = side;
  const mi = $('#move-in'); mi.disabled = over;
  mi.placeholder = !g ? 'Fix the position first' : S.edit ? 'Finish editing first' : g.isGameOver() ? status : !mine ? 'Waiting for the bot…' : `${side}'s move… (e4, Nf3, O-O)`;
  renderMode(turn);
  // setup controls
  setSeg('#seg-orient', S.orient); setSeg('#seg-turn', turn);
  const bc = fen.split(' ')[2];
  document.querySelectorAll('#castle input').forEach(i => { i.checked = bc.includes(i.value); });
  $('#fen').value = fen;
  $('#btn-edit').classList.toggle('on', S.edit); $('#palette').classList.toggle('hidden', !S.edit);
  $('#evalbar').classList.toggle('flip', S.orient === 'b');
  renderMoves(); renderLines();
  syncBot();
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
    html += `<span class="m ${i + 1 === S.ply ? 'cur' : ''} ${i + 1 > S.ply ? 'future' : ''}" data-ply="${i + 1}">${S.moves[i].san}</span>`;
    if (!isWhite) n++;
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function fmtScore(l, turn) {
  const sgn = turn === 'w' ? 1 : -1;
  if (l.type === 'mate') { const m = l.value * sgn; return { txt: (m > 0 ? '#' : '-#') + Math.abs(m), w: m > 0 ? 1 : 0 }; }
  const cp = l.value * sgn / 100;
  return { txt: (cp > 0 ? '+' : '') + cp.toFixed(2), w: 1 / (1 + Math.exp(-cp * 0.55)) };
}
function renderLines() {
  const el = $('#lines'), fen = curFen(), turn = fen.split(' ')[1];
  const lines = shown();
  if (!lines.length) { el.innerHTML = `<li class="empty">${!S.valid ? 'Fix the position first.' : S.mode === 'pvp' ? 'Press Hint when you are stuck.' : 'Ask for suggestions any time — for whichever side is to move.'}</li>`; setEval(null); return; }
  el.innerHTML = lines.map((l, i) => {
    const g = new Chess(fen); const sans = [];
    for (const u of l.pv.slice(0, 7)) { try { sans.push(g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; } }
    const sc = fmtScore(l, turn);
    return `<li data-i="${i}" title="Play ${sans[0]} (${i + 1})"><span class="c" style="background:${COLORS[i]}"></span><span class="ev">${sc.txt}</span><span class="pv"><b>${sans[0] || ''}</b> ${sans.slice(1).join(' ')}</span><span class="d">d${l.depth}</span></li>`;
  }).join('');
  setEval(fmtScore(lines[0], turn));
}
function setEval(sc) {
  if (S.mode !== 'analysis') { $('#evalbar').classList.add('off'); return; }
  $('#evalbar').classList.remove('off');
  $('#evalbar .fill').style.height = sc ? `${(sc.w * 100).toFixed(1)}%` : '50%';
  $('#evaltext').textContent = sc ? sc.txt.replace('+', '') : '';
}

// ---------- engine ----------
let engine = null;
function analyse() {
  if (!S.valid || !engine || S.mode === 'bot' || (S.mode === 'pvp' && !S.hints)) return;
  const g = game(); if (g.isGameOver()) { S.lines = []; renderLines(); return; }
  const fen = curFen(), btn = $('#btn-suggest');
  const label = $('#suggest-label'), idle = S.mode === 'pvp' ? 'Hint' : 'Suggest top 3';
  btn.disabled = true; label.textContent = 'Thinking…';
  engine.analyse(fen, S.mode === 'pvp' ? 1000 : +$('#think').value, (lines, done) => {
    if (curFen() !== fen) return;
    S.lines = lines; refresh();
    if (done) { btn.disabled = false; label.textContent = idle; }
  });
}
function playLine(i) { const l = shown()[i]; if (l) { const u = l.pv[0]; play(u.slice(0, 2), u.slice(2, 4), u[4]); } }

function stopEngine() { engine?.stop(); const b = $('#btn-suggest'); if (b) { b.disabled = false; $('#suggest-label').textContent = S.mode === 'pvp' ? 'Hint' : 'Suggest top 3'; } }

// ---------- bot ----------
let botEngine = null, botJob = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function botTurn() {
  if (S.mode !== 'bot' || !S.valid || S.edit || S.ply !== S.moves.length) return null;
  const fen = curFen();
  return new Chess(fen).isGameOver() || fen.split(' ')[1] === S.bot.human ? null : fen;
}
/** Idempotent: starts / cancels the bot's search so it matches the current position. */
function syncBot() {
  const want = botTurn();
  if (!(botJob && botJob.fen === want)) {
    if (botJob) { botEngine?.stop(); botJob = null; }
    if (want) {
      botEngine ??= new Engine({ multipv: 1, single: true });
      const lv = LEVELS[S.bot.level], job = botJob = { fen: want }, t0 = performance.now();
      botEngine.setOptions(lv.opts);
      botEngine.analyse(want, lv.go, async (_l, done, best) => {
        if (!done || botJob !== job) return;
        await sleep(Math.max(0, 450 - (performance.now() - t0)));   // feel less instant
        if (botJob !== job || curFen() !== want) return;
        botJob = null;
        if (best) play(best.slice(0, 2), best.slice(2, 4), best[4], true); else refresh();
      });
    }
  }
  document.querySelectorAll('.player .think').forEach(el => el.classList.add('hidden'));
  if (botJob) botPlayerEl().querySelector('.think').classList.remove('hidden');
}
const botPlayerEl = () => $(S.orient === S.bot.human ? '#pl-top' : '#pl-bot');

// ---------- modes ----------
function renderMode(turn) {
  document.querySelectorAll('#seg-mode button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === S.mode)));
  $('#mode-desc').textContent = MODES[S.mode];
  $('#opts-pvp').classList.toggle('hidden', S.mode !== 'pvp'); $('#opts-bot').classList.toggle('hidden', S.mode !== 'bot');
  $('#hints').checked = S.hints;
  document.querySelectorAll('#seg-level button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === S.bot.level)));
  document.querySelectorAll('#seg-human button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === S.bot.human)));
  $('#level-desc').textContent = LEVELS[S.bot.level].desc;
  $('#btn-takeback').disabled = !S.moves.length || S.ply === 0;
  // engine card: top-3 in analysis, single hint in pvp, hidden when hints are off or vs the bot
  const eng = S.mode === 'analysis' || (S.mode === 'pvp' && S.hints);
  $('#card-engine').classList.toggle('hidden', !eng);
  $('#engine-title').textContent = S.mode === 'pvp' ? 'Hint' : 'Best moves';
  $('#eng-ctl').classList.toggle('hidden', S.mode !== 'analysis');
  if (!$('#btn-suggest').disabled) $('#suggest-label').textContent = S.mode === 'pvp' ? 'Show hint' : 'Suggest top 3';
  // player bars: bottom of the screen = S.orient
  const bot = S.mode === 'bot';
  for (const [el, side] of [[$('#pl-top'), S.orient === 'w' ? 'b' : 'w'], [$('#pl-bot'), S.orient]]) {
    el.classList.toggle('black', side === 'b'); el.classList.toggle('active', turn === side && S.valid);
    const isBot = bot && side !== S.bot.human;
    el.querySelector('b').textContent = isBot ? `Bot · ${LEVELS[S.bot.level].label}` : bot ? 'You' : side === 'w' ? 'White' : 'Black';
    el.querySelector('.sub').textContent = bot ? (side === 'w' ? 'White' : 'Black') : '';
  }
  $('#move-tip').textContent = bot ? 'Drag a piece or type your move. Take back to try a different line.' : 'Type a move, or drag pieces on the board. Paste a move list or PGN to rebuild a game.';
}
function setMode(m) {
  if (m === S.mode) return;
  S.mode = m; store.set('mode', m);
  S.lines = []; stopEngine();
  if (m === 'bot') S.orient = S.bot.human;
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
  clearScan();
  if (settings) {
    S.mode = 'analysis'; S.hints = false; S.bot = { level: 'intermediate', human: 'w' };
    $('#auto').checked = false; $('#think').value = '1500';
    for (const k of ['mode', 'hints', 'level', 'human', 'orient', 'auto', 'think']) try { localStorage.removeItem('augur:' + k); } catch { /* ignore */ }
  }
  Object.assign(S, { orient: S.mode === 'bot' ? S.bot.human : 'w', turn: 'w', castle: 'KQkq', placement: START, edit: false, tool: null, lines: [], uncertain: new Set(), endShown: null });
  rebuildBase();
}
async function resetAll() {
  if ((S.moves.length || S.img || S.mode !== 'analysis') && !(await confirmDialog('Reset everything?', 'This clears the board, move history, scanned image and all settings back to their defaults.', 'Reset'))) return;
  resetState({ settings: true }); toast('Reset to defaults');
}
async function newGame() {
  if (S.moves.length && !(await confirmDialog('Start a new game?', 'The current game will be cleared.', 'New game'))) return;
  resetState({ settings: false }); toast('New game');
}
function takeBack() {
  if (!S.moves.length) return;
  botJob = null; botEngine?.stop();
  // back to the last position where it was the human's turn
  let p = S.ply - 1;
  while (p > 0 && S.moves[p - 1].fen.split(' ')[1] !== S.bot.human) p--;
  S.moves = S.moves.slice(0, Math.max(0, p)); S.ply = S.moves.length; S.lines = [];
  refresh();
}

// ---------- vision ----------
let modelReady = null;
async function scan(blob) {
  if (!blob) return;
  const drop = $('#drop'); drop.classList.add('scanning');
  const t0 = performance.now();
  try {
    S.img = await createImageBitmap(blob);
    await modelReady;
    S.box = detectBoard(S.img) || fallbackBox(S.img);
    const found = S.box.score > 0;
    await read(true);
    const dt = (performance.now() - t0) / 1000;
    $('#scan-time').textContent = `read in ${dt.toFixed(2)}s`;
    toast(found ? `Board read in ${dt.toFixed(2)}s${S.uncertain.size ? ` · ${S.uncertain.size} square(s) to double-check` : ''}` : 'No grid found — adjust the box on the preview');
  } catch (e) { console.error(e); toast('Could not read that image'); }
  drop.classList.remove('scanning');
}
async function read(detectOrientation) {
  S.grid = classifyBoard(S.img, S.box);
  if (detectOrientation) { S.orient = guessFlipped(S.grid) ? 'b' : 'w'; S.turn = S.orient; S.castle = 'KQkq'; if (S.mode === 'bot') S.bot.human = S.orient; }
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
  board = new Board($('#board'), { onMove: play, onEdit, editTool: () => S.tool });
  buildPalette();
  S.orient = S.mode === 'bot' ? S.bot.human : store.get('orient', 'w'); $('#auto').checked = store.get('auto', false); $('#think').value = store.get('think', '1500');
  rebuildBase();

  // file / paste / drop
  $('#file').addEventListener('change', e => scan(e.target.files[0]));
  document.addEventListener('paste', e => {
    if (IS_TAURI && document.activeElement?.tagName !== 'INPUT') return; // handled natively on keydown
    const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (it) { e.preventDefault(); scan(it.getAsFile()); }
    else if (document.activeElement === $('#fen')) return;
    else if (document.activeElement?.closest?.('input, textarea')) return;
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
    toast(S.valid ? 'Position loaded — check it, then play on' : 'Loaded, but the position needs a fix (see Scan card)');
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
  $('#btn-reset-all').addEventListener('click', resetAll);
  $('#btn-new').addEventListener('click', newGame);
  $('#btn-takeback').addEventListener('click', takeBack);
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
    if (/^[123]$/.test(v)) { if (S.lines[+v - 1]) { playLine(+v - 1); inp.value = ''; } else { toast('Ask for suggestions first (Space)'); } inp.focus(); return; }
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
    const k = e.key;
    if (k === ' ') { e.preventDefault(); analyse(); }
    else if (k === 'ArrowLeft') goto(S.ply - 1);
    else if (k === 'ArrowRight') goto(S.ply + 1);
    else if (k === 'f') $('#btn-flip').click();
    else if (k === 'e') toggleEdit();
    else if (k === 't') $(`#seg-turn button[data-v="${curFen().split(' ')[1] === 'w' ? 'b' : 'w'}"]`).click();
    else if ('123'.includes(k)) playLine(+k - 1);
    else if (k === 'Escape' && S.edit) toggleEdit(false);
  });

  // engine + model
  try {
    engine = new Engine();
    engine.ready.then(() => { const p = $('#pill-engine'); p.classList.add('ok'); p.lastChild.textContent = engine.threads > 1 ? `stockfish ×${engine.threads}` : 'stockfish'; p.title = engine.threads > 1 ? `Stockfish 19 lite, ${engine.threads} threads` : 'Stockfish 19 lite, single thread'; });
  } catch (e) { $('#pill-engine').classList.add('err'); }
  modelReady = loadModel().then(() => $('#pill-model').classList.add('ok')).catch(() => { $('#pill-model').classList.add('err'); toast('Vision model failed to load'); });

  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/** Apply a pasted move list / PGN. Full games ("1. e4 …", PGN headers) start from the initial
 *  position (or the PGN's [FEN]); a bare list like "Nf3 d5 c4" continues from the current position. */
function importMoves(text) {
  const fenTag = text.match(/\[FEN\s+"([^"]+)"\]/);
  const fullGame = !!fenTag || /\[\w+\s+"/.test(text) || /^\s*1\.(?!\.)/.test(text);
  const body = text.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  let flat = body, prev; do { prev = flat; flat = flat.replace(/\([^()]*\)/g, ' '); } while (flat !== prev);
  const toks = flat.replace(/\$\d+/g, ' ').replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/)
    .map(t => t.replace(/[!?+#]+$/g, '').replace(/0/g, 'O')).filter(t => t && !/^(1-O|O-1|1\/2-1\/2|\*)$/.test(t));
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
  batching = false;
  if (!ok && fullGame) { Object.assign(S, snapshot); }
  S.lines = []; refresh();
  if (ok && autoOn()) analyse();
  return { ok, total: toks.length, bad };
}
function reportImport(r) {
  if (!r) return false;
  if (r.bad === 'position') toast('Could not set up the PGN start position');
  else if (r.bad) toast(`Played ${r.ok} move${r.ok === 1 ? '' : 's'} · stopped at "${r.bad}" (illegal here)`, 3500);
  else toast(`Played ${r.ok} move${r.ok === 1 ? '' : 's'} — step through with ← →`);
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
window.__augur = { S, scan, curFen };
