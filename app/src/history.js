import '@fontsource-variable/outfit';
import '@fontsource-variable/jetbrains-mono';
import './landing.css';
import './history.css';
import { listGames, deleteGame, clearGames, putMany } from './store.js';
import { MODES, titleOf, pgnOf, parsePgnGames, recordFromPgn, normalizeRecord } from './games.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = { games: [], mode: 'all', q: '', sort: 'new' };

// ---------- theme (shared with the app) ----------
const root = document.documentElement;
const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
const paintTheme = () => $('#theme use').setAttribute('href', isDark() ? '#i-sun' : '#i-moon');
$('#theme').addEventListener('click', () => {
  const t = isDark() ? 'light' : 'dark'; root.dataset.theme = t;
  try { localStorage.setItem('augur:theme', JSON.stringify(t)); } catch { /* private mode */ }
  paintTheme();
});
paintTheme();

// ---------- toast + confirm (shown inside an open dialog so they are never hidden behind it) ----------
function toast(msg, ms = 2800) {
  const t = $('#toast'), host = document.querySelector('dialog[open]') || document.body;
  if (t.parentElement !== host) host.appendChild(t);
  t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function confirmDialog(title, msg, ok) {
  return new Promise(res => {
    const d = $('#confirm'); $('#confirm-title').textContent = title; $('#confirm-msg').textContent = msg; $('#confirm-yes').textContent = ok;
    const done = v => { d.close(); res(v); };
    $('#confirm-yes').onclick = () => done(true); $('#confirm-no').onclick = () => done(false); d.oncancel = () => res(false);
    d.showModal();
  });
}
document.addEventListener('click', e => { const c = e.target.closest('[data-close]'); if (c) c.closest('dialog').close(); });

// ---------- rendering ----------
const NAME = { p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };
const FILES = 'abcdefgh';
function thumb(fen) {
  let html = '';
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += +ch; continue; }
      html += `<img src="./pieces/${ch === ch.toUpperCase() ? 'w' : 'b'}${NAME[ch.toLowerCase()]}.svg" alt="" style="transform:translate(${f * 100}%,${r * 100}%)">`; f++;
    }
  });
  return `<div class="thumb" aria-hidden="true">${html}</div>`;
}
const when = ts => {
  const d = new Date(ts), diff = (Date.now() - ts) / 864e5;
  if (diff < 1 && new Date().getDate() === d.getDate()) return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (diff < 2) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
function card(g, i) {
  const m = MODES[g.mode] || MODES.imported, n = g.moves.length, full = Math.ceil(n / 2);
  const res = g.result && g.result !== '*' ? `<span class="tag plain">${esc(g.result)}</span>` : '<span class="tag plain">In progress</span>';
  const acc = g.review ? `<span class="tag" style="--c:var(--rose)">Reviewed ${g.review.w.toFixed(0)}% / ${g.review.b.toFixed(0)}%</span>` : '';
  return `<article class="gcard in-up" style="--c:${m.color};--d:${Math.min(i, 10) * 45}ms" data-id="${esc(g.id)}">
    ${thumb(g.finalFen)}
    <div class="ginfo">
      <h3 class="gtitle" title="${esc(titleOf(g))}">${esc(titleOf(g))}</h3>
      <div class="gmeta"><span class="tag" style="--c:${m.color}">${m.label}</span>${res}${acc}</div>
      <div class="gsub"><b>${full} move${full === 1 ? '' : 's'}</b> · ${esc(when(g.updated))}${g.opening ? `<br>${esc(g.opening)}` : ''}</div>
      <div class="gact">
        <button class="btn solid" data-act="resume" type="button"><svg class="ic"><use href="#i-play"/></svg>${g.mode === 'review' || g.mode === 'imported' ? 'Open' : 'Resume'}</button>
        <button class="btn ghost" data-act="review" type="button"><svg class="ic"><use href="#i-chart"/></svg>Review</button>
        <button class="btn ghost" data-act="pgn" type="button" title="Download this game as PGN"><svg class="ic"><use href="#i-download"/></svg>PGN</button>
        <button class="btn ghost del" data-act="del" type="button" title="Delete this game"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>
    </div>
  </article>`;
}
function filtered() {
  const q = state.q.trim().toLowerCase();
  let list = state.games.filter(g => (state.mode === 'all' || g.mode === state.mode)
    && (!q || [titleOf(g), g.opening, g.white, g.black, g.event, new Date(g.updated).toLocaleDateString(), MODES[g.mode]?.label].filter(Boolean).join(' ').toLowerCase().includes(q)));
  list = list.slice().sort((a, b) => state.sort === 'old' ? a.updated - b.updated : state.sort === 'long' ? b.moves.length - a.moves.length : b.updated - a.updated);
  return list;
}
function renderFilters() {
  const counts = { all: state.games.length };
  for (const g of state.games) counts[g.mode] = (counts[g.mode] || 0) + 1;
  $('#filters').innerHTML = [['all', 'All', 'var(--blue)'], ...Object.entries(MODES).map(([k, v]) => [k, v.label, v.color])].filter(([k]) => k === 'all' || counts[k])
    .map(([k, label, c]) => `<button type="button" data-mode="${k}" aria-pressed="${state.mode === k}" style="--c:${c}">${label} ${counts[k] || 0}</button>`).join('');
}
function render() {
  const list = filtered(), none = !state.games.length;
  $('#grid').innerHTML = list.map(card).join('');
  $('#empty').classList.toggle('hidden', !none);
  $('.toolbar').classList.toggle('hidden', none);
  $('#btn-json').disabled = $('#btn-pgn').disabled = $('#btn-clear').disabled = none;
  renderFilters();
  const bytes = new Blob([JSON.stringify(state.games)]).size;
  $('#stats').textContent = none ? 'Nothing saved yet.' : `${state.games.length} game${state.games.length === 1 ? '' : 's'} · ${bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB'} on this device${list.length !== state.games.length ? ` · showing ${list.length}` : ''}`;
  if (!none && !list.length) $('#grid').innerHTML = '<p class="muted" style="grid-column:1/-1;padding:24px 4px">No games match your search.</p>';
}
async function load() {
  try { state.games = await listGames(); } catch { state.games = []; toast('History is not available in this browser (storage is blocked).'); }
  render();
}

// ---------- download helpers ----------
function download(name, text, type) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
const stamp = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'game';

// ---------- import ----------
async function importText(text, name = '') {
  const t = text.trim();
  if (!t) return { added: 0, updated: 0, skipped: 0, failed: 0 };
  let recs = [], failed = 0;
  if (/\.json$/i.test(name) || /^(\{|\[\s*[{\]])/.test(t)) {   // a JSON backup; PGN also starts with '[' but then a tag name
    let data; try { data = JSON.parse(t); } catch { return { added: 0, updated: 0, skipped: 0, failed: 1 }; }
    const arr = Array.isArray(data) ? data : Array.isArray(data.games) ? data.games : [];
    for (const raw of arr) { const r = normalizeRecord(raw); r ? recs.push(r) : failed++; }
  } else {
    const parsed = parsePgnGames(t); failed = parsed.failed;
    for (const g of parsed.games) { const r = recordFromPgn(g); r ? recs.push(r) : failed++; }
  }
  const out = recs.length ? await putMany(recs) : { added: 0, updated: 0, skipped: 0 };
  return { ...out, failed };
}
async function importFiles(files) {
  const tot = { added: 0, updated: 0, skipped: 0, failed: 0 };
  for (const f of files) { const r = await importText(await f.text(), f.name).catch(() => ({ failed: 1 })); for (const k in tot) tot[k] += r[k] || 0; }
  await load();
  const bits = [`${tot.added} imported`]; if (tot.updated) bits.push(`${tot.updated} updated`); if (tot.skipped) bits.push(`${tot.skipped} already saved`); if (tot.failed) bits.push(`${tot.failed} could not be read`);
  toast(tot.added || tot.updated ? bits.join(' · ') : tot.failed ? 'No games could be read from that file' : 'Everything in that file is already saved');
}

// ---------- events ----------
$('#file').addEventListener('change', async e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) await importFiles(f); });
$('#btn-paste').addEventListener('click', () => { $('#paste-text').value = ''; $('#paste').showModal(); $('#paste-text').focus(); });
$('#paste-go').addEventListener('click', async () => {
  const r = await importText($('#paste-text').value).catch(() => ({ failed: 1 }));
  $('#paste').close(); await load();
  toast(r.added ? `${r.added} game${r.added === 1 ? '' : 's'} imported${r.failed ? ` · ${r.failed} could not be read` : ''}` : r.skipped ? 'Already saved' : 'No games could be read from that text');
});
$('#btn-json').addEventListener('click', () => {
  download(`augur-games-${stamp()}.json`, JSON.stringify({ app: 'augur', version: 1, exported: new Date().toISOString(), games: state.games }, null, 1), 'application/json');
  toast(`Backup of ${state.games.length} game${state.games.length === 1 ? '' : 's'} downloaded`);
});
$('#btn-pgn').addEventListener('click', () => {
  download(`augur-games-${stamp()}.pgn`, state.games.slice().reverse().map(pgnOf).join('\n'), 'application/x-chess-pgn');
  toast(`${state.games.length} game${state.games.length === 1 ? '' : 's'} exported as PGN`);
});
$('#btn-clear').addEventListener('click', async () => {
  if (!(await confirmDialog('Clear all history?', `This deletes all ${state.games.length} saved games from this browser. Export a backup first if you might want them back.`, 'Delete everything'))) return;
  await clearGames().catch(() => {}); await load(); toast('History cleared');
});
$('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('#sort').addEventListener('change', e => { state.sort = e.target.value; render(); });
$('#filters').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) { state.mode = b.dataset.mode; render(); } });
$('#grid').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.closest('[data-id]').dataset.id, g = state.games.find(x => x.id === id); if (!g) return;
  if (b.dataset.act === 'resume') location.href = `./app.html?game=${encodeURIComponent(id)}`;
  else if (b.dataset.act === 'review') location.href = `./app.html?game=${encodeURIComponent(id)}&review=1`;
  else if (b.dataset.act === 'pgn') { download(`augur-${slug(titleOf(g))}-${new Date(g.updated).toISOString().slice(0, 10)}.pgn`, pgnOf(g), 'application/x-chess-pgn'); toast('PGN downloaded'); }
  else if (b.dataset.act === 'del') {
    if (!b.classList.contains('confirm')) {   // two-step delete: first press arms it, second deletes
      document.querySelectorAll('.del.confirm').forEach(x => x.classList.remove('confirm'));
      b.classList.add('confirm'); setTimeout(() => b.classList.remove('confirm'), 3200); return;
    }
    await deleteGame(id).catch(() => {}); await load(); toast('Game deleted');
  }
});
// drag and drop files anywhere on the page
let depth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { depth++; document.body.classList.add('drop'); } });
addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('drop'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => { e.preventDefault(); depth = 0; document.body.classList.remove('drop'); if (e.dataTransfer?.files?.length) await importFiles([...e.dataTransfer.files]); });

load();
