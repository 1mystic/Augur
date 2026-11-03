// Minimal interactive board: click-click or drag to move, edit mode, SVG arrows.
const FILES = 'abcdefgh';
export const pieceSrc = p => `./pieces/${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}.svg`;

export class Board {
  constructor(el, handlers) {
    this.el = el; this.h = handlers;
    this.state = { pieces: {}, orientation: 'w', legal: () => [], lastMove: null, check: null, arrows: [], badge: null, edit: false, uncertain: new Set() };
    this.sel = null; this.drag = null;
    el.classList.add('board');
    el.innerHTML = '<div class="squares"></div><div class="pieces"></div><svg class="arrows" viewBox="0 0 800 800"></svg><div class="promo hidden"></div>';
    this.sqEl = el.querySelector('.squares'); this.pcEl = el.querySelector('.pieces');
    this.arEl = el.querySelector('.arrows'); this.promoEl = el.querySelector('.promo');
    for (let i = 0; i < 64; i++) { const d = document.createElement('div'); this.sqEl.appendChild(d); }
    // keep it square even where aspect-ratio + grid stretch misbehave (older WebKitGTK)
    const sq = () => { const w = el.getBoundingClientRect().width; if (w && Math.abs(el.offsetHeight - w) > 1) el.style.height = w + 'px'; };
    new ResizeObserver(sq).observe(el); sq();
    el.addEventListener('pointerdown', e => this._down(e));
    window.addEventListener('pointermove', e => this._move(e));
    window.addEventListener('pointerup', e => this._up(e));
    el.addEventListener('contextmenu', e => { e.preventDefault(); if (this.state.edit) this.h.onEdit(this._sqAt(e), 'erase'); });
  }
  set(patch) { Object.assign(this.state, patch); this.render(); }
  _xy(sq) { // square -> [col,row] on screen
    const f = FILES.indexOf(sq[0]), r = +sq[1] - 1;
    return this.state.orientation === 'w' ? [f, 7 - r] : [7 - f, r];
  }
  _sq(c, r) { return this.state.orientation === 'w' ? FILES[c] + (8 - r) : FILES[7 - c] + (r + 1); }
  _sqAt(e) {
    const b = this.el.getBoundingClientRect();
    const c = Math.floor((e.clientX - b.left) / b.width * 8), r = Math.floor((e.clientY - b.top) / b.height * 8);
    if (c < 0 || c > 7 || r < 0 || r > 7) return null;
    return this._sq(c, r);
  }
  render() {
    const s = this.state, targets = this.sel ? s.legal(this.sel) : [];
    [...this.sqEl.children].forEach((d, i) => {
      const c = i % 8, r = i >> 3, sq = this._sq(c, r);
      const light = (FILES.indexOf(sq[0]) + +sq[1]) % 2 === 1;
      let cls = light ? 'sq l' : 'sq d';
      if (s.lastMove && (s.lastMove.from === sq || s.lastMove.to === sq)) cls += ' last';
      if (this.sel === sq) cls += ' sel';
      if (s.check === sq) cls += ' check';
      if (s.uncertain.has(sq)) cls += ' unsure';
      const t = targets.find(m => m.to === sq);
      if (t) cls += s.pieces[sq] ? ' cap' : ' dot';
      d.className = cls;
      const key = (r === 7 ? sq[0] : '') + '|' + (c === 0 ? sq[1] : '');
      if (d._k !== key) { d._k = key; d.innerHTML = (r === 7 ? `<span class="cf">${sq[0]}</span>` : '') + (c === 0 ? `<span class="cr">${sq[1]}</span>` : ''); }
    });
    this.pcEl.innerHTML = '';
    for (const [sq, p] of Object.entries(s.pieces)) {
      const [c, r] = this._xy(sq), img = document.createElement('img');
      img.src = pieceSrc(p); img.draggable = false; img.className = 'pc';
      img.style.transform = `translate(${c * 100}%, ${r * 100}%)`; img.dataset.sq = sq;
      if (this.drag && this.drag.sq === sq && this.drag.moved) img.classList.add('ghost');
      this.pcEl.appendChild(img);
    }
    if (this.drag && this.drag.moved) {
      const img = document.createElement('img'); img.src = pieceSrc(s.pieces[this.drag.sq]); img.className = 'pc floating';
      img.style.left = this.drag.x + 'px'; img.style.top = this.drag.y + 'px'; this.pcEl.appendChild(img); this.drag.img = img;
    }
    this.arEl.innerHTML = s.arrows.map(a => this._arrow(a)).join('') + this._badge(s.badge);
  }
  _badge(bd) {
    if (!bd) return '';
    const [c, r] = this._xy(bd.sq), x = c * 100 + 84, y = r * 100 + 16;
    return `<g><circle cx="${x}" cy="${y}" r="17" fill="${bd.color}" stroke="#fff" stroke-width="2.5"/><text x="${x}" y="${y + 6}" text-anchor="middle" font-size="${bd.glyph.length > 1 ? 16 : 20}" font-weight="800" fill="#fff" font-family="system-ui,sans-serif">${bd.glyph}</text></g>`;
  }
  _arrow({ from, to, color, width, label }) {
    const [c1, r1] = this._xy(from), [c2, r2] = this._xy(to);
    const x1 = c1 * 100 + 50, y1 = r1 * 100 + 50, x2 = c2 * 100 + 50, y2 = r2 * 100 + 50;
    const ang = Math.atan2(y2 - y1, x2 - x1), hl = width * 2.4, ex = x2 - Math.cos(ang) * hl * .8, ey = y2 - Math.sin(ang) * hl * .8;
    const p = (a, d) => `${x2 - Math.cos(ang - a) * d},${y2 - Math.sin(ang - a) * d}`;
    const sx = x1 + Math.cos(ang) * 22, sy = y1 + Math.sin(ang) * 22;
    return `<g opacity=".85"><line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>
      <polygon points="${x2},${y2} ${p(.5, hl)} ${p(-.5, hl)}" fill="${color}"/>
      ${label ? `<circle cx="${x2 - Math.cos(ang) * hl * 1.6}" cy="${y2 - Math.sin(ang) * hl * 1.6}" r="15" fill="${color}"/><text x="${x2 - Math.cos(ang) * hl * 1.6}" y="${y2 - Math.sin(ang) * hl * 1.6 + 6}" text-anchor="middle" font-size="18" font-weight="700" fill="#fff">${label}</text>` : ''}</g>`;
  }
  _down(e) {
    if (e.button !== 0) return;
    const sq = this._sqAt(e); if (!sq) return;
    const s = this.state;
    if (s.edit) {
      if (s.pieces[sq] && !this.h.editTool()) { this.drag = { sq, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false }; return; }
      this.h.onEdit(sq, 'place'); return;
    }
    if (this.sel && this.sel !== sq && s.legal(this.sel).some(m => m.to === sq)) { this._try(this.sel, sq); return; }
    if (s.pieces[sq] && s.legal(sq).length) {
      this.sel = sq; this.drag = { sq, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
    } else this.sel = null;
    this.render();
  }
  _move(e) {
    if (!this.drag) return;
    this.drag.x = e.clientX; this.drag.y = e.clientY;
    if (!this.drag.moved && Math.hypot(e.clientX - this.drag.sx, e.clientY - this.drag.sy) > 4) { this.drag.moved = true; this.render(); }
    if (this.drag.img) { this.drag.img.style.left = e.clientX + 'px'; this.drag.img.style.top = e.clientY + 'px'; }
  }
  _up(e) {
    if (!this.drag) return;
    const d = this.drag; this.drag = null;
    const to = this._sqAt(e);
    if (d.moved) {
      if (this.state.edit) { this.h.onEdit(d.sq, 'move', to); }
      else if (to && to !== d.sq) this._try(d.sq, to);
    }
    this.render();
  }
  _try(from, to) {
    const moves = this.state.legal(from).filter(m => m.to === to);
    this.sel = null;
    if (!moves.length) { this.render(); return; }
    if (moves.length > 1 || moves[0].promotion) this._promo(from, to, moves[0].color);
    else this.h.onMove(from, to);
  }
  _promo(from, to, color) {
    const el = this.promoEl; el.classList.remove('hidden');
    el.innerHTML = 'qrbn'.split('').map(p => `<button data-p="${p}"><img src="${pieceSrc(color === 'w' ? p.toUpperCase() : p)}"></button>`).join('');
    el.onclick = ev => { const b = ev.target.closest('button'); if (!b) return; el.classList.add('hidden'); this.h.onMove(from, to, b.dataset.p); };
  }
}
