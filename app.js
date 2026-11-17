/* 跟練播放器 v1（無影片版）
 * 課表來源：data/courses.json（由 Adam 從 課表/*.md 轉出）
 * 流程：準備 → 動作 → 休息 → 動作 … → 完成
 */
'use strict';
const APP_VERSION = '1.0.2';
const RING_LEN = 2 * Math.PI * 54; // 圓周長，對應 style.css 的 stroke-dasharray

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/* ---------------- 設定 ---------------- */
const opts = { beep: store.get('opt-beep', true), voice: store.get('opt-voice', true), mix: store.get('opt-mix', true) };
for (const k of ['beep', 'voice', 'mix']) {
  const el = $('opt-' + k);
  el.checked = opts[k];
  el.addEventListener('change', () => { opts[k] = el.checked; store.set('opt-' + k, el.checked); applyAudioSession(); });
}
$('app-version').textContent = APP_VERSION;
$('btn-settings').onclick = () => $('settings').classList.toggle('hidden');

/* ---------------- 聲音 ---------------- */
let actx = null;
function applyAudioSession() {
  // Safari 的 Audio Session API：ambient = 跟其他 App 的音樂混在一起播，不會把 Spotify 停掉
  try { if (navigator.audioSession) navigator.audioSession.type = opts.mix ? 'ambient' : 'playback'; } catch {}
}
function unlockAudio() {
  applyAudioSession();
  if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
  if (actx && actx.state === 'suspended') actx.resume();
}
function beep(freq = 880, dur = 0.15, vol = 0.5) {
  if (!opts.beep || !actx) return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
}
function say(text) {
  if (!opts.voice || !('speechSynthesis' in window)) return;
  const zh = /[㐀-鿿]/.test(text);
  const u = new SpeechSynthesisUtterance(zh ? `下一個，${text}` : `Next, ${text}`);
  u.lang = zh ? 'zh-TW' : 'en-US'; u.rate = 1;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
$('btn-test-beep').onclick = () => { unlockAudio(); const b = opts.beep; opts.beep = true; beep(); setTimeout(() => beep(880), 1000); setTimeout(() => { beep(1320, 0.4, 0.6); opts.beep = b; }, 2000); };
$('btn-test-voice').onclick = () => { const v = opts.voice; opts.voice = true; say('Push Ups'); opts.voice = v; };
(function diagInfo() {
  const ios = (navigator.userAgent.match(/OS (\d+)_(\d+)/) || []).slice(1).join('.');
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  $('diag-info').textContent = `iOS ${ios || '?'}｜主畫面模式：${standalone ? '是' : '否'}｜混音功能：${navigator.audioSession ? '支援' : '不支援'}｜防變暗：${'wakeLock' in navigator ? '支援' : '不支援'}`;
})();

/* ---------------- 防止螢幕變暗 ---------------- */
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}
function releaseAwake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

/* ---------------- 課表載入 ---------------- */
let courses = [];
async function loadCourses() {
  const status = $('data-status');
  try {
    const r = await fetch('data/courses.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    courses = data.courses || [];
    store.set('courses-backup', data);
    status.textContent = data.updated ? `課表更新於 ${data.updated}` : '';
  } catch {
    const b = store.get('courses-backup', null);
    courses = (b && b.courses) || [];
    status.textContent = courses.length ? '離線模式：使用上次存的課表' : '讀不到課表，請連上網路再開一次';
  }
  if (!('wakeLock' in navigator)) status.textContent += '｜提醒：這支手機可能會自動變暗，請把「自動鎖定」改成「永不」';
  renderCourses();
}
function courseSeconds(c) {
  const items = c.items || [];
  return (c.prep ?? 10) + items.reduce((s, it, i) => s + it.work + (i < items.length - 1 ? it.rest : 0), 0);
}
function renderCourses() {
  const ul = $('course-list'); ul.innerHTML = '';
  for (const c of courses) {
    const li = document.createElement('li'); li.className = 'course';
    li.innerHTML = `<div class="info"><h3></h3><p></p><div class="moves"></div></div><button class="primary">開始</button>`;
    li.querySelector('h3').textContent = c.name;
    li.querySelector('p').textContent = `${c.items.length} 個動作・約 ${fmt(courseSeconds(c))}${c.note ? '・' + c.note : ''}`;
    li.querySelector('.moves').textContent = c.items.map((i) => i.name).join('、');
    li.querySelector('button').onclick = () => startCourse(c);
    ul.appendChild(li);
  }
}

/* ---------------- 播放引擎 ---------------- */
// segment = { type: 'prep'|'work'|'rest', dur, item, next, workIdx }
let segs = [], si = 0, segEnd = 0, pausedLeft = null, lastSec = null, total = 0, timer = null, course = null, startedAt = 0;

function buildSegments(c) {
  const out = [], items = c.items;
  const prep = c.prep ?? 10;
  if (prep > 0) out.push({ type: 'prep', dur: prep, item: null, next: items[0], workIdx: -1 });
  items.forEach((it, i) => {
    out.push({ type: 'work', dur: it.work, item: it, next: items[i + 1] || null, workIdx: i });
    if (i < items.length - 1 && it.rest > 0) out.push({ type: 'rest', dur: it.rest, item: it, next: items[i + 1], workIdx: i });
  });
  return out;
}

function startCourse(c) {
  unlockAudio(); keepAwake();
  course = c; segs = buildSegments(c); total = segs.reduce((s, x) => s + x.dur, 0);
  startedAt = Date.now();
  $('home').classList.remove('active'); $('player').classList.add('active');
  $('done').classList.add('hidden'); $('paused').classList.add('hidden');
  enterSeg(0);
  clearInterval(timer); timer = setInterval(tick, 100);
}

function enterSeg(i, silent = false) {
  si = i; pausedLeft = null; lastSec = null;
  const s = segs[si];
  segEnd = performance.now() + s.dur * 1000;
  const p = $('player'); p.dataset.phase = s.type;
  const workCount = course.items.length;
  if (s.type === 'work') {
    $('phase-label').textContent = '';
    $('move-name').textContent = s.item.name;
    $('idx').textContent = `${s.workIdx + 1} / ${workCount}`;
    if (!silent) beep(1320, 0.4, 0.6);
  } else {
    $('phase-label').textContent = s.type === 'prep' ? '準備開始・UP NEXT' : 'REST・UP NEXT';
    $('move-name').textContent = s.next ? s.next.name : '';
    $('idx').textContent = s.type === 'prep' ? `共 ${workCount} 個動作` : `${s.workIdx + 1} / ${workCount}`;
    if (!silent) { if (s.type === 'rest') beep(660, 0.3, 0.5); if (s.next) setTimeout(() => say(s.next.name), 350); }
  }
  $('pip-name').textContent = s.next ? s.next.name : '最後一個！';
  $('btn-pause').textContent = '⏸';
  render();
}

function elapsedBefore(i) { let t = 0; for (let k = 0; k < i; k++) t += segs[k].dur; return t; }

function leftMs() { return pausedLeft !== null ? pausedLeft : Math.max(0, segEnd - performance.now()); }

function tick() {
  if (pausedLeft !== null) return;
  // 手機鎖螢幕再回來時，可能已經跳過好幾段 → 一次補上（不補嗶聲）
  let caught = false;
  while (performance.now() >= segEnd) {
    if (si >= segs.length - 1) return finish();
    const over = performance.now() - segEnd;
    enterSeg(si + 1, caught);
    segEnd -= over; // 把超過的時間扣掉，保持總時間準確
    caught = true;
  }
  const sec = Math.ceil(leftMs() / 1000);
  if (sec !== lastSec) {
    if (lastSec !== null && sec <= 3 && sec >= 1) beep(880, 0.15, 0.5);
    lastSec = sec;
  }
  render();
}

function render() {
  const s = segs[si]; if (!s) return;
  const ms = leftMs(), sec = Math.ceil(ms / 1000);
  const c = $('count'); c.textContent = sec; c.classList.toggle('last3', sec <= 3);
  $('ring-fg').style.strokeDashoffset = String(RING_LEN * (1 - ms / (s.dur * 1000)));
  const done = elapsedBefore(si) + (s.dur - ms / 1000);
  $('pct').textContent = `${Math.min(100, Math.floor((done / total) * 100))}%`;
}

function finish() {
  clearInterval(timer); timer = null; releaseAwake();
  $('ring-fg').style.strokeDashoffset = String(RING_LEN);
  $('count').textContent = '0'; $('pct').textContent = '100%';
  beep(1320, 0.25); setTimeout(() => beep(1760, 0.5), 300);
  const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  $('done-sub').textContent = `${course.name}・${course.items.length} 個動作・${mins} 分鐘`;
  $('done').classList.remove('hidden');
}

function togglePause() {
  if (!timer) return;
  if (pausedLeft === null) {
    pausedLeft = Math.max(0, segEnd - performance.now());
    $('paused').innerHTML = '⏸ 暫停中<br><span class="small">點一下繼續</span>';
    $('paused').classList.remove('hidden'); $('btn-pause').textContent = '▶';
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  } else {
    segEnd = performance.now() + pausedLeft; pausedLeft = null; lastSec = null;
    $('paused').classList.add('hidden'); $('btn-pause').textContent = '⏸';
    unlockAudio(); keepAwake();
  }
  render();
}

function jumpNext() {
  if (!timer) return;
  const wasPaused = pausedLeft !== null;
  for (let k = si + 1; k < segs.length; k++) if (segs[k].type === 'work') { enterSeg(k); if (wasPaused) togglePause(); return; }
  finish();
}
function jumpPrev() {
  if (!timer) return;
  const wasPaused = pausedLeft !== null;
  const s = segs[si];
  const into = s.dur - leftMs() / 1000;
  let target = -1;
  if (s.type === 'work' && into > 2) target = si;
  else for (let k = si - 1; k >= 0; k--) if (segs[k].type === 'work') { target = k; break; }
  if (target < 0) target = 0;
  enterSeg(target); if (wasPaused) togglePause();
}
function exitPlayer() {
  clearInterval(timer); timer = null; releaseAwake();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('player').classList.remove('active'); $('home').classList.add('active');
}

$('btn-pause').onclick = togglePause;
$('paused').onclick = togglePause;
$('btn-next').onclick = jumpNext;
$('btn-prev').onclick = jumpPrev;
$('btn-exit').onclick = () => { if (!timer || confirmExit()) exitPlayer(); };
$('btn-done-home').onclick = exitPlayer;
function confirmExit() {
  // 不用瀏覽器的 confirm 對話框；第一次按 ✕ 先暫停，再按一次才離開
  if (pausedLeft === null) { togglePause(); $('paused').innerHTML = '⏸ 暫停中<br><span class="small">再按 ✕ 結束，點畫面繼續</span>'; return false; }
  return true;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && timer) { keepAwake(); unlockAudio(); tick(); }
});

/* ---------------- 離線 ---------------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // 有新版時自動重新整理（運動中不會）
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!timer && !reloaded) { reloaded = true; location.reload(); } });
}

loadCourses();
