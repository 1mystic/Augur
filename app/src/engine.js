// Stockfish (WASM, lite) wrapper. One instance = one worker.
// `multipv` lines for analysis; `single` forces the single-thread build (used by the bot).
/** Multi-threaded WASM needs cross-origin isolation, SharedArrayBuffer and enough memory for the shared heap.
 *  iOS and low-memory Android often fail that allocation silently, so they get the single-thread build. */
export function threadsSafe() {
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer !== 'function' || typeof Atomics !== 'object') return false;
  const mem = navigator.deviceMemory;
  return mem === undefined ? !/iPhone|iPad|iPod/.test(navigator.userAgent) : mem >= 4;
}

export class Engine {
  constructor({ multipv = 3, single = false, hash = 0 } = {}) {
    // multi-threaded build when the page is cross-origin isolated (native app, dev server, COOP/COEP hosts)
    const cores = navigator.hardwareConcurrency || 1;
    this.threads = !single && threadsSafe() && cores > 1 ? Math.min(4, Math.max(2, cores - 1)) : 1;
    this.multipv = multipv; this.options = {}; this.hash = hash;
    // `ready` rejects if the worker never answers (blocked download, crashed wasm…) so callers can fall back instead of waiting forever
    this.isReady = false; this.dead = false;
    this.ready = new Promise((res, rej) => { this._onReady = res; this._onFail = rej; });
    this.ready.catch(() => {});
    this._loadTimer = setTimeout(() => this._fail('engine did not load'), 20000);
    this.searching = false; this.pending = null; this.lines = []; this.cb = null;
    this._boot();
  }
  _boot() {
    this.w = new Worker(this.threads > 1 ? './engine/stockfish-19-lite.js' : './engine/stockfish-19-lite-single.js');
    this.w.onmessage = e => this._line(String(e.data));
    this.w.onerror = () => { if (this.threads > 1) { this.w.terminate(); this.threads = 1; this._boot(); } else this._fail('engine crashed'); };
    this.w.postMessage('uci');
    if (this.threads > 1) this.w.postMessage('setoption name Threads value ' + this.threads);
    this.w.postMessage('setoption name Hash value ' + (this.hash || (this.threads > 1 ? 64 : 32)));
    this.w.postMessage('setoption name MultiPV value ' + this.multipv);
    for (const [k, v] of Object.entries(this.options)) this.w.postMessage(`setoption name ${k} value ${v}`);
    this.w.postMessage('isready');
  }
  _fail(reason) {
    if (this.dead) return;
    this.dead = true; clearTimeout(this._loadTimer); this._onFail(new Error(reason));
    const cb = this.cb; this.cb = null; this.searching = false; this.pending = null;
    try { this.w.terminate(); } catch { /* already gone */ }
    if (cb) cb(this.lines.filter(Boolean), true, null, true);
  }
  /** UCI options such as {'Skill Level': 3, UCI_LimitStrength: true, UCI_Elo: 1500}. Applied between searches. */
  async setOptions(opts) {
    try { await this.ready; } catch { return; }
    for (const [k, v] of Object.entries(opts)) { this.options[k] = v; this.w.postMessage(`setoption name ${k} value ${v}`); }
  }
  _line(l) {
    if (l === 'readyok') { if (!this.isReady) { this.isReady = true; clearTimeout(this._loadTimer); this._onReady(); } return; }
    if (l.startsWith('info') && l.includes(' pv ') && this.searching) {
      const g = k => { const m = l.match(new RegExp(` ${k} (\\S+)`)); return m && m[1]; };
      const mpv = +(g('multipv') || 1), depth = +g('depth');
      const sc = l.match(/score (cp|mate) (-?\d+)/);
      if (!sc) return;
      const pv = l.split(' pv ')[1].trim().split(' ');
      this.lines[mpv - 1] = { depth, type: sc[1], value: +sc[2], pv };
      if (this.early && mpv === 1) this._maybeStop(depth, sc[1], +sc[2], pv[0]);
      this.cb && this.cb(this.lines.filter(Boolean), false);
    } else if (l.startsWith('bestmove')) {
      const wasSearching = this.searching; this.searching = false;
      const best = l.split(' ')[1];
      if (wasSearching && this.cb && !this.pending) this.cb(this.lines.filter(Boolean), true, best === '(none)' ? null : best);
      if (this.pending) { const p = this.pending; this.pending = null; this._start(p); }
    }
  }
  /** Iterative-deepening early exit: stop once the best move and score have been stable for `n` depths. */
  _maybeStop(depth, type, value, move) {
    const e = this.early, h = this.hist;
    if (!h.length || h[h.length - 1].depth !== depth) h.push({ depth, move, score: type === 'mate' ? value * 1000 : value });
    else Object.assign(h[h.length - 1], { move, score: type === 'mate' ? value * 1000 : value });
    if (depth < e.min || h.length < e.n) return;
    const tail = h.slice(-e.n);
    if (tail.every(x => x.move === tail[0].move) && Math.max(...tail.map(x => x.score)) - Math.min(...tail.map(x => x.score)) <= e.tol) { this.early = null; this.w.postMessage('stop'); }
  }
  _start({ fen, go, cb, early }) {
    this.lines = []; this.cb = cb; this.searching = true; this.early = early || null; this.hist = [];
    this.w.postMessage('position fen ' + fen);
    this.w.postMessage('go ' + go);
  }
  /** `limit` is a think time in ms, or a raw UCI go string such as "depth 6 movetime 400". */
  /** cb(lines, done, bestmove, failed): `failed` is true when the engine is unusable. */
  async analyse(fen, limit, cb, early) {
    try { await this.ready; } catch { cb(this.lines.filter(Boolean), true, null, true); return; }
    if (this.dead) { cb([], true, null, true); return; }
    const job = { fen, go: typeof limit === 'number' ? 'movetime ' + limit : limit, cb, early };
    if (this.searching) { this.pending = job; this.w.postMessage('stop'); }
    else this._start(job);
  }
  terminate() { this.cb = null; this.pending = null; this.dead = true; clearTimeout(this._loadTimer); this.w.terminate(); }
  stop() { this.pending = null; if (this.searching) { this.cb = null; this.w.postMessage('stop'); } }
}
