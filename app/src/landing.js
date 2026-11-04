import '@fontsource-variable/outfit';
import '@fontsource-variable/jetbrains-mono';
import './landing.css';

// old share links pointed at the site root: forward them to the app
if (/[#&](moves|pgn)=/.test(location.hash)) location.replace('./app.html' + location.hash);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- theme toggle (shares the app's saved choice) ----------
const root = document.documentElement;
const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
const paintTheme = () => $('#theme use').setAttribute('href', isDark() ? '#i-sun' : '#i-moon');
$('#theme').addEventListener('click', () => {
  const t = isDark() ? 'light' : 'dark';
  root.dataset.theme = t;
  try { localStorage.setItem('augur:theme', JSON.stringify(t)); } catch { /* private mode */ }
  paintTheme();
});
paintTheme();

// ---------- nav: glass background after scrolling ----------
const nav = $('#nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 12);
addEventListener('scroll', onScroll, { passive: true }); onScroll();

// ---------- scroll reveal + count-up ----------
function countUp(el) {
  const to = parseFloat(el.dataset.count), dec = +(el.dataset.dec || 0), pre = el.dataset.prefix || '', suf = el.dataset.suffix || '';
  if (reduce) { el.textContent = pre + to.toFixed(dec) + suf; return; }
  const t0 = performance.now(), dur = 1400;
  const tick = now => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = pre + (to * e).toFixed(dec) + suf;
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in'); io.unobserve(e.target);
    $$('[data-count]', e.target).forEach(countUp);
    if (e.target.matches('[data-count]')) countUp(e.target);
  }
}, { threshold: 0.18, rootMargin: '0px 0px -6% 0px' });
$$('.rv, .steps').forEach(el => io.observe(el));

// ---------- hero: an animated game with Augur's grades ----------
const FILES = 'abcdefgh';
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const GAME = [
  { m: ['e2', 'e4'], san: '1. e4', g: 'Book', c: 'var(--amber)', ev: '+0.3', o: 'King\'s Pawn Game' },
  { m: ['e7', 'e5'], san: '1... e5', g: 'Book', c: 'var(--amber)', ev: '+0.2', o: 'Open Game' },
  { m: ['g1', 'f3'], san: '2. Nf3', g: 'Book', c: 'var(--amber)', ev: '+0.3', o: 'King\'s Knight Opening' },
  { m: ['b8', 'c6'], san: '2... Nc6', g: 'Book', c: 'var(--amber)', ev: '+0.3', o: 'Open Game' },
  { m: ['f1', 'b5'], san: '3. Bb5', g: 'Best', c: 'var(--sage)', ev: '+0.4', o: 'Ruy Lopez' },
  { m: ['a7', 'a6'], san: '3... a6', g: 'Book', c: 'var(--amber)', ev: '+0.3', o: 'Ruy Lopez: Morphy Defense' },
  { m: ['b5', 'a4'], san: '4. Ba4', g: 'Best', c: 'var(--sage)', ev: '+0.3', o: 'Ruy Lopez' },
  { m: ['g8', 'f6'], san: '4... Nf6', g: 'Great', c: 'var(--blue)', ev: '+0.2', o: 'Ruy Lopez' },
  { m: ['e1', 'g1'], extra: ['h1', 'f1'], san: '5. O-O', g: 'Best', c: 'var(--sage)', ev: '+0.3', o: 'Ruy Lopez: Closed' },
];
const NAME = { p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };
const board = $('#hb');
let pieces = new Map(), lastEl, ringEl;
const pos = sq => { const f = FILES.indexOf(sq[0]), r = 8 - +sq[1]; return `translate(${f * 100}%, ${r * 100}%)`; };

function setup() {
  board.innerHTML = ''; pieces = new Map();
  lastEl = Object.assign(document.createElement('div'), { className: 'last' }); lastEl.style.opacity = 0; board.appendChild(lastEl);
  ringEl = Object.assign(document.createElement('div'), { className: 'ring' }); board.appendChild(ringEl);
  START.split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += +ch; continue; }
      const sq = FILES[f] + (8 - i), color = ch === ch.toUpperCase() ? 'w' : 'b';
      const img = Object.assign(document.createElement('img'), { src: `./pieces/${color}${NAME[ch.toLowerCase()]}.svg`, className: 'pc', alt: '', draggable: false });
      img.style.transform = pos(sq); board.appendChild(img); pieces.set(sq, img); f++;
    }
  });
}
function move(from, to) {
  const el = pieces.get(from); if (!el) return;
  const hit = pieces.get(to); if (hit) { hit.classList.add('gone'); pieces.delete(to); }
  el.style.transform = pos(to); pieces.delete(from); pieces.set(to, el);
}
function mark(sq) {
  lastEl.style.transform = pos(sq); lastEl.style.opacity = 1;
  ringEl.style.transform = pos(sq); ringEl.classList.remove('on'); void ringEl.offsetWidth; ringEl.classList.add('on');
}
function show(step) {
  $('#hb-move').textContent = step.san; $('#hb-eval').textContent = step.ev; $('#hb-opening').textContent = step.o;
  const g = $('#hb-grade'); g.textContent = step.g; g.style.setProperty('--c', step.c);
}
function play(i) {
  const s = GAME[i]; move(...s.m); if (s.extra) move(...s.extra); mark(s.m[1]); show(s);
}
setup();
if (reduce) { GAME.forEach((_, i) => play(i)); }
else {
  let i = 0, timer;
  const stepper = () => {
    if (document.hidden) { timer = setTimeout(stepper, 800); return; }
    if (i >= GAME.length) { timer = setTimeout(() => { setup(); show({ san: '1. e4', g: 'Book', c: 'var(--amber)', ev: '+0.3', o: 'Italian Game' }); i = 0; stepper(); }, 1800); return; }
    play(i++); timer = setTimeout(stepper, 1300);
  };
  setTimeout(stepper, 1400);
}

// ---------- hero board: gentle mouse tilt ----------
const tilt = $('#tilt');
if (!reduce && matchMedia('(hover: hover)').matches) {
  const hero = $('.hero');
  hero.addEventListener('pointermove', e => {
    const r = hero.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    tilt.style.transform = `perspective(1100px) rotateY(${x * 7}deg) rotateX(${-y * 6}deg)`;
  });
  hero.addEventListener('pointerleave', () => { tilt.style.transform = ''; });
}
