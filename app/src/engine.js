// Stockfish (WASM, lite single-thread) wrapper with MultiPV top-N lines.
export class Engine {
  constructor() {
    // multi-threaded build when the page is cross-origin isolated (native app, dev server, COOP/COEP hosts)
    const cores = navigator.hardwareConcurrency || 1;
    this.threads = self.crossOriginIsolated && cores > 1 ? Math.min(8, Math.max(2, cores - 1)) : 1;
    this.ready = new Promise(res => (this._onReady = res));
    this.searching = false; this.pending = null; this.lines = []; this.cb = null;
    this._boot();
  }
  _boot() {
    this.w = new Worker(this.threads > 1 ? './engine/stockfish-19-lite.js' : './engine/stockfish-19-lite-single.js');
    this.w.onmessage = e => this._line(String(e.data));
    this.w.onerror = () => { if (this.threads > 1) { this.w.terminate(); this.threads = 1; this._boot(); } };
    this.w.postMessage('uci');
    if (this.threads > 1) this.w.postMessage('setoption name Threads value ' + this.threads);
    this.w.postMessage('setoption name Hash value ' + (this.threads > 1 ? 64 : 32));
    this.w.postMessage('setoption name MultiPV value 3');
    this.w.postMessage('isready');
  }
  _line(l) {
    if (l === 'readyok') { this._onReady(); return; }
    if (l.startsWith('info') && l.includes(' pv ') && this.searching) {
      const g = k => { const m = l.match(new RegExp(` ${k} (\\S+)`)); return m && m[1]; };
      const mpv = +(g('multipv') || 1), depth = +g('depth');
      const sc = l.match(/score (cp|mate) (-?\d+)/);
      const pv = l.split(' pv ')[1].trim().split(' ');
      this.lines[mpv - 1] = { depth, type: sc[1], value: +sc[2], pv };
      this.cb && this.cb(this.lines.filter(Boolean), false);
    } else if (l.startsWith('bestmove')) {
      const wasSearching = this.searching; this.searching = false;
      if (wasSearching && this.cb && !this.pending) this.cb(this.lines.filter(Boolean), true);
      if (this.pending) { const p = this.pending; this.pending = null; this._start(p); }
    }
  }
  _start({ fen, ms, cb }) {
    this.lines = []; this.cb = cb; this.searching = true;
    this.w.postMessage('position fen ' + fen);
    this.w.postMessage('go movetime ' + ms);
  }
  async analyse(fen, ms, cb) {
    await this.ready;
    const job = { fen, ms, cb };
    if (this.searching) { this.pending = job; this.w.postMessage('stop'); }
    else this._start(job);
  }
  stop() { this.pending = null; if (this.searching) { this.cb = null; this.w.postMessage('stop'); } }
}
