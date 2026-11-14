// TV window: plays the song and talks to the control panel over a BroadcastChannel.
// Two players: the YouTube embed (for videos that allow it) and a <video> element
// (for videos the server downloaded because the uploader blocks embedding).
const chan = new BroadcastChannel('karaoke');
const $ = (id) => document.getElementById(id);
const video = $('video');

let yt = null;               // YouTube player
let ytReady = false;
let active = null;           // 'yt' | 'file' | null
let unlocked = false;        // true after the first click (browser autoplay rule)
let pending = null;          // a 'load' waiting for the click / YouTube API
let currentId = null;
let volume = 80;
let bannerTimer = null;

const send = (msg) => chan.postMessage(msg);

const asciiBar = (frac, n = 20) => {
  const k = Math.round(Math.max(0, Math.min(1, frac)) * n);
  return '▓'.repeat(k) + '░'.repeat(n - k) + ` ${Math.round(frac * 100)}%`;
};
let upNextTitle = '';

// Between songs. With `getting` set, a download is in progress for that song.
function showIdle(getting, progress) {
  document.body.classList.remove('playing');
  $('idle').style.display = 'flex';
  $('playerWrap').style.visibility = 'hidden';
  video.style.visibility = 'hidden';
  const card = $('idleCard');
  if (getting) {
    card.classList.remove('hidden');
    $('idleLabel').textContent = 'getting ready';
    $('idleBig').textContent = getting;
    $('idleBar').textContent = asciiBar(progress || 0);
    $('idleTag').textContent = '~*~ downloading... hold pls ~*~';
  } else if (upNextTitle) {
    card.classList.remove('hidden');
    $('idleLabel').textContent = 'up next';
    $('idleBig').textContent = upNextTitle;
    $('idleBar').textContent = '';
    $('idleTag').textContent = '~*~ get ur butt 2 the mic ~*~';
  } else {
    card.classList.add('hidden');
    $('idleTag').textContent = '~*~ pick a song on the laptop ~*~';
  }
}
function showPlayer(which) {
  document.body.classList.add('playing');
  $('idle').style.display = 'none';
  $('playerWrap').style.visibility = which === 'yt' ? 'visible' : 'hidden';
  video.style.visibility = which === 'file' ? 'visible' : 'hidden';
}
function banner(text, ms = 6000) {
  const b = $('banner');
  b.textContent = text;
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}

// Called by the YouTube IFrame API script once it loads.
window.onYouTubeIframeAPIReady = function () {
  yt = new YT.Player('player', {
    width: '100%', height: '100%',
    playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0, origin: location.origin },
    events: {
      onReady: () => { ytReady = true; yt.setVolume(volume); flushPending(); },
      onStateChange: (e) => {
        if (active !== 'yt') return;
        if (e.data === YT.PlayerState.ENDED) send({ type: 'ended', videoId: currentId });
        if (e.data === YT.PlayerState.PLAYING) showPlayer('yt');
      },
      // 101/150 = uploader blocks embedding, 100 = removed/private, 2/5 = bad id / HTML5 error
      onError: (e) => { if (active === 'yt') send({ type: 'error', videoId: currentId, code: e.data }); },
    },
  });
};

video.addEventListener('ended', () => { if (active === 'file') send({ type: 'ended', videoId: currentId }); });
video.addEventListener('playing', () => { if (active === 'file') showPlayer('file'); });
video.addEventListener('error', () => { if (active === 'file') send({ type: 'error', videoId: currentId, code: 'file' }); });

// Play downloaded songs through the same speaker the mic uses (chosen on the control panel).
let outputId = '';
async function setOutput(id) {
  if (id === outputId || typeof video.setSinkId !== 'function') return;
  try {
    await video.setSinkId(id);
    outputId = id;
  } catch (e) {
    send({ type: 'sinkError', message: e.message || e.name });
  }
}

function stopAll() {
  if (ytReady) yt.stopVideo();
  video.pause();
  video.removeAttribute('src');
  video.load();
  active = null;
}

function flushPending() { if (pending) { const p = pending; pending = null; load(p); } }

function load(msg) {
  if (msg.mode === 'wait') {           // server is still downloading this one
    stopAll();
    currentId = msg.video.id;
    upNextTitle = msg.upNext || '';
    showIdle(msg.video.title, msg.progress || 0);
    return;
  }
  if (!unlocked || (msg.mode === 'embed' && !ytReady)) { pending = msg; return; }
  // Already playing this exact song (e.g. the control panel was reloaded): leave it alone.
  if (msg.video.id === currentId && active === (msg.mode === 'file' ? 'file' : 'yt')) return;
  stopAll();
  currentId = msg.video.id;
  if (msg.mode === 'file') {
    active = 'file';
    video.src = msg.src;
    video.volume = volume / 100;
    if (msg.start > 1) video.addEventListener('loadedmetadata', () => { video.currentTime = msg.start; }, { once: true });
    video.play().catch(() => {});
  } else {
    active = 'yt';
    yt.loadVideoById(msg.video.id);
    yt.setVolume(volume);
  }
  upNextTitle = msg.upNext || '';
  banner(msg.upNext ? `♪ ${msg.video.title}  ~*~  up next: ${msg.upNext}` : `♪ ${msg.video.title}`);
}

chan.onmessage = ({ data: m }) => {
  switch (m.type) {
    case 'load': load(m); break;
    case 'stop':
      pending = null; currentId = null; stopAll();
      showIdle();
      break;
    case 'pause': active === 'yt' ? yt.pauseVideo() : active === 'file' && video.pause(); break;
    case 'play': active === 'yt' ? yt.playVideo() : active === 'file' && video.play(); break;
    case 'restart':
      if (active === 'yt') { yt.seekTo(0, true); yt.playVideo(); }
      if (active === 'file') { video.currentTime = 0; video.play(); }
      break;
    case 'seek':
      if (active === 'yt') yt.seekTo(m.to, true);
      if (active === 'file') video.currentTime = m.to;
      break;
    case 'volume':
      volume = m.value;
      if (ytReady) yt.setVolume(volume);
      video.volume = volume / 100;
      break;
    case 'upnext':
      upNextTitle = m.title || '';
      if ($('idle').style.display !== 'none' && !(active === null && currentId)) showIdle();
      break;
    case 'output': setOutput(m.deviceId || ''); break;
    case 'counter':
      $('visitors').textContent = `visitors: ${String(m.value).padStart(6, '0')}`;
      break;
    case 'ping': send({ type: 'hello' }); break;
  }
};

// Report playback state ~4x/second so the control panel can show progress.
setInterval(() => {
  const s = { type: 'state', videoId: currentId, unlocked, playing: false, time: 0, duration: 0 };
  if (active === 'yt' && ytReady) {
    s.playing = yt.getPlayerState() === YT.PlayerState.PLAYING;
    s.time = yt.getCurrentTime() || 0;
    s.duration = yt.getDuration() || 0;
  } else if (active === 'file') {
    s.playing = !video.paused && !video.ended;
    s.time = video.currentTime || 0;
    s.duration = isFinite(video.duration) ? video.duration : 0;
  }
  send(s);
}, 250);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

$('startOverlay').addEventListener('click', () => {
  unlocked = true;
  $('startOverlay').style.display = 'none';
  toggleFullscreen();
  flushPending();
});
document.addEventListener('dblclick', toggleFullscreen);

// Full screen button: always shown in a window; in full screen it appears when the mouse moves
// and fades after a moment. (Mouse moves over the YouTube player don't reach this page, so while
// an embedded video plays in full screen, use Esc or F instead.)
const fsButton = $('fsButton');
let fsHideTimer;
function updateFsButton() {
  const full = !!document.fullscreenElement;
  fsButton.textContent = full ? '⛶ exit full screen' : '⛶ full screen';
  clearTimeout(fsHideTimer);
  fsButton.classList.remove('faded');
  if (full) fsHideTimer = setTimeout(() => fsButton.classList.add('faded'), 2500);
}
fsButton.addEventListener('click', toggleFullscreen);
fsButton.addEventListener('dblclick', (e) => e.stopPropagation());
document.addEventListener('fullscreenchange', updateFsButton);
document.addEventListener('mousemove', updateFsButton);
updateFsButton();
document.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') toggleFullscreen(); });

showIdle();
send({ type: 'hello' });
