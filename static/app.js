// Control panel: search, queue, transport controls. Talks to the TV window over a BroadcastChannel.
const chan = new BroadcastChannel('karaoke');
const $ = (id) => document.getElementById(id);

const STORE_KEY = 'karaoke-state-v2';
const state = {
  queue: [],        // [{key, id, title, channel, duration}]
  current: null,    // the song on the TV, or null
  musicVol: 80,
};
// How each video will be played, from /api/prepare: {mode:'embed'} or
// {mode:'file', status:'downloading'|'ready'|'error', progress, error}
const prep = {};
let tv = { lastSeen: 0, unlocked: false, playing: false, time: 0, duration: 0, videoId: null };
let tvWindow = null;
let lastResults = [];

// ---------- persistence (per-browser convenience only) ----------
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s) Object.assign(state, s);
  } catch {}
}

// ---------- helpers ----------
const fmt = (sec) => {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newKey = () => Math.random().toString(36).slice(2, 10);
const send = (msg) => chan.postMessage(msg);
const upNext = () => state.queue[0]?.title || '';

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ---------- search ----------
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let q = $('q').value.trim();
  if (!q) return;
  if ($('addKaraoke').checked && !/karaoke/i.test(q)) q += ' karaoke';
  $('searchStatus').textContent = `searching 4 “${q}”...`;
  lastResults = [];
  renderResults();
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&n=24`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    lastResults = data.results;
    $('searchStatus').textContent = data.results.length ? '' : 'nothing found :( try different words';
    renderResults();
  } catch (err) {
    $('searchStatus').textContent = `search broke: ${err.message}. is the server still running?`;
  }
});

function renderResults() {
  $('resultsTable').hidden = !lastResults.length;
  $('results').innerHTML = lastResults.map((v, i) => `
    <tr>
      <td class="thumb"><img src="${thumb(v.id)}" alt="" loading="lazy"></td>
      <td><b>${esc(v.title)}</b><div class="channel">${esc(v.channel)}</div></td>
      <td>${v.duration ? fmt(v.duration) : ''}</td>
      <td class="acts">
        <button class="bevel small" data-add="${i}">+ queue</button>
        <button class="bevel small" data-now="${i}">play NOW</button>
      </td>
    </tr>`).join('');
}
$('results').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  const now = e.target.closest('[data-now]');
  if (add) addToQueue(lastResults[+add.dataset.add]);
  if (now) playNow(lastResults[+now.dataset.now]);
});

// ---------- preparing videos (embed vs. download) ----------
async function prepare(id, force = false) {
  try {
    const r = await fetch(`/api/prepare?id=${id}${force ? '&force=file' : ''}`);
    prep[id] = await r.json();
  } catch {
    prep[id] = { mode: 'embed' }; // server unreachable: just try the embed
  }
  onPrepUpdate(id);
}

function onPrepUpdate(id) {
  renderQueue();
  if (state.current?.id === id) sendCurrent();
}

// Poll download progress for songs we care about.
setInterval(() => {
  const ids = new Set([state.current?.id, ...state.queue.map((q) => q.id)]);
  for (const id of ids) {
    if (id && prep[id]?.mode === 'file' && prep[id].status === 'downloading') prepare(id);
  }
}, 1000);

// Tell the TV what to do for the current song.
function sendCurrent() {
  const item = state.current;
  if (!item) return send({ type: 'stop' });
  const p = prep[item.id];
  if (!p) return; // still checking; onPrepUpdate will call us again
  const base = { type: 'load', video: item, upNext: upNext() };
  if (p.mode === 'embed') return send({ ...base, mode: 'embed' });
  if (p.status === 'ready') return send({ ...base, mode: 'file', src: `/media/${item.id}.mp4` });
  if (p.status === 'downloading') return send({ ...base, mode: 'wait', progress: p.progress });
  toast(`Couldn’t get “${item.title}”: ${p.error || 'download failed'}. Skipping.`);
  next();
}

// ---------- queue ----------
const makeItem = (v) => ({ key: newKey(), id: v.id, title: v.title, channel: v.channel, duration: v.duration });

function addToQueue(v) {
  const item = makeItem(v);
  if (!state.current) return setCurrent(item);
  state.queue.push(item);
  if (!prep[item.id]) prepare(item.id);
  toast(`Queued: ${v.title}`);
  changed();
}
function playNow(v) { setCurrent(makeItem(v)); }

function setCurrent(item) {
  state.current = item;
  tv.time = 0; tv.duration = item?.duration || 0; tv.playing = false;
  if (item && !prep[item.id]) prepare(item.id);
  sendCurrent();
  if (item && !tvAlive()) toast('Open the TV window to start playback');
  changed();
}
function next() { setCurrent(state.queue.shift() || null); }

$('queue').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const i = +b.dataset.i;
  const q = state.queue;
  switch (b.dataset.act) {
    case 'up': if (i > 0) [q[i - 1], q[i]] = [q[i], q[i - 1]]; break;
    case 'down': if (i < q.length - 1) [q[i + 1], q[i]] = [q[i], q[i + 1]]; break;
    case 'play': setCurrent(q.splice(i, 1)[0]); return;
    case 'del': q.splice(i, 1); break;
  }
  changed();
});
$('clearQueue').addEventListener('click', () => { state.queue = []; changed(); });

function prepBadge(id) {
  const p = prep[id];
  if (!p) return '<span class="status">(checking...)</span>';
  if (p.mode === 'embed') return '';
  if (p.status === 'downloading') return `<span class="status">(downloading ${Math.round((p.progress || 0) * 100)}%)</span>`;
  if (p.status === 'ready') return '<span class="status ok">(downloaded)</span>';
  return '<span class="status">(unavailable)</span>';
}

function renderQueue() {
  $('queueCount').textContent = state.queue.length ? `(${state.queue.length})` : '';
  $('queueEmpty').style.display = state.queue.length ? 'none' : 'block';
  $('queue').innerHTML = state.queue.map((v, i) => `
    <li>${esc(v.title)} ${prepBadge(v.id)}
      <span class="acts">
        <button class="linkbtn" data-act="play" data-i="${i}" aria-label="Play now">[▶]</button><button class="linkbtn" data-act="up" data-i="${i}" aria-label="Move up">[↑]</button><button class="linkbtn" data-act="down" data-i="${i}" aria-label="Move down">[↓]</button><button class="linkbtn" data-act="del" data-i="${i}" aria-label="Remove">[x]</button>
      </span>
    </li>`).join('');
  renderNow();
}

const BAR = 20;
function renderNow() {
  const cur = state.current;
  const p = cur && prep[cur.id];
  let title = cur ? cur.title : 'nothing yet. pick something!!';
  if (p?.mode === 'file' && p.status === 'downloading') title += ` (downloading ${Math.round((p.progress || 0) * 100)}%)`;
  $('nowTitle').textContent = title;
  $('nowTitle').classList.toggle('muted', !cur);
  const dur = tv.duration || cur?.duration || 0;
  const k = dur ? Math.round(Math.min(1, tv.time / dur) * BAR) : 0;
  $('progressBar').textContent = '▓'.repeat(k) + '░'.repeat(BAR - k);
  $('progressTime').textContent = `${fmt(tv.time) || '0:00'} / ${fmt(dur) || '0:00'}`;
  $('btnPlayPause').textContent = tv.playing ? '❚❚ pause' : '▶ play';
}

// ---------- songs-sung counter (ticks up each time a song starts playing) ----------
let counter = 0;
function showCounter(n) {
  counter = n;
  const padded = String(n).padStart(6, '0');
  $('counter').textContent = padded;
  const bit = `~*~ welcome 2 my karaoke page ~*~ u r visitor #${padded} ~*~ no skipping ur friends' songs `;
  $('ticker').textContent = (bit + bit + bit + bit) + '~*~ ';
  send({ type: 'counter', value: n });
}
async function loadCounter() {
  try { showCounter((await (await fetch('/api/counter')).json()).count); } catch { showCounter(counter); }
}
async function bumpCounter() {
  try { showCounter((await (await fetch('/api/counter', { method: 'POST' })).json()).count); } catch {}
}

function changed() {
  save();
  renderQueue();
  send({ type: 'upnext', title: upNext() });
}

// ---------- transport ----------
$('btnPlayPause').addEventListener('click', () => {
  if (!state.current && state.queue.length) return next();
  send({ type: tv.playing ? 'pause' : 'play' });
});
$('btnRestart').addEventListener('click', () => send({ type: 'restart' }));
$('btnSkip').addEventListener('click', next);
$('progressBar').addEventListener('click', (e) => {
  const dur = tv.duration || state.current?.duration;
  if (!dur) return;
  const r = e.currentTarget.getBoundingClientRect();
  send({ type: 'seek', to: ((e.clientX - r.left) / r.width) * dur });
});
$('musicVol').addEventListener('input', (e) => {
  state.musicVol = +e.target.value;
  send({ type: 'volume', value: state.musicVol });
  save();
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); $('btnPlayPause').click(); }
  if (e.key === 'n' || e.key === 'N') next();
});

// ---------- TV window ----------
function tvAlive() { return Date.now() - tv.lastSeen < 1500; }

$('openTv').addEventListener('click', () => {
  if (tvWindow && !tvWindow.closed) { tvWindow.focus(); return; }
  tvWindow = window.open('/tv.html', 'karaoke-tv', 'popup,width=1280,height=720');
});

chan.onmessage = ({ data: m }) => {
  switch (m.type) {
    case 'hello':
      // TV just opened or reloaded: bring it up to date.
      tv.lastSeen = Date.now();
      send({ type: 'volume', value: state.musicVol });
      send({ type: 'counter', value: counter });
      if (state.current) sendCurrent();
      else send({ type: 'upnext', title: upNext() });
      break;
    case 'state':
      tv = { ...tv, ...m, lastSeen: Date.now() };
      // Count each queued play once, the first time it actually starts playing.
      if (m.playing && state.current && m.videoId === state.current.id && state.countedKey !== state.current.key) {
        state.countedKey = state.current.key;
        save();
        bumpCounter();
      }
      renderNow();
      break;
    case 'ended':
      if (state.current && m.videoId === state.current.id) next();
      break;
    case 'error': {
      const cur = state.current;
      if (!cur || m.videoId !== cur.id) break;
      if (m.code === 101 || m.code === 150) {
        // Uploader blocks embedding: have the server download it instead.
        prep[cur.id] = undefined;
        prepare(cur.id, true);
        break;
      }
      const why = m.code === 100 ? 'the video was removed or is private' : `playback error ${m.code}`;
      toast(`Skipped “${cur.title}”: ${why}. Try another version.`);
      next();
      break;
    }
  }
};

setInterval(() => {
  const alive = tvAlive();
  $('tvDot').classList.toggle('on', alive);
  $('tvLabel').textContent = !alive ? 'TV window not open'
    : tv.unlocked ? 'TV connected!!' : 'TV open: click it once 2 start';
  $('openTv').textContent = alive ? 'go 2 TV window' : 'open TV window';
}, 500);

// ---------- start ----------
restore();
$('musicVol').value = state.musicVol;
for (const id of new Set([state.current?.id, ...state.queue.map((q) => q.id)])) if (id) prepare(id);
changed();
showCounter(counter);
loadCounter();
send({ type: 'ping' });
