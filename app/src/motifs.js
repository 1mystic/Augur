// Tactical motif detection (layer 2): turns engine facts into named, checkable chess ideas.
// Everything here is plain board geometry on chess.js positions, so it is deterministic, offline and cheap.
// Each motif carries a short label (for chips) and a sentence (for the template explainer and the LLM prompt).
import { Chess } from 'chess.js';

const V = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const FILES = 'abcdefgh';
const DIRS = { b: [[1, 1], [1, -1], [-1, 1], [-1, -1]], r: [[1, 0], [-1, 0], [0, 1], [0, -1]] };
DIRS.q = [...DIRS.b, ...DIRS.r];
const other = c => (c === 'w' ? 'b' : 'w');
const at = (g, sq) => g.get(sq) || null;
const sqOf = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? FILES[f] + (r + 1) : null);
const xy = sq => [FILES.indexOf(sq[0]), +sq[1] - 1];
const piecesOf = (g, color) => {
  const out = [];
  g.board().forEach(row => row.forEach(p => { if (p && p.color === color) out.push(p); }));
  return out;
};
const named = (g, sq) => { const p = at(g, sq); return p ? `${NAME[p.type]} on ${sq}` : sq; };

function apply(fen, uci) {
  if (!uci) return null;
  try { const g = new Chess(fen); const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return { g, m }; } catch { return null; }
}
/** Attacked by the enemy and either undefended or attacked by something cheaper. */
function enPrise(g, sq) {
  const p = at(g, sq); if (!p || p.type === 'k') return false;
  const att = g.attackers(sq, other(p.color)); if (!att.length) return false;
  const cheapest = Math.min(...att.map(s => V[at(g, s).type]));
  return !g.attackers(sq, p.color).length || cheapest < V[p.type];
}
/** Valuable enemy pieces attacked by the piece on `sq`. */
function targetsOf(g, sq) {
  const p = at(g, sq); if (!p) return [];
  return piecesOf(g, other(p.color)).filter(t => g.attackers(t.square, p.color).includes(sq))
    .filter(t => t.type === 'k' || V[t.type] > V[p.type] || (V[t.type] >= 3 && !g.attackers(t.square, t.color).length));
}
function fork(g, sq) {
  const t = targetsOf(g, sq);
  return t.length >= 2 ? t.sort((a, b) => V[b.type] - V[a.type]) : null;
}
/** Pins and skewers created by a sliding piece on `sq`. */
function lines(g, sq) {
  const p = at(g, sq); if (!p || !DIRS[p.type]) return [];
  const out = [], [x0, y0] = xy(sq);
  for (const [dx, dy] of DIRS[p.type]) {
    const hit = [];
    for (let k = 1; k < 8 && hit.length < 2; k++) {
      const s = sqOf(x0 + dx * k, y0 + dy * k); if (!s) break;
      const q = at(g, s); if (q) hit.push({ ...q, square: s });
    }
    if (hit.length < 2 || hit[0].color === p.color || hit[1].color === p.color) continue;
    const [front, back] = hit;
    if (back.type === 'k' && front.type !== 'k') out.push({ kind: 'pin', front, back, absolute: true });
    else if (front.type !== 'k' && V[back.type] > V[front.type] && V[back.type] > V[p.type]) out.push({ kind: 'pin', front, back });
    else if ((front.type === 'k' || V[front.type] > V[back.type]) && V[back.type] >= 3) out.push({ kind: 'skewer', front, back });
  }
  return out;
}
/** Valuable enemy pieces newly attacked by a slider other than the one that moved (a discovered attack). */
function discovered(before, after, m) {
  const col = m.color, out = [];
  for (const t of piecesOf(after, other(col))) {
    if (t.type !== 'k' && V[t.type] < 3) continue;
    const was = new Set(before.attackers(t.square, col));
    for (const a of after.attackers(t.square, col)) {
      if (a === m.to || was.has(a)) continue;
      const ap = at(after, a); if (ap && DIRS[ap.type]) out.push({ by: { ...ap, square: a }, target: t });
    }
  }
  return out;
}
function kingZone(g, color) {
  const k = piecesOf(g, color).find(p => p.type === 'k'); if (!k) return { shield: 0, pressure: 0 };
  const [x, y] = xy(k.square), dir = color === 'w' ? 1 : -1;
  let shield = 0, pressure = 0;
  for (let dx = -1; dx <= 1; dx++) for (const dy of [dir, 2 * dir]) { const q = at(g, sqOf(x + dx, y + dy) || 'z9'); if (q && q.type === 'p' && q.color === color) shield++; }
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const s = sqOf(x + dx, y + dy); if (s && (dx || dy) && g.attackers(s, other(color)).length) pressure++; }
  return { shield, pressure };
}

/**
 * Detect motifs for one move.
 * @param e { fenBefore, fenAfter, uci (played), san, before, after } where before/after are engine summaries
 *          (cp/mate from the side to move, best move, lines with pv).
 * @returns [{ key, tone: 'good'|'bad'|'missed', label, text }] most important first
 */
export function detectMotifs(e) {
  const out = [], add = (key, tone, label, text) => out.push({ key, tone, label, text });
  const g0 = new Chess(e.fenBefore), mover = g0.turn();
  const played = apply(e.fenBefore, e.uci); if (!played) return out;
  const g1 = played.g, m = played.m;
  const bestUci = e.before?.best, isBest = bestUci === e.uci;
  const best = !isBest ? apply(e.fenBefore, bestUci) : null;
  const reply = apply(e.fenAfter, e.after?.best);
  const sanOf = x => x?.m?.san;

  // --- checkmates
  if (g1.isCheckmate()) { add('mate', 'good', 'Checkmate', `${m.san} is checkmate.`); return out; }
  const hadMate = e.before?.mate > 0, keepsMate = e.after?.mate < 0;
  if (hadMate && !keepsMate) add('missed-mate', 'missed', 'Missed mate', e.before.mate === 1 && best ? `There was mate in one with ${sanOf(best)}.` : `There was a forced mate in ${e.before.mate}${best ? ` starting with ${sanOf(best)}` : ''}.`);
  if (e.after?.mate > 0 && !(e.before?.mate < 0)) add('allows-mate', 'bad', 'Allows mate', `It allows a forced mate in ${e.after.mate}${reply ? `, starting with ${sanOf(reply)}` : ''}.`);

  // --- material: hanging pieces and missed captures
  if (reply?.m.captured) {
    const sq = reply.m.to, lost = at(g1, sq);
    if (lost && lost.color === mover && enPrise(g1, sq) && !isBest) add('hanging', 'bad', 'Hanging piece', `It leaves the ${NAME[lost.type]} on ${sq} unprotected, and ${sanOf(reply)} wins it.`);
  }
  if (!out.some(x => x.key === 'hanging') && !isBest) {
    const hung = piecesOf(g1, mover).filter(p => V[p.type] >= 3 && enPrise(g1, p.square)).sort((a, b) => V[b.type] - V[a.type])[0];
    if (hung && e.drop >= 5) add('hanging', 'bad', 'Hanging piece', `The ${NAME[hung.type]} on ${hung.square} is left en prise.`);
  }
  if (best?.m.captured && !m.captured && e.drop >= 5 && enPrise(g0, best.m.to)) {
    add('missed-capture', 'missed', 'Missed capture', `${sanOf(best)} would have won the ${NAME[best.m.captured]} on ${best.m.to}.`);
  }
  if (m.captured && enPrise(g0, m.to) && e.drop < 2) add('wins-material', 'good', 'Wins material', `${m.san} picks up the ${NAME[m.captured]}.`);

  // --- double attacks and line tactics, for the move played, the opponent's best reply, and the missed best move
  const tactic = (pos, mv, tone, who) => {
    if (!pos) return;
    const f = fork(pos.g, pos.m.to);
    if (f) add('fork', tone, 'Fork', `${who(pos.m.san)} forks the ${f.slice(0, 2).map(t => named(pos.g, t.square)).join(' and the ')}.`);
    for (const l of lines(pos.g, pos.m.to)) {
      if (l.kind === 'pin') add('pin', tone, 'Pin', `${who(pos.m.san)} pins the ${NAME[l.front.type]} on ${l.front.square} to the ${NAME[l.back.type]}${l.absolute ? ', so it cannot move' : ''}.`);
      else add('skewer', tone, 'Skewer', `${who(pos.m.san)} skewers the ${NAME[l.front.type]} on ${l.front.square} and the ${NAME[l.back.type]} behind it.`);
    }
    const before = tone === 'bad' ? g1 : g0;
    for (const d of discovered(before, pos.g, pos.m).slice(0, 1)) {
      add('discovered', tone, d.target.type === 'k' ? 'Discovered check' : 'Discovered attack', `${who(pos.m.san)} uncovers the ${NAME[d.by.type]} on ${d.by.square} against the ${named(pos.g, d.target.square)}.`);
    }
  };
  tactic(played, m, 'good', s => s);
  if (!isBest && e.drop >= 5) tactic(reply, reply?.m, 'bad', s => `It allows ${s}, which`);
  if (best && e.drop >= 5) tactic(best, best.m, 'missed', s => `${s} was available and`);

  // --- king safety (opening and middlegame only)
  const heavy = piecesOf(g0, other(mover)).filter(p => 'qr'.includes(p.type)).length;
  if (heavy) {
    const k0 = kingZone(g0, mover), k1 = kingZone(g1, mover);
    const castleBefore = g0.getCastlingRights(mover), castleAfter = g1.getCastlingRights(mover);
    const lostCastling = (castleBefore.k || castleBefore.q) && !castleAfter.k && !castleAfter.q && !m.flags.includes('k') && !m.flags.includes('q');
    if (m.flags.includes('k') || m.flags.includes('q')) add('castles', 'good', 'Castles', `${m.san} tucks the king into safety.`);
    else if (lostCastling && m.piece === 'k') add('king-safety', 'bad', 'King safety', 'Moving the king gives up the right to castle.');
    else if (m.piece === 'p' && k1.shield < k0.shield && e.drop >= 2) add('king-safety', 'bad', 'King safety', 'It weakens the pawn cover in front of the king.');
    else if (k1.pressure - k0.pressure >= 2 && e.drop >= 2) add('king-safety', 'bad', 'King safety', 'More enemy pieces now bear down on the squares around the king.');
  }

  // most important first, one entry per kind
  const rank = ['mate', 'missed-mate', 'allows-mate', 'hanging', 'missed-capture', 'fork', 'skewer', 'pin', 'discovered', 'wins-material', 'king-safety', 'castles'];
  const seen = new Set();
  return out.sort((a, b) => rank.indexOf(a.key) - rank.indexOf(b.key)).filter(x => !seen.has(x.key + x.tone) && seen.add(x.key + x.tone));
}
