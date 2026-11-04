// Pure helpers for saved games: replaying moves, PGN export / import, record normalisation.
import { Chess } from 'chess.js';
import { openingName } from './coach.js';
import { newId } from './store.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const MODES = {
  analysis: { label: 'Analyse', color: 'var(--blue)' }, pvp: { label: 'PvP', color: 'var(--sage)' }, bot: { label: 'Bot', color: 'var(--amber)' },
  tutor: { label: 'Tutor', color: 'var(--violet)' }, review: { label: 'Review', color: 'var(--rose)' }, imported: { label: 'Imported', color: 'var(--muted)' },
};

/** Moves as stored: just enough to replay them. */
export const compact = moves => moves.map(m => ({ san: m.san, from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) }));

/** Replay stored moves into full moves (with FENs). Stops at the first illegal move. */
export function hydrate(startFen, moves) {
  const g = new Chess(startFen), out = [];
  for (const m of moves) {
    try { const mv = g.move({ from: m.from, to: m.to, promotion: m.promotion }); out.push({ san: mv.san, from: mv.from, to: mv.to, promotion: mv.promotion, fen: g.fen() }); } catch { break; }
  }
  return out;
}
/** '1-0' / '0-1' / '1/2-1/2' / '*'. `flagged` is the colour that ran out of time, if any. */
export function resultOf(fen, flagged) {
  if (flagged) return flagged === 'w' ? '0-1' : '1-0';
  const g = new Chess(fen);
  if (g.isCheckmate()) return g.turn() === 'w' ? '0-1' : '1-0';
  return g.isDraw() || g.isStalemate() ? '1/2-1/2' : '*';
}
export const sansOf = moves => moves.map(m => m.san);
export const openingOf = (startFen, moves) => (startFen === START_FEN ? openingName(sansOf(moves).slice(0, 24)) : null);

export function titleOf(rec) {
  const named = rec.white && rec.black && !(rec.white === 'White' && rec.black === 'Black');
  if (named) return `${rec.white} vs ${rec.black}`;
  return { analysis: 'Analysis', pvp: 'Player vs Player', bot: 'Game vs the bot', tutor: 'Tutor lesson', review: 'Reviewed game', imported: 'Imported game' }[rec.mode] || 'Game';
}

const EVENT = { analysis: 'Augur analysis', pvp: 'Augur casual game', bot: 'Augur vs bot', tutor: 'Augur tutor lesson', review: 'Augur review', imported: 'Augur import' };
const q = v => String(v).replace(/\\/g, '').replace(/"/g, "'");
/** Standard PGN (seven tag roster, 80 column movetext) for a saved game. */
export function pgnOf(rec) {
  const d = new Date(rec.created || Date.now()), pad = n => String(n).padStart(2, '0');
  const h = rec.headers || {};
  const tags = {
    Event: h.Event || EVENT[rec.mode] || 'Augur game', Site: h.Site || 'Augur', Date: h.Date || `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`, Round: h.Round || '-',
    White: rec.white || h.White || 'White', Black: rec.black || h.Black || 'Black', Result: rec.result || '*',
  };
  for (const k of ['WhiteElo', 'BlackElo', 'ECO', 'Opening', 'TimeControl', 'Termination']) if (h[k]) tags[k] = h[k];
  if (!tags.Opening && rec.opening) tags.Opening = rec.opening;
  if (rec.startFen !== START_FEN) { tags.SetUp = '1'; tags.FEN = rec.startFen; }
  const head = Object.entries(tags).map(([k, v]) => `[${k} "${q(v)}"]`).join('\n');
  const parts = [], f = rec.startFen.split(' ');
  let num = +f[5] || 1, black = f[1] === 'b';
  rec.moves.forEach((m, i) => { if (!black) parts.push(`${num}.`); else if (i === 0) parts.push(`${num}...`); parts.push(m.san); if (black) num++; black = !black; });
  parts.push(tags.Result);
  const lines = []; let cur = '';
  for (const p of parts) { if (cur && (cur + ' ' + p).length > 79) { lines.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; }
  if (cur) lines.push(cur);
  return `${head}\n\n${lines.join('\n')}\n`;
}

/** A multi-game PGN text -> { games: [{headers, startFen, moves, result}], failed }. */
export function parsePgnGames(text) {
  const chunks = text.replace(/\r/g, '').split(/\n\s*\n(?=\[Event )/).map(s => s.trim()).filter(Boolean);
  const games = []; let failed = 0;
  for (const c of chunks) {
    try {
      const g = new Chess(); g.loadPgn(c);
      const hist = g.history({ verbose: true });
      if (!hist.length) { failed++; continue; }
      const headers = g.getHeaders();
      games.push({ headers, startFen: hist[0].before, moves: compact(hist.map(m => ({ san: m.san, from: m.from, to: m.to, promotion: m.promotion }))), result: headers.Result });
    } catch { failed++; }
  }
  return { games, failed };
}

/** Build a history record from a parsed PGN game. */
export function recordFromPgn(g) {
  const now = Date.now(), moves = hydrate(g.startFen, g.moves);
  if (!moves.length) return null;
  const h = g.headers || {}, last = moves[moves.length - 1].fen;
  const result = h.Result && h.Result !== '*' ? h.Result : resultOf(last);
  return { id: newId(), created: now, updated: now, mode: 'imported', source: 'imported', startFen: g.startFen, finalFen: last, moves: compact(moves), ply: moves.length, result,
    white: h.White && h.White !== '?' ? h.White : 'White', black: h.Black && h.Black !== '?' ? h.Black : 'Black', opening: h.Opening || openingOf(g.startFen, moves) || null,
    event: h.Event || null, headers: pick(h, ['Event', 'Site', 'Date', 'Round', 'WhiteElo', 'BlackElo', 'ECO', 'Opening', 'TimeControl', 'Termination']), settings: null, review: null };
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] && o[k] !== '?').map(k => [k, o[k]]));

/** Validate an untrusted record (from a JSON import): replays the moves, drops anything illegal. */
export function normalizeRecord(raw) {
  try {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.moves)) return null;
    const startFen = typeof raw.startFen === 'string' ? raw.startFen : START_FEN;
    new Chess(startFen);
    const moves = hydrate(startFen, raw.moves.filter(m => m && typeof m.from === 'string' && typeof m.to === 'string'));
    if (!moves.length) return null;
    const now = Date.now(), mode = MODES[raw.mode] ? raw.mode : 'imported';
    const str = v => (typeof v === 'string' ? v.slice(0, 120) : null);
    return { id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : newId(), created: +raw.created || now, updated: +raw.updated || now, mode, source: raw.source === 'played' ? 'played' : 'imported',
      startFen, finalFen: moves[moves.length - 1].fen, moves: compact(moves), ply: Math.min(+raw.ply || moves.length, moves.length), result: ['1-0', '0-1', '1/2-1/2', '*'].includes(raw.result) ? raw.result : resultOf(moves[moves.length - 1].fen),
      white: str(raw.white) || 'White', black: str(raw.black) || 'Black', opening: str(raw.opening) || openingOf(startFen, moves), event: str(raw.event),
      headers: raw.headers && typeof raw.headers === 'object' ? pick(raw.headers, ['Event', 'Site', 'Date', 'Round', 'WhiteElo', 'BlackElo', 'ECO', 'Opening', 'TimeControl', 'Termination']) : {},
      settings: raw.settings && typeof raw.settings === 'object' ? { level: str(raw.settings.level), human: raw.settings.human === 'b' ? 'b' : 'w' } : null,
      review: raw.review && typeof raw.review === 'object' && isFinite(raw.review.w) && isFinite(raw.review.b) ? { w: +raw.review.w, b: +raw.review.b } : null };
  } catch { return null; }
}
