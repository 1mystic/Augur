// Built-in fallback opponent: negamax + alpha-beta + quiescence on a material / piece-square evaluation.
// Used only when Stockfish cannot load or answer, so a game never stalls. Time-boxed, deterministic per level
// except for a small random window that keeps the weaker levels human-looking.
import { Chess } from 'chess.js';

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
// piece-square tables from White's point of view, a8 first (simplified evaluation function)
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
};
export const MINI_LEVELS = {
  easy: { depth: 1, window: 150, quiescence: false },
  intermediate: { depth: 2, window: 40, quiescence: true },
  expert: { depth: 3, window: 0, quiescence: true },
};
const MATE = 100000, ABORT = Symbol('abort');

/** Static evaluation from the side to move's point of view. */
function evaluate(g) {
  let s = 0;
  g.board().forEach((row, r) => row.forEach((sq, f) => {
    if (!sq) return;
    const v = VAL[sq.type] + PST[sq.type][sq.color === 'w' ? r * 8 + f : (7 - r) * 8 + f];
    s += sq.color === 'w' ? v : -v;
  }));
  return g.turn() === 'w' ? s : -s;
}
// MVV-LVA: promotions and valuable captures by cheap pieces first
const order = ms => ms.sort((a, b) => (b.promotion ? 1000 : 0) + (b.captured ? 10 * VAL[b.captured] - VAL[b.piece] / 10 : 0)
  - ((a.promotion ? 1000 : 0) + (a.captured ? 10 * VAL[a.captured] - VAL[a.piece] / 10 : 0)));

/** Best move for `fen` as a UCI string (e.g. "e2e4", "e7e8q"), or null when there is none. */
export function pickMove(fen, level = 'intermediate', budgetMs = 600, rng = Math.random) {
  const cfg = MINI_LEVELS[level] || MINI_LEVELS.intermediate, g = new Chess(fen);
  const rootMoves = order(g.moves({ verbose: true }));
  if (!rootMoves.length) return null;
  const uci = m => m.from + m.to + (m.promotion || '');
  if (rootMoves.length === 1) return uci(rootMoves[0]);
  const deadline = performance.now() + budgetMs;
  let nodes = 0;
  const tick = () => { if ((++nodes & 127) === 0 && performance.now() > deadline) throw ABORT; };

  function quiesce(alpha, beta, depth) {
    tick();
    const stand = evaluate(g);
    if (stand >= beta || depth === 0) return stand;
    if (stand > alpha) alpha = stand;
    for (const m of order(g.moves({ verbose: true }).filter(x => x.captured || x.promotion))) {
      g.move(m); const v = -quiesce(-beta, -alpha, depth - 1); g.undo();
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
  function search(depth, alpha, beta, ply) {
    tick();
    const ms = g.moves({ verbose: true });
    if (!ms.length) return g.inCheck() ? -MATE + ply : 0;
    if (g.isInsufficientMaterial() || g.isDrawByFiftyMoves()) return 0;
    if (depth === 0) return cfg.quiescence ? quiesce(alpha, beta, 4) : evaluate(g);
    let best = -Infinity;
    for (const m of order(ms)) {
      g.move(m); const v = -search(depth - 1, -beta, -alpha, ply + 1); g.undo();
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }
  // iterative deepening: keep the last fully searched depth if time runs out
  let scored = rootMoves.map(m => ({ m, v: 0 }));
  for (let d = 1; d <= cfg.depth; d++) {
    try {
      const next = [];
      for (const m of rootMoves) { g.move(m); next.push({ m, v: -search(d - 1, -Infinity, Infinity, 1) }); g.undo(); }
      scored = next;
    } catch (e) { if (e !== ABORT) throw e; while (g.history().length) g.undo(); break; }
  }
  const top = Math.max(...scored.map(x => x.v));
  const pool = scored.filter(x => x.v >= top - cfg.window);
  return uci(pool[Math.floor(rng() * pool.length)].m);
}
