// Pure helpers shared by Tutor and Game-review: eval maths, move classification, accuracy, opening names.
import { Chess } from 'chess.js';

/** Stockfish line -> centipawns from the side to move's point of view (mates clamp to ±10000). */
export function lineCp(l) {
  if (l.type === 'mate') return Math.sign(l.value || 1) * (10000 - Math.min(Math.abs(l.value), 100) * 50);
  return l.value;
}
/** Lichess win-probability curve, 0..100 for the side whose cp is given. */
export const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
/** Per-move accuracy from the win-% the mover gave away. */
export const moveAccuracy = drop => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));

/** Evaluation of a position without the engine when the game is already over (null otherwise). */
export function terminalEval(fen) {
  const g = new Chess(fen);
  if (g.isCheckmate()) return { cp: -10000, mate: 0, lines: [], best: null, terminal: true };
  if (g.isGameOver()) return { cp: 0, lines: [], best: null, terminal: true };
  return null;
}
/** Turn raw engine lines for `fen` into {cp (side to move), lines, best, gap}. */
export function summarise(fen, lines) {
  const t = terminalEval(fen); if (t) return t;
  const ls = (lines || []).filter(Boolean);
  if (!ls.length) return { cp: 0, lines: [], best: null, gap: 0 };
  const top = lineCp(ls[0]);
  const gap = ls[1] ? winPct(top) - winPct(lineCp(ls[1])) : 0;
  return { cp: top, lines: ls, best: ls[0].pv[0], gap, mate: ls[0].type === 'mate' ? ls[0].value : undefined };
}

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
function balance(fen, color) {
  let me = 0, them = 0;
  for (const row of new Chess(fen).board()) for (const sq of row) if (sq && sq.type !== 'k') (sq.color === color ? (me += VAL[sq.type]) : (them += VAL[sq.type]));
  return me - them;
}
/** True when `mover` gives up material that is not won back by the opponent's best reply. */
export function isSacrifice(fenBefore, fenAfter, mover, reply) {
  try {
    const before = balance(fenBefore, mover);
    const g = new Chess(fenAfter);
    if (reply) g.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
    return balance(g.fen(), mover) <= before - 2;
  } catch { return false; }
}

export const CLASSES = {
  brilliant: { label: 'Brilliant', glyph: '!!', color: '#1baca6' },
  great: { label: 'Great', glyph: '!', color: '#5c8bb0' },
  best: { label: 'Best', glyph: '★', color: '#7fb13a' },
  excellent: { label: 'Excellent', glyph: '✓', color: '#8cc152' },
  good: { label: 'Good', glyph: '✓', color: '#9fb88a' },
  book: { label: 'Book', glyph: '≡', color: '#a88865' },
  inaccuracy: { label: 'Inaccuracy', glyph: '?!', color: '#f0b429' },
  mistake: { label: 'Mistake', glyph: '?', color: '#e58f2a' },
  miss: { label: 'Miss', glyph: '✕', color: '#e0693f' },
  blunder: { label: 'Blunder', glyph: '??', color: '#ca3431' },
};
export const CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

/**
 * Judge one move.
 * @param before  summarise() of the position before the move (side to move = mover)
 * @param after   summarise() of the position after the move (side to move = opponent)
 */
export function judge({ before, after, uci, fenBefore, fenAfter, mover, prevCls, book }) {
  const wpBefore = winPct(before.cp);
  const wpAfter = winPct(-after.cp);
  const drop = Math.max(0, wpBefore - wpAfter);
  const isBest = !!before.best && uci === before.best;
  let cls;
  if (book) cls = 'book';
  else if (isBest && wpAfter >= 50 && wpBefore < 92 && isSacrifice(fenBefore, fenAfter, mover, after.best)) cls = 'brilliant';
  else if (isBest && before.gap >= 12 && wpBefore < 90 && wpBefore > 8) cls = 'great';
  else if (isBest || drop < 0.5) cls = 'best';
  else if (drop < 2) cls = 'excellent';
  else if (drop < 5) cls = 'good';
  else if (drop < 10) cls = 'inaccuracy';
  else if (drop < 20) cls = prevCls && ['mistake', 'blunder', 'miss'].includes(prevCls) && wpBefore >= 65 ? 'miss' : 'mistake';
  else cls = 'blunder';
  return { cls, drop, wpBefore, wpAfter, isBest, acc: moveAccuracy(drop) };
}

/** Display score from White's point of view, e.g. "+0.35", "-1.2", "#3". `cp`/`mate` are for the side to move. */
export function fmtWhite(ev, turn) {
  const sgn = turn === 'w' ? 1 : -1;
  if (ev.mate !== undefined && ev.mate !== null) { const m = ev.mate * sgn; return ev.terminal ? (turn === 'w' ? '0-1' : '1-0') : (m > 0 ? '#' : '-#') + Math.abs(m); }
  const v = ev.cp * sgn / 100;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}
export const whiteWin = (ev, turn) => winPct(ev.cp * (turn === 'w' ? 1 : -1));

// A compact opening book: enough to mark theory moves and name the opening.
const OPENINGS = [
  ['King\'s Pawn Game', 'e4'], ['Queen\'s Pawn Game', 'd4'], ['English Opening', 'c4'], ['Réti Opening', 'Nf3'],
  ['Open Game', 'e4 e5'], ['King\'s Knight Opening', 'e4 e5 Nf3'],
  ['Ruy Lopez', 'e4 e5 Nf3 Nc6 Bb5'], ['Ruy Lopez: Morphy Defense', 'e4 e5 Nf3 Nc6 Bb5 a6'], ['Ruy Lopez: Berlin Defense', 'e4 e5 Nf3 Nc6 Bb5 Nf6'],
  ['Italian Game', 'e4 e5 Nf3 Nc6 Bc4'], ['Italian Game: Giuoco Piano', 'e4 e5 Nf3 Nc6 Bc4 Bc5'], ['Italian Game: Two Knights Defense', 'e4 e5 Nf3 Nc6 Bc4 Nf6'],
  ['Scotch Game', 'e4 e5 Nf3 Nc6 d4'], ['Four Knights Game', 'e4 e5 Nf3 Nc6 Nc3 Nf6'], ['Petrov\'s Defense', 'e4 e5 Nf3 Nf6'], ['Philidor Defense', 'e4 e5 Nf3 d6'],
  ['King\'s Gambit', 'e4 e5 f4'], ['Vienna Game', 'e4 e5 Nc3'], ['Bishop\'s Opening', 'e4 e5 Bc4'],
  ['Sicilian Defense', 'e4 c5'], ['Sicilian Defense: Open', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3'], ['Sicilian Defense: Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'],
  ['Sicilian Defense: Dragon', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6'], ['Sicilian Defense: Classical', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 d6'],
  ['Sicilian Defense: Sveshnikov', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5'], ['Sicilian Defense: Alapin', 'e4 c5 c3'], ['Sicilian Defense: Closed', 'e4 c5 Nc3'],
  ['French Defense', 'e4 e6'], ['French Defense: Advance', 'e4 e6 d4 d5 e5'], ['French Defense: Winawer', 'e4 e6 d4 d5 Nc3 Bb4'], ['French Defense: Tarrasch', 'e4 e6 d4 d5 Nd2'], ['French Defense: Exchange', 'e4 e6 d4 d5 exd5'],
  ['Caro-Kann Defense', 'e4 c6'], ['Caro-Kann Defense: Advance', 'e4 c6 d4 d5 e5'], ['Caro-Kann Defense: Classical', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5'],
  ['Scandinavian Defense', 'e4 d5'], ['Scandinavian Defense: Main Line', 'e4 d5 exd5 Qxd5 Nc3 Qa5'], ['Pirc Defense', 'e4 d6 d4 Nf6 Nc3 g6'], ['Alekhine\'s Defense', 'e4 Nf6'], ['Modern Defense', 'e4 g6'],
  ['Queen\'s Gambit', 'd4 d5 c4'], ['Queen\'s Gambit Accepted', 'd4 d5 c4 dxc4'], ['Queen\'s Gambit Declined', 'd4 d5 c4 e6'], ['Slav Defense', 'd4 d5 c4 c6'], ['Semi-Slav Defense', 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6'],
  ['Queen\'s Gambit Declined: Orthodox', 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7'], ['London System', 'd4 d5 Bf4'], ['London System', 'd4 Nf6 Bf4'], ['Colle System', 'd4 d5 Nf3 Nf6 e3'],
  ['Indian Defense', 'd4 Nf6'], ['King\'s Indian Defense', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6'], ['Grünfeld Defense', 'd4 Nf6 c4 g6 Nc3 d5'], ['Nimzo-Indian Defense', 'd4 Nf6 c4 e6 Nc3 Bb4'],
  ['Queen\'s Indian Defense', 'd4 Nf6 c4 e6 Nf3 b6'], ['Catalan Opening', 'd4 Nf6 c4 e6 g3'], ['Dutch Defense', 'd4 f5'], ['Benoni Defense', 'd4 Nf6 c4 c5 d5'], ['Trompowsky Attack', 'd4 Nf6 Bg5'],
  ['English Opening: Symmetrical', 'c4 c5'], ['English Opening: Reversed Sicilian', 'c4 e5'], ['Réti Opening: Main', 'Nf3 d5 c4'], ['King\'s Indian Attack', 'Nf3 d5 g3'],
  ['Bird\'s Opening', 'f4'], ['Polish Opening', 'b4'], ['Larsen\'s Opening', 'b3'],
].map(([name, line]) => ({ name, sans: line.split(' ') }));
const maxLen = Math.max(...OPENINGS.map(o => o.sans.length));

/** Longest known opening that the played SAN list starts with (or null). */
export function openingName(sans) {
  let best = null;
  for (const o of OPENINGS) if (o.sans.length <= sans.length && o.sans.every((m, i) => m === sans[i]) && (!best || o.sans.length >= best.sans.length)) best = o;
  return best?.name || null;
}
/** Is this ply (1-based) still inside a known line? */
export function inBook(sans, ply) {
  if (ply > maxLen) return false;
  const p = sans.slice(0, ply);
  return OPENINGS.some(o => o.sans.length >= ply && p.every((m, i) => m === o.sans[i]));
}
