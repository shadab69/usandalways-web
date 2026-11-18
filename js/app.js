// US & Always — web app core: state, vault (localStorage), theming,
// remote config, auth, couple linking, Home, Chat, Settings.
// Feature screens (games / together / memories / room) live in features.mjs
// and register into `Screens`.

import * as api from './api.mjs';
import * as E from './crypto.mjs';
import { chatSignature, sniffAudioType, rowDecryptSignature, realtimeMessageAction, badgeLabel } from './logic.mjs';
import { createRealtimeClient } from './realtime.mjs';

/** Visible build stamp (Settings → Good to know) so any test or bug
 * report can certify exactly which code the browser was running —
 * GitHub Pages serves cached copies for up to ~10 minutes. */
const BUILD_ID = '2026-11-18.13';
import { initFeatures } from './features.mjs';

// ---------------------------------------------------------------- state
export const S = {
  me: null,            // my profiles row
  partner: null,       // partner profiles row or null
  coupleId: '',
  myPriv: null,        // Uint8Array raw X25519 private key (memory only)
  myPub: null,         // Uint8Array raw public key
  partnerPub: null,    // Uint8Array or null
  screen: '',
  screenParam: null,
  partnerBattery: null,
  partnerTypingUntil: 0,
  lastEventId: 0,
  eventsPrimed: false,
  lastMsgIdSeen: 0,
  msgsPrimed: false,
  rc: null,            // remote config map (key -> parsed JSON value)
  unlocked: false,
  partnerKeyChanged: false, // set when the partner's published key rotates
};
export const Screens = {};
export function registerScreen(name, fn) { Screens[name] = fn; }

// ---------------------------------------------------------------- storage
const ls = {
  get(k, d) { try { const v = localStorage.getItem('uaw.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('uaw.' + k, JSON.stringify(v)); } catch { /* storage full/blocked */ } },
  del(k) { localStorage.removeItem('uaw.' + k); },
};
export { ls };
export const uid = () => api.myUserId();
export const prefKey = (name) => name + ':' + uid();
export function prefs() { return ls.get(prefKey('prefs'), {}); }
export function setPref(name, value) { const p = prefs(); p[name] = value; ls.set(prefKey('prefs'), p); }
export function startDate() { return ls.get(prefKey('startDate'), todayIso()); }
export function todayIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
export function daysTogether() {
  const start = new Date(startDate() + 'T00:00:00');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((now - start) / 86400000));
}

// ---------------------------------------------------------------- dom helpers
export const appEl = () => document.getElementById('app');
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
export function sheet(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '<div class="modal-back"><div class="modal-sheet">' + html + '</div></div>';
  root.querySelector('.modal-back').addEventListener('click', (ev) => { if (ev.target.classList.contains('modal-back')) closeSheet(); });
  return root.querySelector('.modal-sheet');
}
export function closeSheet() { document.getElementById('modal-root').innerHTML = ''; }
export function confirmDlg(title, body, okLabel) {
  return new Promise((resolve) => {
    const sh = sheet('<h3>' + esc(title) + '</h3><p class="muted">' + esc(body) + '</p>' +
      '<button class="btn btn-danger" id="cf-ok">' + esc(okLabel) + '</button>' +
      '<button class="btn btn-ghost" id="cf-no">Cancel</button>');
    sh.querySelector('#cf-ok').onclick = () => { closeSheet(); resolve(true); };
    sh.querySelector('#cf-no').onclick = () => { closeSheet(); resolve(false); };
  });
}
export function topbar(title, opts = {}) {
  return '<div class="topbar">' +
    (opts.back ? '<button class="icon-btn" id="tb-back" aria-label="Back">←</button>' : '') +
    '<div class="title">' + esc(title) + (opts.subtitle ? '<span class="subtitle">' + esc(opts.subtitle) + '</span>' : '') + '</div>' +
    (opts.right || '') + '</div>';
}
export function wireBack(target) {
  const b = document.getElementById('tb-back');
  if (b) b.onclick = () => showScreen(target.name, target.param);
}

// ---------------------------------------------------------------- pollers
const pollers = new Set();
export function every(ms, fn) {
  const id = setInterval(() => { if (!document.hidden) fn().catch(() => {}); }, ms);
  pollers.add(id);
  fn().catch(() => {});
  return id;
}
function stopPollers() { pollers.forEach(clearInterval); pollers.clear(); }

// ---------------------------------------------------------------- navigation
const TABS = [
  ['home', '⌂', 'Home'], ['chat', '💬', 'Chat'], ['together', '🎵', 'Together'],
  ['memories', '🌸', 'Memories'], ['settings', '⚙', 'Settings'],
];
export function showScreen(name, param) {
  stopPollers();
  if (name !== 'chat') chatScreenReload = null;
  // The Together playback handler belongs to the open Listen/Watch
  // screen only; leaving those screens unregisters it.
  if (name !== 'listen' && name !== 'watch') setPlaybackHandler(null);
  S.screen = name; S.screenParam = param || null;
  const bar = document.getElementById('tabbar');
  const mainScreens = ['home', 'chat', 'together', 'memories', 'settings'];
  const inMain = !!S.me && mainScreens.concat(['room', 'games', 'voice', 'ttt', 'ludo', 'spin', 'pet', 'playlist', 'listen', 'watch', 'draw', 'read', 'album', 'journey', 'bucket', 'memoriesView', 'checkin', 'conflict', 'gifts']).includes(name);
  bar.hidden = !inMain;
  if (inMain) {
    const tabOf = { home: 'home', chat: 'chat', voice: 'chat', together: 'together', playlist: 'together', listen: 'together', watch: 'together', draw: 'together', read: 'together', memories: 'memories', album: 'memories', journey: 'memories', bucket: 'memories', memoriesView: 'memories', checkin: 'memories', conflict: 'memories', gifts: 'memories', settings: 'settings', room: 'home', games: 'together', ttt: 'together', ludo: 'together', spin: 'together', pet: 'together' };
    bar.innerHTML = TABS.map(([n, ico, label]) =>
      '<button data-tab="' + n + '" class="' + (tabOf[name] === n ? 'active' : '') + '"><span class="tab-ico">' + ico + '</span>' + label + '</button>').join('');
    bar.querySelectorAll('button').forEach((b) => { b.onclick = () => { playTabTing(); showScreen(b.dataset.tab); }; });
    renderUnreadBadge();
  }
  const fn = Screens[name];
  appEl().scrollTop = 0;
  if (fn) fn(param);
  else appEl().innerHTML = '<div class="screen"><p class="muted">Loading…</p></div>';
  // Bug #1: Home and Settings used to be dead ends for the partner who
  // created the invite — re-check the link whenever they are shown while
  // unlinked (a slow global poll covers the other screens).
  if ((name === 'home' || name === 'settings') && S.me && S.unlocked && !S.partner) refreshCoupleLink(true);
}

// ---------------------------------------------------------------- theme + remote config
export const BUILTIN = {
  truthDare: ['Truth: What was your first impression of your partner?', 'Dare: Send your partner a voice note singing a line of a song.', 'Truth: What small thing does your partner do that you love most?', 'Dare: Give your partner three compliments in your next message.', 'Truth: What is your favourite memory of the two of you so far?', 'Dare: Plan the next date, even a virtual one, and describe it now.', 'Truth: When did you last miss your partner the most?', 'Dare: Share a photo of where you are right now.', 'Truth: What is one dream you want the two of you to reach together?', 'Dare: Write your partner a four-line poem in the chat.', 'Truth: What meal would you cook for your partner first?', 'Dare: Hold a two-minute video-call stare contest next time you talk.', 'Truth: What song reminds you of your partner, and why?', 'Dare: Tell your partner a secret snack combination you secretly love.'],
  conflictQuestions: ['When we disagree, what helps you feel heard the fastest?', 'What is one thing I did recently that made you feel appreciated?', 'When you need space, how would you like me to give it?', 'What topic do we avoid that we should talk about gently?', 'When you are stressed, what should I never do, and what helps?', 'What is one small promise we can make to each other this week?', 'How do you know that I am really listening to you?', 'What would a perfect ordinary day together look like for you?'],
  giftKinds: ['Rose', 'Chocolate', 'Hug', 'Kiss', 'Love Letter', 'Star'],
  moods: ['Amazing', 'Good', 'Okay', 'Low', 'Rough'],
};
/** The three built-in themes, in Home-toggle cycle order. */
export const THEMES = ['warm', 'dark', 'cream'];
const THEME_COLORS = { warm: '#FBF6EF', dark: '#150D1D', cream: '#FAF2E9' };
const THEME_PALETTE_KEYS = { warm: 'theme_warm', dark: 'theme_dark', cream: 'theme_cream' };
export function themeMode() {
  // Redesign migration (2026-11-18): Morning Cream IS the redesign the
  // user asked for — it must be what the app opens in, not a hidden
  // Settings option. Existing browsers switch to it exactly once;
  // after that, whatever the user picks in Settings sticks.
  if (!ls.get('creamDefaultV1', null)) { ls.set('creamDefaultV1', '1'); ls.set('theme', 'cream'); }
  const m = ls.get('theme', 'cream');
  return THEMES.includes(m) ? m : 'cream';
}
export function applyTheme() {
  const mode = themeMode();
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]').content = THEME_COLORS[mode] || THEME_COLORS.warm;
  applyPaletteOverlay();
}
export function setTheme(mode) { ls.set('theme', mode); applyTheme(); }
/** Next theme in the cycle (Home toggle). */
export function nextTheme() { return THEMES[(THEMES.indexOf(themeMode()) + 1) % THEMES.length]; }
let overlayTokens = new Set();
function applyPaletteOverlay() {
  const root = document.documentElement;
  // Remove the previous theme's overlay first: inline custom properties
  // outrank the stylesheet, so without this a server palette for one
  // theme would leak into (and half-apply to) the next theme.
  for (const t of overlayTokens) root.style.removeProperty('--' + t);
  overlayTokens = new Set();
  const rc = S.rc || ls.get('rcCache', null);
  if (!rc) return;
  const pal = rc[THEME_PALETTE_KEYS[themeMode()]];
  if (!pal || typeof pal !== 'object') return;
  for (const [token, value] of Object.entries(pal)) {
    if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) { root.style.setProperty('--' + token, value); overlayTokens.add(token); }
  }
}
export function rcList(key, builtin) {
  const v = S.rc && S.rc[key];
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v;
  return builtin;
}
export function rcAnnouncement() {
  const v = S.rc && S.rc.announcement;
  return typeof v === 'string' ? v : '';
}
export function rcConnectionService() {
  const v = S.rc && S.rc.features;
  return !(v && v.connection_service === false);
}
async function fetchRemoteConfig() {
  try {
    const rows = await api.get('/app_config?select=key,value');
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    S.rc = map;
    ls.set('rcCache', map);
    applyPaletteOverlay();
  } catch { /* built-ins stay in effect */ }
}

// ---------------------------------------------------------------- e2ee session helpers
export function e2eeReady() { return !!(S.myPriv && S.partnerPub && S.coupleId); }
export async function sealText(plain) {
  if (!S.myPriv || !S.coupleId) return null;
  if (!S.partnerPub) await refreshPartnerKey();
  if (!S.partnerPub) return null;
  try { return await E.sealCombined(S.myPriv, S.partnerPub, plain); } catch { return null; }
}
export async function openText(combined) {
  if (!S.myPriv || !S.coupleId || !combined) return null;
  if (S.partnerPub) {
    try { return await E.openCombined(S.myPriv, S.partnerPub, combined); } catch { /* fall through to a key refresh + one retry */ }
  }
  // The cached partner key may be stale (the partner signed in on a new
  // browser and rotated their key). Refresh once and retry before
  // declaring the value unopenable.
  if (await refreshPartnerKeyIfChanged() && S.partnerPub) {
    try { return await E.openCombined(S.myPriv, S.partnerPub, combined); } catch { return null; }
  }
  return null;
}
export async function sealFileBytes(fileId, bytes) {
  if (!S.myPriv || !S.coupleId) return null;
  if (!S.partnerPub) await refreshPartnerKey();
  if (!S.partnerPub) return null;
  try { return await E.sealFile(S.myPriv, S.partnerPub, fileId, bytes); } catch { return null; }
}
export async function openFileBytes(fileId, blob) {
  if (!S.myPriv || !S.coupleId || !blob) return null;
  if (S.partnerPub) {
    try { return await E.openFile(S.myPriv, S.partnerPub, fileId, blob); } catch { /* fall through to a key refresh + one retry */ }
  }
  if (await refreshPartnerKeyIfChanged() && S.partnerPub) {
    try { return await E.openFile(S.myPriv, S.partnerPub, fileId, blob); } catch { return null; }
  }
  return null;
}
/** Opens a chat wire value; on failure refreshes the partner key once and retries. Throws if it still cannot open. */
export async function openChatWireRetry(wire, nonce, type) {
  if (!S.partnerPub) await refreshPartnerKey();
  try { return await E.openChatWire(S.myPriv, S.partnerPub, wire, nonce, type); }
  catch (e) {
    if (await refreshPartnerKeyIfChanged() && S.partnerPub) {
      return await E.openChatWire(S.myPriv, S.partnerPub, wire, nonce, type);
    }
    throw e;
  }
}
export async function refreshPartnerKey() {
  if (!S.partner) { S.partnerPub = null; return; }
  try {
    const rows = await api.get('/user_keys?user_id=eq.' + S.partner.id + '&select=public_key');
    const next = rows.length ? E.b64decode(rows[0].public_key) : null;
    const before = S.partnerPub ? E.b64encode(S.partnerPub) : '';
    const after = next ? E.b64encode(next) : '';
    if (before && after && before !== after) {
      S.partnerKeyChanged = true;
      toast('Your partner’s message key changed — they may have signed in on a new device. Compare safety numbers in Settings.');
    }
    S.partnerPub = next;
  } catch { /* transient error: keep the last known good key, never discard it */ }
}
let lastKeyRefreshAt = 0;
/** Refreshes the partner key (throttled); resolves true only when the key actually changed. */
export async function refreshPartnerKeyIfChanged(force) {
  const now = Date.now();
  if (!force && now - lastKeyRefreshAt < 3000) return false;
  lastKeyRefreshAt = now;
  const before = S.partnerPub ? E.b64encode(S.partnerPub) : '';
  await refreshPartnerKey();
  const after = S.partnerPub ? E.b64encode(S.partnerPub) : '';
  return before !== after;
}
async function publishMyKey() {
  await api.post('/user_keys', { user_id: uid(), public_key: E.b64encode(S.myPub) }, 'resolution=merge-duplicates');
}

// ---------------------------------------------------------------- couple loading
export async function loadCouple() {
  const hadCouple = !!S.coupleId;
  S.coupleId = ''; S.partner = null;
  const rows = await api.get('/couple_members?user_id=eq.' + uid() + '&select=couple_id');
  if (!rows.length) { await refreshPartnerKey(); return; }
  S.coupleId = rows[0].couple_id;
  const members = await api.get('/couple_members?couple_id=eq.' + S.coupleId + '&select=user_id');
  const partnerId = members.map((m) => m.user_id).find((x) => x !== uid());
  if (partnerId) {
    const profs = await api.get('/profiles?id=eq.' + partnerId + '&select=id,display_name,role,battery_share,arrival_share,avatar_data');
    S.partner = profs[0] || null;
  }
  await refreshPartnerKey();
  // Bug #8: when the couple link appears mid-session, prime the global
  // poll cursors first so the couple's history is not replayed as "new".
  if (!hadCouple && S.coupleId) await primeCursors();
  syncRealtime();
}
let coupleLoadInFlight = false;
/** Bug #1: while unlinked, quietly re-check whether the partner has joined; on the transition, re-render the current screen. */
export async function refreshCoupleLink(rerender) {
  if (!S.me || !S.unlocked || S.partner || coupleLoadInFlight) return;
  coupleLoadInFlight = true;
  try { await loadCouple(); } catch { /* next check retries */ }
  coupleLoadInFlight = false;
  if (S.partner && rerender) showScreen(S.screen, S.screenParam);
}

// ---------------------------------------------------------------- vibration + notifications
export const VIB_PATTERNS = { Gentle: [150], Heartbeat: [100, 80, 100, 80, 220], Excited: [80, 40, 80, 40, 80, 40, 240] };
export function vibPatternName() { return prefs().vibPattern || 'Gentle'; }
export function feelTap() {
  try { navigator.vibrate && navigator.vibrate(VIB_PATTERNS[vibPatternName()] || VIB_PATTERNS.Gentle); } catch { /* unsupported */ }
}
export function notify(title, body) {
  try {
    if (('Notification' in window) && Notification.permission === 'granted' && prefs().stayConnected !== false && rcConnectionService()) {
      new Notification(title, { body, icon: 'icon.svg' });
    }
  } catch { /* notifications are best-effort while the page is open */ }
}

// Message "ting": a short two-note bell synthesized with WebAudio — no
// audio file to ship or license. Browsers only allow sound after the
// user has interacted with the page, so the context is created/resumed
// lazily (and primed on the first tap anywhere); any block stays
// silent. Can be turned off in Settings → Notifications & feel.
let tingCtx = null;
export function playTing() {
  try {
    if (prefs().msgSound === false) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!tingCtx) tingCtx = new AC();
    if (tingCtx.state === 'suspended') tingCtx.resume().catch(() => {});
    const t0 = tingCtx.currentTime;
    const master = tingCtx.createGain();
    master.gain.setValueAtTime(0.9, t0);
    master.connect(tingCtx.destination);
    const note = (freq, at, dur, vol) => {
      const o = tingCtx.createOscillator(); const g = tingCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(master); o.start(at); o.stop(at + dur + 0.05);
    };
    note(1318.5, t0, 0.35, 0.20);        // E6
    note(1760.0, t0 + 0.09, 0.55, 0.16); // A6 — the bright "ting"
  } catch { /* sound is best-effort */ }
}
/** A shorter, softer single-note "tinn" for bottom-tab taps — the
 * user asked for a small sound when switching tabs so the tap feels
 * alive. Shares the Settings sound switch with the message ting. */
export function playTabTing() {
  try {
    if (prefs().msgSound === false) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!tingCtx) tingCtx = new AC();
    if (tingCtx.state === 'suspended') tingCtx.resume().catch(() => {});
    const t0 = tingCtx.currentTime;
    const o = tingCtx.createOscillator(); const g = tingCtx.createGain();
    o.type = 'sine'; o.frequency.value = 1567.98; // G6
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.10, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    o.connect(g); g.connect(tingCtx.destination); o.start(t0); o.stop(t0 + 0.2);
  } catch { /* sound is best-effort */ }
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pointerdown', () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!tingCtx) tingCtx = new AC();
      if (tingCtx.state === 'suspended') tingCtx.resume().catch(() => {});
    } catch { /* priming is best-effort */ }
  }, { passive: true });
}
/* Guaranteed tap feedback: CSS :active alone shows only while the
 * finger is down — too brief to notice on a quick tap, and on the
 * user's phone it was visible only in Settings. This adds a .pressed
 * class on pointerdown and keeps it until release (at least ~180ms),
 * so every button and row visibly dips on every tap, everywhere. */
if (typeof window !== 'undefined' && window.addEventListener) {
  const pressStart = new WeakMap();
  document.addEventListener('pointerdown', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('button, .hub-row, .list-row, .switch-row, .cream-ava, .partner-ava') : null;
    if (!t || t.disabled) return;
    pressStart.set(t, Date.now());
    t.classList.add('pressed');
  }, { passive: true });
  const releasePress = () => {
    document.querySelectorAll('.pressed').forEach((el) => {
      const wait = Math.max(0, 180 - (Date.now() - (pressStart.get(el) || 0)));
      setTimeout(() => el.classList.remove('pressed'), wait);
    });
  };
  document.addEventListener('pointerup', releasePress, { passive: true });
  document.addEventListener('pointercancel', releasePress, { passive: true });
}

// ---------------------------------------------------------------- onboarding + auth
registerScreen('onboarding', () => {
  appEl().innerHTML =
    '<div class="screen fill">' +
    '<div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:14px;text-align:center">' +
    '<div style="font-size:64px">💌</div>' +
    '<h1 class="display">US &amp; Always</h1>' +
    '<p class="lede">A private space for the two of you — and only the two of you.</p>' +
    '<div class="card" style="text-align:left"><h3>🔒 Private by design</h3><p class="muted small">Your messages are locked on this device before they are sent. Nobody in between — not even the server — can read them.</p></div>' +
    '<div class="card" style="text-align:left"><h3>🎲 Time together</h3><p class="muted small">Games, music, drawing, books and little daily rituals, shared across any distance.</p></div>' +
    '<div class="card" style="text-align:left"><h3>🌸 Your story</h3><p class="muted small">An album, a journey and a bucket list that belong to the two of you alone.</p></div>' +
    '</div>' +
    '<button class="btn btn-primary" id="ob-go">Get started</button>' +
    '</div>';
  document.getElementById('ob-go').onclick = () => showScreen('auth');
});

registerScreen('auth', () => {
  let mode = 'login';
  const render = () => {
    appEl().innerHTML =
      '<div class="screen fill"><h1 class="display">' + (mode === 'login' ? 'Welcome back' : 'Create your account') + '</h1>' +
      '<p class="lede">' + (mode === 'login' ? 'Sign in to open your private space.' : 'One account for you; your partner makes their own, then you link with a code.') + '</p>' +
      (mode === 'register' ?
        '<label class="field" for="a-name">Your name</label><input type="text" id="a-name" autocomplete="name" placeholder="Your name">' +
        '<label class="field">You are the</label><div class="chips" id="a-roles"><button class="chip selected" data-role="Husband">Husband</button><button class="chip" data-role="Wife">Wife</button></div>' : '') +
      '<label class="field" for="a-email">Email</label><input type="email" id="a-email" autocomplete="email" placeholder="you@example.com">' +
      '<label class="field" for="a-pass">Password</label><input type="password" id="a-pass" autocomplete="' + (mode === 'login' ? 'current-password' : 'new-password') + '" placeholder="Your password">' +
      '<p class="error-text" id="a-err"></p>' +
      '<button class="btn btn-primary" id="a-go">' + (mode === 'login' ? 'Sign in' : 'Create account') + '</button>' +
      '<button class="btn btn-ghost" id="a-swap">' + (mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in') + '</button>' +
      '<p class="tiny muted center">Your password is only ever sent to the sign-in service. Your message key is locked with it, here in this browser, and never leaves your device unencrypted.</p></div>';
    let role = 'Husband';
    const roles = document.getElementById('a-roles');
    if (roles) roles.querySelectorAll('.chip').forEach((c) => { c.onclick = () => { roles.querySelectorAll('.chip').forEach((x) => x.classList.remove('selected')); c.classList.add('selected'); role = c.dataset.role; }; });
    document.getElementById('a-swap').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; render(); };
    document.getElementById('a-go').onclick = async () => {
      const email = document.getElementById('a-email').value.trim();
      const password = document.getElementById('a-pass').value;
      const err = document.getElementById('a-err');
      const btn = document.getElementById('a-go');
      err.textContent = '';
      if (!email || !password) { err.textContent = 'Please enter your email and password.'; return; }
      btn.disabled = true; btn.textContent = 'Please wait…';
      try {
        if (mode === 'register') {
          const name = document.getElementById('a-name').value.trim();
          if (!name) throw new Error('Please enter your name.');
          // Bug #0: the auth user can be created while a later step
          // fails. Never strand the user with a raw database error —
          // always land in the sign-in / profile-completion path.
          try {
            await api.signUp(email, password);
          } catch (e) {
            // "User already registered" (bug #12): fall through and sign
            // in with the same credentials instead of aborting.
            if (!/already|exists|registered/i.test(e.message || '')) throw e;
          }
          if (!uid()) await api.logIn(email, password);
          if (!uid()) throw new Error('We could not read your new account. Please try signing in.');
          const existing = await api.get('/profiles?id=eq.' + uid() + '&select=id,display_name,role,battery_share,arrival_share,avatar_data');
          if (existing.length) {
            // Profile already exists for this account: continue as a
            // sign-in (afterLogin routes to key setup/unlock as needed).
            await afterLogin(password);
            toast('Welcome back — this account was already set up.');
            return;
          }
          try {
            await api.post('/profiles', { id: uid(), display_name: name, role });
          } catch (e) {
            if (e.status === 409) { await afterLogin(password); return; }
            // The account exists but the profile step failed: continue
            // into the profile-completion screen rather than showing a
            // raw error.
            showScreen('profileSetup', { password });
            toast('Your account was created — please finish this one step.');
            return;
          }
          S.me = { id: uid(), display_name: name, role, battery_share: false, arrival_share: false };
          await setupKeys(password, true);
          toast('Your account is ready.');
          offerPinSetup();
        } else {
          await api.logIn(email, password);
          await afterLogin(password);
        }
      } catch (e) {
        err.textContent = e.message || 'Something went wrong. Please try again.';
        btn.disabled = false; btn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      }
    };
  };
  render();
});

async function setupKeys(password, fresh) {
  const kp = E.generateKeyPair();
  S.myPriv = kp.privateKey; S.myPub = kp.publicKey;
  ls.set('wrappedKey:' + uid(), await E.wrapPrivateKey(kp.privateKey, password));
  await publishMyKey();
  S.unlocked = true;
}

async function afterLogin(password) {
  const profs = await api.get('/profiles?id=eq.' + uid() + '&select=id,display_name,role,battery_share,arrival_share,avatar_data');
  if (!profs.length) { showScreen('profileSetup', { password }); return; }
  S.me = profs[0];
  const wrapped = ls.get('wrappedKey:' + uid(), null);
  if (wrapped) {
    let unwrapped = true;
    try {
      S.myPriv = await E.unwrapPrivateKey(wrapped, password);
    } catch { unwrapped = false; }
    if (!unwrapped) {
      // Bug #6: this used to be a dead end — the error pointed at a
      // Settings action the user could never reach, because sign-in
      // itself was blocked. Offer the recovery right here instead.
      const ok = await confirmDlg(
        'This browser’s key can’t be opened',
        'The message key stored in this browser does not open with this password — this happens if the password was changed on another device. You can create a fresh key for this browser: new messages will work right away, but older messages that were sealed to the old key will not open here.',
        'Create a fresh key');
      if (!ok) throw new Error('Sign-in stopped: this browser’s key could not be opened with that password.');
      await setupKeys(password, false);
      toast('A fresh key was created for this browser. Compare safety numbers with your partner again (Settings).');
      await enterApp();
      return;
    }
    // Recompute the public key from the private key.
    S.myPub = E.publicFromPrivate(S.myPriv);
    // If the server still holds a different public key for me (for example
    // from another browser), republish this browser's key so my partner
    // can read what I send from here.
    try {
      const rows = await api.get('/user_keys?user_id=eq.' + uid() + '&select=public_key');
      if (!rows.length || rows[0].public_key !== E.b64encode(S.myPub)) await publishMyKey();
    } catch { /* will retry on next load */ }
  } else {
    await setupKeys(password, false);
    toast('A new message key was created for this browser. Compare safety numbers with your partner again (Settings).');
  }
  S.unlocked = true;
  await enterApp();
}

registerScreen('profileSetup', (param) => {
  appEl().innerHTML =
    '<div class="screen fill"><h1 class="display">One last step</h1>' +
    '<p class="lede">Tell the app who you are. Your partner will see this name.</p>' +
    '<label class="field" for="p-name">Your name</label><input type="text" id="p-name" placeholder="Your name">' +
    '<label class="field">You are the</label><div class="chips" id="p-roles"><button class="chip selected" data-role="Husband">Husband</button><button class="chip" data-role="Wife">Wife</button></div>' +
    '<p class="error-text" id="p-err"></p><button class="btn btn-primary" id="p-go">Save and continue</button></div>';
  let role = 'Husband';
  document.querySelectorAll('#p-roles .chip').forEach((c) => { c.onclick = () => { document.querySelectorAll('#p-roles .chip').forEach((x) => x.classList.remove('selected')); c.classList.add('selected'); role = c.dataset.role; }; });
  document.getElementById('p-go').onclick = async () => {
    const name = document.getElementById('p-name').value.trim();
    const err = document.getElementById('p-err');
    const btn = document.getElementById('p-go');
    if (!name) { err.textContent = 'Please enter your name.'; return; }
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      try {
        await api.post('/profiles', { id: uid(), display_name: name, role });
        S.me = { id: uid(), display_name: name, role, battery_share: false, arrival_share: false };
      } catch (e) {
        if (e.status !== 409) throw e;
        // Profile already exists (e.g. an earlier attempt got further
        // than it looked): fetch it and continue.
        const profs = await api.get('/profiles?id=eq.' + uid() + '&select=id,display_name,role,battery_share,arrival_share,avatar_data');
        if (!profs.length) throw e;
        S.me = profs[0];
      }
      await setupKeys(param.password, true);
      await enterApp();
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Save and continue';
    }
  };
});

function offerPinSetup() {
  const sh = sheet('<h3>Lock this app with a PIN?</h3><p class="muted">An optional 4-digit PIN for this browser, asked when the app opens. You can also set it later in Settings.</p>' +
    '<label class="field" for="pin-new">PIN (4 digits)</label><input type="password" inputmode="numeric" maxlength="4" id="pin-new" class="pin-input" style="letter-spacing:.3em">' +
    '<button class="btn btn-primary" id="pin-save">Save PIN</button><button class="btn btn-ghost" id="pin-skip">Not now</button>');
  sh.querySelector('#pin-skip').onclick = async () => { closeSheet(); await enterApp(); };
  sh.querySelector('#pin-save').onclick = async () => {
    const pin = sh.querySelector('#pin-new').value.trim();
    if (!/^\d{4}$/.test(pin)) { toast('Please enter 4 digits.'); return; }
    await setPin(pin);
    closeSheet();
    await enterApp();
  };
}
// Bug #13: PIN records are per account — on a shared browser, one
// partner's PIN must never gate the other's account.
export const pinKey = () => 'pin:' + uid();
export const secretPinKey = () => 'secretPin:' + uid();
export async function setPin(pin) {
  const salt = E.newSalt();
  ls.set(pinKey(), { salt: E.bytesToHex(salt), hash: await E.hashSecretHex(pin, salt), on: true });
}
export async function verifyPin(pin) {
  const p = ls.get(pinKey(), null);
  if (!p || !p.on) return true;
  const hash = await E.hashSecretHex(pin, E.hexToBytesLocal(p.salt));
  return hash === p.hash;
}
registerScreen('pinlock', (param) => {
  appEl().innerHTML =
    '<div class="lock-wrap"><div style="font-size:52px">🔒</div><h1 class="display">US &amp; Always</h1>' +
    '<p class="lede">Enter your PIN to open the app.</p>' +
    '<input type="password" inputmode="numeric" maxlength="4" id="lock-pin" class="pin-input" autocomplete="off">' +
    '<p class="error-text" id="lock-err"></p>' +
    '<button class="btn btn-primary" id="lock-go" style="max-width:240px">Open</button></div>';
  document.getElementById('lock-go').onclick = async () => {
    const pin = document.getElementById('lock-pin').value.trim();
    if (await verifyPin(pin)) { param && param.next && param.next(); }
    else document.getElementById('lock-err').textContent = 'That PIN is not right. Please try again.';
  };
});

registerScreen('unlock', () => {
  appEl().innerHTML =
    '<div class="screen fill"><h1 class="display">Welcome back</h1>' +
    '<p class="lede">You are signed in. Enter your account password once to unlock your encrypted messages on this browser — the key never leaves this device unencrypted.</p>' +
    '<label class="field" for="u-pass">Account password</label><input type="password" id="u-pass" autocomplete="current-password" placeholder="Your password">' +
    '<p class="error-text" id="u-err"></p><button class="btn btn-primary" id="u-go">Unlock</button>' +
    '<button class="btn btn-ghost" id="u-out">Sign out</button></div>';
  document.getElementById('u-out').onclick = async () => { await api.logOut(); location.reload(); };
  document.getElementById('u-go').onclick = async () => {
    const password = document.getElementById('u-pass').value;
    const err = document.getElementById('u-err');
    const btn = document.getElementById('u-go');
    btn.disabled = true; btn.textContent = 'Unlocking…'; err.textContent = '';
    try {
      await api.logIn(S.me ? (loadSessionEmail()) : '', password).catch(() => {});
      await afterLogin(password);
    } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Unlock'; }
  };
});
function loadSessionEmail() {
  const s = api.loadSession();
  return s && s.user ? (s.user.email || '') : '';
}

// ---------------------------------------------------------------- global pollers (events + new-message notices + scheduled sends)
/** Moves the global poll cursors to the newest event/message so history is never replayed as new. */
export async function primeCursors() {
  try {
    if (S.coupleId) {
      const ev = await api.get('/events?couple_id=eq.' + S.coupleId + '&order=id.desc&limit=1&select=id');
      if (ev.length) S.lastEventId = Math.max(S.lastEventId, ev[0].id);
      const ms = await api.get('/messages?couple_id=eq.' + S.coupleId + '&order=id.desc&limit=1&select=id');
      if (ms.length) S.lastMsgIdSeen = Math.max(S.lastMsgIdSeen, ms[0].id);
    }
  } catch { /* cursors keep their current values */ }
  S.eventsPrimed = true; S.msgsPrimed = true;
}
// ---------------------------------------------------------------- battery sharing (build 2026-11-18.12)
// ONE app-level sender for the whole session — the old sender lived
// inside the chat screen, so a partner who mostly stayed on Home never
// sent anything and the other side saw a battery level only sometimes.
// The loop runs whatever screen is open: it sends once at start, then
// re-checks about once a minute and on every level/charging change,
// but only POSTs when the percentage or charging state actually
// changed, and only while sharing is on (checked on every attempt, so
// turning the Settings switch off stops it at once). Wire format is
// unchanged: an events row, kind 'battery', payload = whole percent.
let batteryLoopStarted = false;
let batteryManager = null;
let lastBatterySent = null; // "<pct>|<charging>" signature of the last POST
async function sendBatteryIfChanged() {
  if (!S.me || !S.coupleId || !S.unlocked) return;
  if (!S.me.battery_share) { lastBatterySent = null; return; }
  if (!navigator.getBattery) return;
  try {
    const b = batteryManager || (batteryManager = await navigator.getBattery());
    const pct = Math.round(b.level * 100);
    const sig = pct + '|' + (b.charging ? '1' : '0');
    if (sig === lastBatterySent) return;
    lastBatterySent = sig;
    await api.post('/events', { couple_id: S.coupleId, sender_id: uid(), kind: 'battery', payload: String(pct) });
  } catch { /* battery is best-effort */ }
}
function startBatteryLoop() {
  if (batteryLoopStarted) return;
  batteryLoopStarted = true;
  sendBatteryIfChanged();
  setInterval(() => { if (!document.hidden) sendBatteryIfChanged(); }, 60000);
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      batteryManager = b;
      b.addEventListener('levelchange', () => sendBatteryIfChanged());
      b.addEventListener('chargingchange', () => sendBatteryIfChanged());
      sendBatteryIfChanged();
    }).catch(() => { /* the minute tick still covers it */ });
  }
}

let globalStarted = false;
function startGlobalLoops() {
  if (globalStarted) return;
  globalStarted = true;
  // Prime cursors so old events/messages never replay as new.
  primeCursors();
  startBatteryLoop();
  // Bug #1: while unlinked, poll slowly for the partner joining; the
  // transition re-renders whatever screen is open (loadCouple re-primes
  // the cursors first — bug #8).
  setInterval(() => { if (!document.hidden) refreshCoupleLink(true); }, 12000);
  setInterval(async () => {
    if (document.hidden || !S.me || !S.coupleId || !S.unlocked) return;
    try {
      const evs = await api.get('/events?couple_id=eq.' + S.coupleId + '&id=gt.' + S.lastEventId + '&order=id.asc&limit=50&select=id,sender_id,kind,payload');
      for (const ev of evs) {
        S.lastEventId = Math.max(S.lastEventId, ev.id);
        if (!S.eventsPrimed || ev.sender_id === uid()) continue;
        if (ev.kind === 'tap_to_feel') {
          feelTap();
          toast('💗 ' + (S.partner ? S.partner.display_name : 'Your partner') + ' is thinking of you — Tap to Feel received.');
          notify('Tap to Feel', (S.partner ? S.partner.display_name : 'Your partner') + ' sent you a tap.');
          const home = document.getElementById('home-live');
          if (home) { home.classList.remove('tap-flash'); void home.offsetWidth; home.classList.add('tap-flash'); }
        } else if (ev.kind === 'typing') {
          S.partnerTypingUntil = Date.now() + 5000;
          const t = document.getElementById('chat-typing');
          if (t) t.textContent = (S.partner ? S.partner.display_name : 'Your partner') + ' is typing…';
        } else if (ev.kind === 'battery') {
          const pct = parseInt(ev.payload, 10);
          if (!Number.isNaN(pct)) { S.partnerBattery = pct; const b = document.getElementById('home-battery'); if (b) b.textContent = 'Your partner’s battery: ' + pct + '%'; const cb = document.getElementById('cream-batt-sub'); if (cb) cb.textContent = 'Battery ' + pct + '%'; }
        } else if (ev.kind === 'presence' && String(ev.payload || '').startsWith('arrival:')) {
          const label = ev.payload.substring('arrival:'.length);
          toast('📍 ' + (S.partner ? S.partner.display_name : 'Your partner') + ' reached ' + label + '.');
          notify('Arrival', (S.partner ? S.partner.display_name : 'Your partner') + ' reached ' + label + '.');
        }
      }
      if (S.screen !== 'chat') {
        const ms = await api.get('/messages?couple_id=eq.' + S.coupleId + '&id=gt.' + S.lastMsgIdSeen + '&order=id.asc&limit=20&select=id,sender_id');
        for (const m of ms) {
          S.lastMsgIdSeen = Math.max(S.lastMsgIdSeen, m.id);
          // While realtime is connected it delivers (and notifies)
          // instantly — the poller must not notify a second time.
          if (S.msgsPrimed && m.sender_id !== uid() && !rtConnected) { notify('New message', (S.partner ? S.partner.display_name : 'Your partner') + ' sent you a message.'); playTing(); }
        }
      } else {
        const ms = await api.get('/messages?couple_id=eq.' + S.coupleId + '&order=id.desc&limit=1&select=id');
        if (ms.length) S.lastMsgIdSeen = Math.max(S.lastMsgIdSeen, ms[0].id);
      }
      refreshUnreadBadge();
    } catch { /* next tick retries */ }
  }, 5000);
  // Scheduled + surprise messages: sent while this page is open (same honest limit as Android).
  setInterval(async () => {
    if (document.hidden || !e2eeReady()) return;
    const key = 'scheduled:' + S.coupleId;
    const items = ls.get(key, []);
    if (!items.length) return;
    const now = Date.now();
    const due = items.filter((i) => i.sendAtMs <= now);
    if (!due.length) return;
    // Bug #11: a due message that cannot be opened or sent right now
    // (e.g. the key changed since it was scheduled) stays in storage
    // for the next tick and the user is told — it is never silently
    // discarded.
    const remaining = items.filter((i) => i.sendAtMs > now);
    let sent = 0, failed = 0;
    for (const item of due) {
      const plain = await openText(item.sealed);
      if (plain === null) { remaining.push(item); failed++; continue; }
      try {
        await sendChatTextNow(item.surprise ? 'USSURPRISE1:' + plain : plain, 'main', null, 0);
        sent++;
      } catch { remaining.push(item); failed++; }
    }
    ls.set(key, remaining);
    if (failed) toast('A scheduled message could not be sent yet — it is kept and will be retried while this page is open.');
    if (sent && S.screen === 'chat') showScreen('chat', S.screenParam);
  }, 5000);
}
export async function sendChatTextNow(wirePlain, thread, replyToId, expiresAtMs) {
  const sealed = await E.sealChatText(S.myPriv, S.partnerPub, wirePlain);
  const body = {
    couple_id: S.coupleId, sender_id: uid(), ciphertext: sealed.wire, nonce: sealed.nonce,
    type: 'text', thread: thread || 'main',
    reply_to_id: replyToId || null,
    expires_at: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
  };
  const rows = await api.post('/messages', body, 'return=representation');
  return rows[0];
}

// ---------------------------------------------------------------- realtime + unread badge
// WhatsApp-style delivery while the app is open: a Supabase Realtime
// socket (js/realtime.mjs, hand-written Phoenix protocol) pushes new
// messages in instantly, and a server-counted unread badge sits on the
// Chat tab. The pre-existing polling stays as the fallback — while the
// socket is live the chat poll relaxes and the global poller stops
// double-notifying; when it drops, behaviour is exactly as before.
let rtClient = null;
let rtConnected = false;
let chatScreenReload = null; // set while the chat screen is mounted
let playbackRtHandler = null; // set while a Listen/Watch screen is mounted
/** Registers the open Together screen's playback_state handler (null clears it). */
export function setPlaybackHandler(fn) { playbackRtHandler = fn || null; }
let unreadCount = 0;
let badgeInFlight = false;
let badgePending = false;

/** Applies an unread count everywhere it shows: the Chat tab badge and the installed-app icon badge. */
function setUnreadCount(n) {
  unreadCount = Math.max(0, Math.floor(Number(n) || 0));
  renderUnreadBadge();
  try {
    if (unreadCount > 0 && navigator.setAppBadge) navigator.setAppBadge(unreadCount);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch { /* app badging is best-effort */ }
}
export function renderUnreadBadge() {
  const btn = document.querySelector('#tabbar button[data-tab="chat"]');
  if (!btn) return;
  const label = badgeLabel(unreadCount);
  let badge = btn.querySelector('.tab-badge');
  if (!label) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'tab-badge';
    btn.appendChild(badge);
  }
  badge.textContent = label;
}
/** Recomputes the unread count from the server — never guessed locally, so it cannot drift or flicker backwards. */
export async function refreshUnreadBadge() {
  if (!S.me || !S.coupleId) { setUnreadCount(0); return; }
  if (badgeInFlight) { badgePending = true; return; }
  badgeInFlight = true;
  try {
    const n = await api.countRows('/messages?couple_id=eq.' + S.coupleId + '&sender_id=neq.' + uid() + '&read_at=is.null&select=id');
    if (typeof n === 'number') setUnreadCount(n);
  } catch { /* keep the last known count; the next tick retries */ }
  badgeInFlight = false;
  if (badgePending) { badgePending = false; refreshUnreadBadge(); }
}
function realtimeCatchUp() {
  // On (re)connect, pull anything the socket missed while it was down.
  if (chatScreenReload && S.screen === 'chat') chatScreenReload();
  refreshUnreadBadge();
}
function onRealtimeMessage(evt) {
  if (evt.record && evt.record.id) S.lastMsgIdSeen = Math.max(S.lastMsgIdSeen, evt.record.id);
  // A partner message arriving live gets the "ting" (both when the
  // user is elsewhere in the app and while watching the chat).
  if (evt.type === 'INSERT' && evt.record && evt.record.sender_id && evt.record.sender_id !== uid()) playTing();
  const action = realtimeMessageAction({
    screen: S.screen, eventType: evt.type,
    senderId: evt.record ? evt.record.sender_id : null, myId: uid(),
  });
  if (action === 'reload' && chatScreenReload) chatScreenReload();
  if (action === 'notify') notify('New message', (S.partner ? S.partner.display_name : 'Your partner') + ' sent you a message.');
  refreshUnreadBadge();
}
/** Keeps the realtime subscription pointed at the current couple. Safe to call any time. */
function syncRealtime() {
  if (!S.unlocked || !uid()) { if (rtClient) rtClient.setCouple(''); return; }
  if (!rtClient) {
    rtClient = createRealtimeClient({
      onEvent: onRealtimeMessage,
      onPlayback: (evt) => {
        if (playbackRtHandler && evt.record) {
          try { playbackRtHandler(evt.record); } catch { /* a bad row must not kill delivery */ }
        }
      },
      onStatus: (connected) => {
        rtConnected = connected;
        if (connected) realtimeCatchUp();
      },
    });
  }
  rtClient.setCouple(S.coupleId || '');
}

// ---------------------------------------------------------------- enter the app
export async function enterApp() {
  if (!S.me) {
    const profs = await api.get('/profiles?id=eq.' + uid() + '&select=id,display_name,role,battery_share,arrival_share,avatar_data');
    S.me = profs[0] || null;
  }
  if (!ls.get(prefKey('startDate'), null)) ls.set(prefKey('startDate'), todayIso());
  await loadCouple();
  await fetchRemoteConfig();
  startGlobalLoops();
  refreshUnreadBadge();
  showScreen('home');
}

// ---------------------------------------------------------------- Home
registerScreen('home', () => {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning, my love.' : hour < 17 ? 'Good afternoon, my love.' : 'Good evening, my love.';
  const days = daysTogether();
  const ann = rcAnnouncement();
  const annDismissed = ls.get('announceDismissed', '');
  const themeBtn = '<button class="icon-btn" id="h-theme" aria-label="Switch theme">' + ({ dark: '🌙', cream: '🌅', warm: '☀️' }[nextTheme()]) + '</button>';
  // Anniversary card (computed once; both Home layouts use it)
  const sd = startDate();
  const today = new Date(); const start = new Date(sd + 'T00:00:00');
  const annivThisYear = new Date(today.getFullYear(), start.getMonth(), start.getDate());
  const diffDays = Math.round((annivThisYear - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  let annivHtml = '';
  if (diffDays === 0 && todayIso() !== sd) annivHtml = '<div class="card"><h3>🎉 Happy anniversary!</h3><p class="muted small">Today is your special day.</p></div>';
  else if (diffDays > 0 && diffDays <= 7) annivHtml = '<div class="card"><h3>🎉 Your anniversary is coming up</h3><p class="muted small">Your anniversary is coming up on ' + annivThisYear.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + '.</p></div>';
  // Morning Cream gets a structurally different Home (reference layout);
  // Warm Editorial and Dark Luxe render exactly as before.
  if (themeMode() === 'cream') { renderCreamHome({ ann, annDismissed, annivHtml, days }); return; }
  let html = topbar('US & Always', { right: themeBtn });
  html += '<div class="screen fill" id="home-live">';
  if (ann && ann !== annDismissed) html += '<div class="announce"><span>📣 ' + esc(ann) + '</span><button id="h-ann-x">Dismiss</button></div>';
  html += '<p class="lede" style="margin-top:6px">' + esc(greeting) + '</p>';
  html += annivHtml;
  // Partner card
  html += '<div class="card">';
  if (S.partner) {
    html += '<div class="flex"><div class="partner-ava" id="h-pava" title="View photo">' + avatarInner(S.partner) + '</div><div class="grow"><div style="font-size:17px;font-weight:600">' + esc(S.partner.display_name) + '</div><div class="muted small">' + esc(S.partner.role) + ' · Linked with you</div></div></div>';
    html += '<div style="margin-top:14px" class="flex"><span class="hero-days">' + days + '</span><span class="muted">' + (days === 1 ? 'day together' : 'days together') + '</span></div>';
    html += '<p class="small" id="home-streak" style="margin:10px 0 0">' + esc(homeCache.streakText && homeCache.coupleId === S.coupleId ? homeCache.streakText : 'Loading your streak…') + '</p>';
    html += '<p class="small muted" id="home-checkin" style="margin:4px 0 0">' + esc(homeCache.coupleId === S.coupleId && homeCache.checkinDay === todayIso() && homeCache.checkinMood ? 'Today’s check-ins — You: ' + homeCache.checkinMood + ' · ' + S.partner.display_name + ': …' : 'Loading today’s check-ins…') + '</p>';
    html += '<p class="small muted" id="home-battery" style="margin:4px 0 0">' + (S.partnerBattery !== null ? 'Your partner’s battery: ' + S.partnerBattery + '%' : (S.partner.battery_share ? 'Your partner’s battery will appear here once they open the app with sharing on.' : 'Battery sharing is off. Turn it on in Settings if you both want it.')) + '</p>';
    html += '<p class="tiny muted" style="margin:8px 0 0">Only your two devices can read your messages — each one is locked before it leaves your device, and nobody in between can open it.</p>';
    html += '<div style="height:12px"></div><button class="btn btn-primary" id="h-tap">💗 Tap to Feel</button>';
    html += '<p class="tiny muted center" id="h-tap-status" style="margin:6px 0 0"></p>';
  } else {
    html += '<h3>Your partner has not linked yet</h3><p class="muted small">Share your invitation code from Settings so the two of you can connect.</p>';
    html += '<div style="margin-top:10px" class="flex"><span class="hero-days">' + days + '</span><span class="muted">' + (days === 1 ? 'day together' : 'days together') + '</span></div>';
    html += '<div style="height:12px"></div><button class="btn btn-primary" id="h-link">Link with your partner</button>';
  }
  html += '</div>';
  // Quick actions
  html += '<div class="card"><h2 class="section" style="margin-top:0">Just the two of you</h2><div style="height:8px"></div>' +
    '<div class="btn-row"><button class="btn btn-soft" id="h-chat">💬 Open your private chat</button></div><div style="height:10px"></div>' +
    '<div class="btn-row"><button class="btn btn-soft" id="h-checkin">🌸 Daily check-in</button><button class="btn btn-soft" id="h-room">🏠 Open our room</button></div>' +
    '<div style="height:10px"></div><div class="btn-row"><button class="btn btn-soft" id="h-bucket">✨ Our bucket list</button></div>' +
    '<p class="small" id="home-bucket-next" style="margin:8px 0 0">Loading your dreams…</p>' +
    '<p class="tiny muted" id="home-bucket-sub" style="margin:2px 0 0">Things you want to do together one day</p>' +
    '<p class="tiny muted" style="margin:10px 0 0">You can schedule a message from the chat screen; it is sent while this page is open.</p></div>';
  html += '<div class="grow"></div></div>';
  appEl().innerHTML = html;
  document.getElementById('h-theme').onclick = () => { setTheme(nextTheme()); showScreen('home'); };
  const pava = document.getElementById('h-pava');
  if (pava) pava.onclick = () => openAvatarViewer(S.partner, { partner: true, chat: true });
  const annX = document.getElementById('h-ann-x');
  if (annX) annX.onclick = () => { ls.set('announceDismissed', ann); showScreen('home'); };
  const linkBtn = document.getElementById('h-link');
  if (linkBtn) linkBtn.onclick = () => showScreen('settings');
  const tap = document.getElementById('h-tap');
  if (tap) tap.onclick = async () => {
    const status = document.getElementById('h-tap-status');
    tap.disabled = true;
    try {
      await api.post('/events', { couple_id: S.coupleId, sender_id: uid(), kind: 'tap_to_feel', payload: '' });
      status.textContent = 'Sent. Your partner will feel it when their app is open.';
    } catch (e) {
      status.textContent = 'Could not send: ' + e.message;
    }
    tap.disabled = false;
  };
  document.getElementById('h-chat').onclick = () => showScreen('chat');
  document.getElementById('h-checkin').onclick = () => showScreen('checkin');
  document.getElementById('h-room').onclick = () => showScreen('room');
  const hb = document.getElementById('h-bucket');
  if (hb) hb.onclick = () => showScreen('bucket');
  if (S.partner) { loadHomeLive(); loadHomeBucket(); }
});

// ---------------------------------------------------------------- Home — Morning Cream layout
// A structural re-skin of the same Home data and actions in the
// reference layout: greeting header with avatar, a real week strip,
// a peach highlight card, routine-style rows with state markers, and
// a floating compose button. Rendered only when themeMode()==='cream'.
function renderCreamHome({ ann, annDismissed, annivHtml, days }) {
  const now = new Date();
  const hour = now.getHours();
  const greetWord = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const myName = S.me && S.me.display_name ? S.me.display_name : '';
  const firstName = myName.trim().split(/\s+/)[0] || 'friend';
  const dateLine = now.toLocaleDateString('en-GB', { weekday: 'long' }) + ', ' + now.getDate() + ' ' +
    now.toLocaleDateString('en-GB', { month: 'long' }) + ', ' + now.getFullYear();
  // The real current week (Mon–Sun); today is the filled day.
  const dowNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const todayDow = (now.getDay() + 6) % 7; // Monday = 0
  let weekHtml = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(now.getDate() - todayDow + i);
    weekHtml += '<div class="cream-day' + (i === todayDow ? ' today' : '') + '"><span class="cream-dow">' + dowNames[i] + '</span><span class="cream-dnum">' + d.getDate() + '</span></div>';
  }
  const themeBtn = '<button class="icon-btn cream-theme-btn" id="h-theme" aria-label="Switch theme">' + ({ dark: '🌙', cream: '🌅', warm: '☀️' }[nextTheme()]) + '</button>';
  let html = '<div class="screen fill" id="home-live">';
  // Header: greeting + date, theme toggle, partner avatar (→ Chat).
  html += '<div class="cream-head"><div class="grow"><h1 class="cream-greet">' + esc(greetWord) + ', ' + esc(firstName) + '.</h1>' +
    '<p class="cream-date">' + esc(dateLine) + '</p></div>' + themeBtn +
    '<button class="cream-ava" id="h-ava" aria-label="' + (S.partner ? 'View ' + esc(S.partner.display_name) + '’s photo' : 'Open Settings to link with your partner') + '">' + avatarInner(S.partner ? S.partner : S.me) + '</button></div>';
  html += '<div class="cream-week">' + weekHtml + '</div>';
  // Peach highlight card: an announcement takes this slot when one is
  // live; otherwise it is the couple card (or the link card).
  const showAnn = ann && ann !== annDismissed;
  if (showAnn) {
    html += '<div class="cream-hero"><div class="cream-hero-text"><h2 class="cream-hero-title">A note for the two of you</h2>' +
      '<p class="cream-hero-desc">' + esc(ann) + '</p>' +
      '<button class="cream-hero-btn" id="h-ann-x">Dismiss</button></div><div class="cream-hero-art" aria-hidden="true">📣</div></div>';
  } else if (S.partner) {
    const heroDesc = S.partnerBattery !== null
      ? esc(S.partner.display_name) + '’s battery is at ' + S.partnerBattery + '% right now.'
      : (days === 0 ? 'Your very first day together — counting the days with you.'
        : (days === 1 ? 'Day 1 together' : 'Day ' + days + ' together') + ' — counting the days with you.');
    const streakText = homeCache.streakText && homeCache.coupleId === S.coupleId ? homeCache.streakText : 'Loading your streak…';
    html += '<div class="cream-hero"><div class="cream-hero-text"><h2 class="cream-hero-title">' + esc(S.partner.display_name) + '</h2>' +
      '<p class="cream-hero-desc">' + heroDesc + '</p>' +
      '<p class="cream-hero-streak" id="home-streak">' + esc(streakText) + '</p>' +
      '<button class="cream-hero-btn" id="h-hero-chat">Say hello</button></div><div class="cream-hero-art" aria-hidden="true">💗</div></div>';
    html += '<p class="tiny muted" style="margin:2px 4px 0">Only your two devices can read your messages — each one is locked before it leaves your device, and nobody in between can open it.</p>';
  } else {
    html += '<div class="cream-hero"><div class="cream-hero-text"><h2 class="cream-hero-title">Your partner has not linked yet</h2>' +
      '<p class="cream-hero-desc">Share your invitation code from Settings so the two of you can connect.</p>' +
      '<p class="cream-hero-streak">' + days + (days === 1 ? ' day together' : ' days together') + '</p>' +
      '<button class="cream-hero-btn" id="h-link">Link with your partner</button></div><div class="cream-hero-art" aria-hidden="true">💌</div></div>';
  }
  html += annivHtml;
  // Today: routine-style rows reusing the real check-in / tap / battery.
  if (S.partner) {
    const cachedMood = homeCache.coupleId === S.coupleId && homeCache.checkinDay === todayIso() ? homeCache.checkinMood : '';
    html += '<div class="cream-sec-head"><h2 class="cream-sec-title">Today</h2><button class="cream-sec-link" id="h-room">Open Room</button></div>';
    html += '<div class="cream-list">';
    html += '<button class="cream-row" id="h-checkin"><span class="cream-marker' + (cachedMood ? ' done' : '') + '" id="cream-ci-marker">' + (cachedMood ? '✓' : '') + '</span>' +
      '<span class="cream-tile tile-pink">🌸</span><span class="cream-row-text"><span class="cream-row-name">Daily check-in</span>' +
      '<span class="cream-row-sub" id="cream-ci-sub">' + (cachedMood ? 'You: ' + esc(cachedMood) + ' · ' + esc(S.partner.display_name) + ': …' : 'Loading today’s check-ins…') + '</span></span><span class="cream-chev">›</span></button>';
    html += '<button class="cream-row" id="h-tap"><span class="cream-marker"></span>' +
      '<span class="cream-tile tile-peach">💗</span><span class="cream-row-text"><span class="cream-row-name">Tap to Feel</span>' +
      '<span class="cream-row-sub" id="cream-tap-sub">Send a tap</span></span></button>';
    if (S.partner.battery_share) {
      html += '<div class="cream-row static"><span class="cream-marker"></span>' +
        '<span class="cream-tile tile-mint">🔋</span><span class="cream-row-text"><span class="cream-row-name">' + esc(S.partner.display_name) + '’s battery</span>' +
        '<span class="cream-row-sub" id="cream-batt-sub">' + (S.partnerBattery !== null ? 'Battery ' + S.partnerBattery + '%' : 'Sharing is on — it appears once their app is open') + '</span></span></div>';
    }
    html += '</div>';
    html += '<p class="tiny muted" id="h-tap-status" style="margin:0 4px"></p>';
  }
  // Quick sections as routine-style rows with cycling pastel tiles.
  const quickRows = [
    ['h-chat', '💬', 'Private chat', 'Messages, photos and voice notes, locked end to end', 'chat'],
    ['h-together', '🎵', 'Together', 'Playlist, listen, watch, draw and read — side by side', 'together'],
    ['h-memories', '💌', 'Memories', 'Album, journey, bucket list and gifts', 'memories'],
  ];
  const tileCycle = ['tile-peach', 'tile-mint', 'tile-pink'];
  html += '<div class="cream-sec-head"><h2 class="cream-sec-title">Just the two of you</h2></div>';
  html += '<div class="cream-list">' + quickRows.map((r, i) =>
    '<button class="cream-row" id="' + r[0] + '"><span class="cream-marker"></span>' +
    '<span class="cream-tile ' + tileCycle[i % 3] + '">' + r[1] + '</span><span class="cream-row-text"><span class="cream-row-name">' + r[2] + '</span>' +
    '<span class="cream-row-sub">' + r[3] + '</span></span><span class="cream-chev">›</span></button>').join('') + '</div>';
  // Bucket list on Home: next dream + counts, filled live; tap → the list.
  if (S.partner) {
    html += '<div class="cream-sec-head"><h2 class="cream-sec-title">Our bucket list</h2><button class="cream-sec-link" id="h-bucket-all">See all</button></div>';
    html += '<div class="cream-list"><button class="cream-row" id="h-bucket"><span class="cream-marker"></span>' +
      '<span class="cream-tile tile-peach">✨</span><span class="cream-row-text"><span class="cream-row-name" id="cream-bucket-next">Loading your dreams…</span>' +
      '<span class="cream-row-sub" id="cream-bucket-sub">Things you want to do together one day</span></span><span class="cream-chev">›</span></button></div>';
  }
  // Floating compose button — a real action: it opens the chat.
  html += '<button class="cream-fab" id="h-fab" aria-label="Write a message">✎</button>';
  html += '<div class="grow"></div><div style="height:84px;flex:none"></div></div>';
  appEl().innerHTML = html;
  document.getElementById('h-theme').onclick = () => { setTheme(nextTheme()); showScreen('home'); };
  const annX = document.getElementById('h-ann-x');
  if (annX) annX.onclick = () => { ls.set('announceDismissed', ann); showScreen('home'); };
  document.getElementById('h-ava').onclick = () => { if (S.partner) openAvatarViewer(S.partner, { partner: true, chat: true }); else showScreen('settings'); };
  const linkBtn = document.getElementById('h-link');
  if (linkBtn) linkBtn.onclick = () => showScreen('settings');
  const heroChat = document.getElementById('h-hero-chat');
  if (heroChat) heroChat.onclick = () => showScreen('chat');
  document.getElementById('h-fab').onclick = () => showScreen('chat');
  for (const [id, , , , target] of quickRows) document.getElementById(id).onclick = () => showScreen(target);
  if (S.partner) {
    document.getElementById('h-checkin').onclick = () => showScreen('checkin');
    document.getElementById('h-room').onclick = () => showScreen('room');
    const tap = document.getElementById('h-tap');
    tap.onclick = async () => {
      const status = document.getElementById('h-tap-status');
      tap.disabled = true;
      try {
        await api.post('/events', { couple_id: S.coupleId, sender_id: uid(), kind: 'tap_to_feel', payload: '' });
        status.textContent = 'Sent. Your partner will feel it when their app is open.';
        loadCreamTap();
      } catch (e) {
        status.textContent = 'Could not send: ' + e.message;
      }
      tap.disabled = false;
    };
    const bk = document.getElementById('h-bucket');
    if (bk) bk.onclick = () => showScreen('bucket');
    const bka = document.getElementById('h-bucket-all');
    if (bka) bka.onclick = () => showScreen('bucket');
    loadHomeLive();
    loadCreamTap();
    loadHomeBucket();
  }
}
/** Fills the Home bucket-list line (both designs) with the real next
 * dream and the counts; titles are sealed, so they are opened here
 * with the couple key exactly like the Bucket List screen does. */
async function loadHomeBucket() {
  try {
    const rows = await api.get('/bucket_items?couple_id=eq.' + S.coupleId + '&order=id.asc&select=id,title,done');
    const nextEl = document.getElementById('cream-bucket-next') || document.getElementById('home-bucket-next');
    if (!nextEl) return;
    const subEl = document.getElementById('cream-bucket-sub') || document.getElementById('home-bucket-sub');
    const done = rows.filter((r) => r.done).length;
    const next = rows.find((r) => !r.done);
    if (!rows.length) {
      nextEl.textContent = 'Dream your first one together';
      if (subEl) subEl.textContent = 'Tap to start your list';
      return;
    }
    if (next) nextEl.textContent = 'Next: ' + ((await openText(next.title)) || 'A dream waiting to be opened');
    else nextEl.textContent = 'Every dream done — time for new ones';
    if (subEl) subEl.textContent = rows.length + (rows.length === 1 ? ' dream' : ' dreams') + ' · ' + done + ' done';
  } catch { /* keep the placeholder line */ }
}
/** Fills the cream Tap to Feel sub-line with the real last tap (events table). */
async function loadCreamTap() {
  try {
    const rows = await api.get('/events?couple_id=eq.' + S.coupleId + '&kind=eq.tap_to_feel&order=id.desc&limit=1&select=sender_id,created_at');
    const el = document.getElementById('cream-tap-sub');
    if (!el) return;
    if (!rows.length) { el.textContent = 'Send a tap'; return; }
    const when = tapWhen(new Date(rows[0].created_at));
    el.textContent = rows[0].sender_id === uid()
      ? 'You sent the last tap · ' + when
      : (S.partner ? S.partner.display_name : 'Your partner') + ' sent the last tap · ' + when;
  } catch { /* the row keeps its default sub-line */ }
}
function tapWhen(d) {
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = todayIso(d);
  if (day === todayIso()) return 'today at ' + time;
  if (day === prevIsoDay(todayIso())) return 'yesterday at ' + time;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' at ' + time;
}
export function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}
/** Inner HTML for an avatar circle: the person's profile photo when
 * they have set one (a small JPEG data URL stored on their profile),
 * otherwise their initials. Only data:image URLs are ever rendered. */
export function avatarInner(person) {
  if (person && typeof person.avatar_data === 'string' && person.avatar_data.startsWith('data:image/')) {
    return '<img alt="" src="' + person.avatar_data + '">';
  }
  return esc(initials(person ? person.display_name : '?'));
}
/** WhatsApp-style profile-photo viewer: tapping an avatar opens the
 * photo large, with the person's name. For the partner it first
 * re-fetches their profile, so a photo they added a minute ago shows
 * without waiting for a reload. */
export async function openAvatarViewer(person, opts) {
  let p = person;
  if (opts && opts.partner && S.partner && person && person.id === S.partner.id) {
    try {
      const rows = await api.get('/profiles?id=eq.' + S.partner.id + '&select=id,display_name,role,battery_share,arrival_share,avatar_data');
      if (rows && rows[0]) { S.partner = rows[0]; p = rows[0]; }
    } catch { /* fall back to what we already have */ }
  }
  const has = p && typeof p.avatar_data === 'string' && p.avatar_data.startsWith('data:image/');
  const sh = sheet(
    '<div class="ava-view">' +
    (has ? '<img class="ava-full" alt="Profile photo" src="' + p.avatar_data + '">' : '<div class="ava-full ava-initials">' + esc(initials(p ? p.display_name : '?')) + '</div>') +
    '<h3 style="text-align:center;margin:12px 0 2px">' + esc(p ? p.display_name : '') + '</h3>' +
    (has ? '' : '<p class="muted small" style="text-align:center;margin:0">No profile photo yet.</p>') +
    '<div style="height:12px"></div>' +
    ((opts && opts.chat) ? '<button class="btn btn-primary" id="av-chat">Send a message</button>' : '') +
    ((opts && opts.change) ? '<button class="btn btn-soft" id="av-change">Change photo</button>' : '') +
    '<button class="btn btn-ghost" id="av-x">Close</button></div>'
  );
  sh.querySelector('#av-x').onclick = closeSheet;
  const chatBtn = sh.querySelector('#av-chat');
  if (chatBtn) chatBtn.onclick = () => { closeSheet(); showScreen('chat'); };
  const chBtn = sh.querySelector('#av-change');
  if (chBtn) chBtn.onclick = () => { closeSheet(); const f = document.getElementById('s-ava-file'); if (f) f.click(); };
}
/** Turns a picked image file into a small profile-photo data URL:
 * centre-cropped to a square and shrunk to 256×256 JPEG before it is
 * stored — the original file never leaves the device. If the result
 * is still over ~120 KB it is re-encoded once, smaller and lighter;
 * beyond that the caller shows an honest error. */
export function fileToAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || '')) { reject(new Error('not-image')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) { reject(new Error('bad-image')); return; }
      const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
      const encode = (size, q) => {
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
        return c.toDataURL('image/jpeg', q);
      };
      let out = encode(256, 0.8);
      if (out.length > 120 * 1024) out = encode(176, 0.65);
      if (out.length > 120 * 1024) { reject(new Error('too-big')); return; }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad-image')); };
    img.src = url;
  });
}
// Live obs (b)/(c): the last computed Home streak + my today's check-in
// mood are cached per couple, so returning to Home shows them instantly
// (no flip back to "Loading…", no stale "You: Not yet" right after a
// check-in save) while loadHomeLive refreshes them in the background.
const homeCache = { coupleId: '', streakText: '', checkinDay: '', checkinMood: '' };
export function cacheMyCheckin(mood) {
  homeCache.coupleId = S.coupleId;
  homeCache.checkinDay = todayIso();
  homeCache.checkinMood = mood;
}
async function loadHomeLive() {
  try {
    const today = todayIso();
    const checkins = await api.get('/checkins?couple_id=eq.' + S.coupleId + '&day=eq.' + today + '&select=user_id,mood');
    const mine = checkins.find((c) => c.user_id === uid());
    const theirs = checkins.find((c) => c.user_id !== uid());
    if (mine) cacheMyCheckin(mine.mood);
    const myMood = mine ? mine.mood : (homeCache.coupleId === S.coupleId && homeCache.checkinDay === today ? homeCache.checkinMood : '');
    const ci = document.getElementById('home-checkin');
    if (ci) ci.textContent = 'Today’s check-ins — You: ' + (myMood || 'Not yet') + ' · ' + (S.partner ? S.partner.display_name : 'Partner') + ': ' + (theirs ? theirs.mood : 'Not yet');
    // Morning Cream Home: same live data fills the routine row
    // (sub-line + the circular done marker). Elements exist only in
    // the cream layout, so the classic themes are untouched.
    const csub = document.getElementById('cream-ci-sub');
    if (csub) csub.textContent = 'You: ' + (myMood || 'Not yet') + ' · ' + (S.partner ? S.partner.display_name : 'Partner') + ': ' + (theirs ? theirs.mood : 'Not yet');
    const cmark = document.getElementById('cream-ci-marker');
    if (cmark) { const done = !!myMood; cmark.classList.toggle('done', done); cmark.textContent = done ? '✓' : ''; }
    // Streak: days with a check-in (either partner) or a message, up to today.
    const days = new Set(checkins.map(() => today));
    const allCheckins = await api.get('/checkins?couple_id=eq.' + S.coupleId + '&select=day');
    allCheckins.forEach((c) => days.add(c.day));
    const msgs = await api.get('/messages?couple_id=eq.' + S.coupleId + '&select=created_at&order=id.desc&limit=1000');
    msgs.forEach((m) => days.add(todayIso(new Date(m.created_at))));
    let streak = 0; let cursor = today;
    if (!days.has(cursor)) { cursor = prevIsoDay(cursor); }
    while (days.has(cursor)) { streak++; cursor = prevIsoDay(cursor); }
    const streakText = streak > 0 ? '🔥 Together streak: ' + streak + (streak === 1 ? ' day' : ' days') : 'Your together streak starts with a message or a check-in.';
    homeCache.coupleId = S.coupleId;
    homeCache.streakText = streakText;
    const st = document.getElementById('home-streak');
    if (st) st.textContent = streakText;
    // Partner battery: seed from their LATEST battery event so Home
    // shows the last level they sent while their app was open, instead
    // of starting blank on every load and only filling if a new event
    // happens to arrive live (build 2026-11-18.12). Only when the
    // partner shares at all — while sharing is off, nothing is shown.
    if (S.partner && S.partner.battery_share) {
      const evs = await api.get('/events?couple_id=eq.' + S.coupleId + '&sender_id=eq.' + S.partner.id + '&kind=eq.battery&order=id.desc&limit=1&select=payload,created_at');
      if (evs.length) {
        const pct = parseInt(evs[0].payload, 10);
        if (!Number.isNaN(pct)) {
          S.partnerBattery = pct;
          const bEl = document.getElementById('home-battery');
          if (bEl) bEl.textContent = 'Your partner’s battery: ' + pct + '%';
          const cb = document.getElementById('cream-batt-sub');
          if (cb) cb.textContent = 'Battery ' + pct + '%';
        }
      }
    }
  } catch { /* home still renders without live extras */ }
}
export function prevIsoDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return todayIso(d);
}

// ---------------------------------------------------------------- Chat
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
registerScreen('chat', (param) => {
  if (!S.partner) {
    appEl().innerHTML = topbar('Chat') + '<div class="screen"><div class="card"><h3>Link with your partner first</h3><p class="muted small">Your private chat opens once the two of you are linked. Create an invitation code, or enter your partner’s code, in Settings.</p></div><button class="btn btn-primary" id="c-go-settings">Go to Settings</button></div>';
    document.getElementById('c-go-settings').onclick = () => showScreen('settings');
    return;
  }
  const state = {
    thread: (param && param.thread) || 'main',
    messages: [],        // decrypted view rows
    replyTo: null,       // server id being replied to
    surprise: false,
    recorder: null, recChunks: [], recording: false,
    lastTypingSent: 0,
    photoUrls: new Map(),
    voiceUrls: new Map(),   // bug #3: decrypted voice object URLs per server id
    revealedIds: new Set(), // bug #3: revealed surprises survive re-renders
    viewCache: new Map(),   // realtime upgrade: decrypted views by server id, keyed with rowDecryptSignature
    lastSig: null,          // bug #3: last rendered signature (diffing)
    forceBottom: false,     // scroll to bottom on next render (own send)
    oldestId: 0,            // bug #15: paging cursor for "Load earlier"
    hasEarlier: false,
    earlierExhausted: false,
    loadingEarlier: false,
  };
  const disappearHours = () => Number(prefs().disappearHours || 0);
  const renderShell = () => {
    // The shell rebuild replaces the message list element with the
    // "Loading…" placeholder, so the diffing signature must be reset —
    // otherwise renderMessages() can skip the rebuild (unchanged
    // messages) and strand the placeholder forever.
    state.lastSig = null;
    const secret = state.thread === 'secret';
    appEl().innerHTML =
      topbar(S.partner.display_name, {
        subtitle: secret ? 'Secret chat · locked with its own PIN' : 'End-to-end encrypted',
        right: '<button class="icon-btn" id="c-thread" aria-label="Switch chat">' + (secret ? '🔓' : '🔐') + '</button>',
      }) +
      '<div class="chat-wrap">' +
      '<div class="notice-bar"><span id="chat-typing"></span><span class="tiny">Messages are locked on this device before they are sent.</span></div>' +
      '<div class="chat-tools">' +
      '<button class="chip" id="c-schedule">🕰 Schedule</button>' +
      '<button class="chip" id="c-surprise">🎁 Surprise: ' + (state.surprise ? 'On' : 'Off') + '</button>' +
      '<button class="chip" id="c-voice-notes">🎙 Voice notes</button>' +
      '<button class="chip" id="c-disappear">⏳ Disappearing: ' + (disappearHours() === 0 ? 'Off' : disappearHours() + 'h') + '</button>' +
      '</div>' +
      '<div id="chat-pending"></div>' +
      '<div style="text-align:center;padding:2px"><button class="chip" id="c-earlier" hidden>Load earlier messages</button></div>' +
      '<div class="chat-list" id="chat-list"><p class="muted center">Loading your messages…</p></div>' +
      '<div class="composer"><div class="reply-bar" id="reply-bar" hidden></div>' +
      '<div class="row1"><button class="icon-btn" id="c-photo" aria-label="Send a photo">📷</button>' +
      '<button class="icon-btn" id="c-mic" aria-label="Record a voice message">🎙</button>' +
      '<textarea id="c-input" rows="1" placeholder="Message…"></textarea>' +
      '<button class="icon-btn send btn-primary" id="c-send" aria-label="Send" style="background:var(--primaryBg);color:var(--primaryText);border:0">➤</button></div>' +
      '<p class="tiny muted" id="c-status" style="margin:4px 2px 0"></p>' +
      '<input type="file" id="c-file" accept="image/*" hidden></div></div>';
    wire();
  };
  const status = (t) => { const s = document.getElementById('c-status'); if (s) s.textContent = t || ''; };
  const wire = () => {
    document.getElementById('c-thread').onclick = async () => {
      if (state.thread === 'secret') { state.thread = 'main'; renderShell(); load(); return; }
      const ok = await ensureSecretPin();
      if (ok) { state.thread = 'secret'; renderShell(); load(); }
    };
    const input = document.getElementById('c-input');
    input.addEventListener('input', () => {
      const now = Date.now();
      if (now - state.lastTypingSent > 4000) {
        state.lastTypingSent = now;
        api.post('/events', { couple_id: S.coupleId, sender_id: uid(), kind: 'typing', payload: '' }).catch(() => {});
      }
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendText(); } });
    document.getElementById('c-send').onclick = sendText;
    document.getElementById('c-surprise').onclick = (ev) => { state.surprise = !state.surprise; ev.target.textContent = '🎁 Surprise: ' + (state.surprise ? 'On' : 'Off'); };
    document.getElementById('c-voice-notes').onclick = () => showScreen('voice');
    document.getElementById('c-disappear').onclick = () => {
      const cur = disappearHours();
      const next = cur === 0 ? 1 : cur === 1 ? 24 : 0;
      setPref('disappearHours', next);
      renderShell(); load();
      toast(next === 0 ? 'Disappearing messages are off.' : 'New messages will disappear after ' + next + (next === 1 ? ' hour.' : ' hours.'));
    };
    document.getElementById('c-schedule').onclick = scheduleDlg;
    document.getElementById('c-earlier').onclick = loadEarlier;
    document.getElementById('c-photo').onclick = () => document.getElementById('c-file').click();
    document.getElementById('c-file').addEventListener('change', (ev) => { const f = ev.target.files[0]; if (f) sendPhoto(f); ev.target.value = ''; });
    document.getElementById('c-mic').onclick = toggleRecord;
    renderPending();
  };
  async function ensureSecretPin() {
    const stored = ls.get(secretPinKey(), null);
    const ask = (title, sub) => new Promise((resolve) => {
      const sh = sheet('<h3>' + esc(title) + '</h3><p class="muted">' + esc(sub) + '</p><input type="password" inputmode="numeric" maxlength="4" id="sp-pin" class="pin-input" style="letter-spacing:.3em"><button class="btn btn-primary" id="sp-go">Continue</button><button class="btn btn-ghost" id="sp-no">Cancel</button>');
      sh.querySelector('#sp-no').onclick = () => { closeSheet(); resolve(null); };
      sh.querySelector('#sp-go').onclick = () => { const v = sh.querySelector('#sp-pin').value.trim(); closeSheet(); resolve(v); };
    });
    if (!stored) {
      const pin = await ask('Set a secret-chat PIN', 'The secret chat has its own 4-digit PIN, kept only on this device.');
      if (!pin || !/^\d{4}$/.test(pin)) { if (pin) toast('Please use 4 digits.'); return false; }
      const salt = E.newSalt();
      ls.set(secretPinKey(), { salt: E.bytesToHex(salt), hash: await E.hashSecretHex(pin, salt) });
      return true;
    }
    const pin = await ask('Secret chat PIN', 'Enter the secret chat’s own PIN.');
    if (!pin) return false;
    const hash = await E.hashSecretHex(pin, E.hexToBytesLocal(stored.salt));
    if (hash !== stored.hash) { toast('That PIN is not right.'); return false; }
    return true;
  }
  function renderPending() {
    const box = document.getElementById('chat-pending');
    if (!box) return;
    const items = ls.get('scheduled:' + S.coupleId, []);
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="notice-bar" style="flex-wrap:wrap">🕰 Scheduled: ' + items.map((i, idx) =>
      '<span>' + (i.surprise ? '🎁 ' : '') + '“' + esc(i.preview || '…') + '” — ' + new Date(i.sendAtMs).toLocaleString('en-US') + ' <button data-cancel="' + idx + '">Cancel</button></span>').join('') + '</div>' +
      '<p class="tiny muted" style="padding:0 6px">Scheduled messages are sent while this page is open.</p>';
    box.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => { const arr = ls.get('scheduled:' + S.coupleId, []); arr.splice(Number(b.dataset.cancel), 1); ls.set('scheduled:' + S.coupleId, arr); renderPending(); }; });
  }
  async function scheduleDlg() {
    const text = document.getElementById('c-input').value.trim();
    if (!text) { toast('Type the message first, then tap Schedule.'); return; }
    const sh = sheet('<h3>Schedule this message</h3><p class="muted">It will be sent while this page is open — the same honest limit as the Android app.</p>' +
      '<label class="field">Send at</label><input type="datetime-local" id="sc-when">' +
      '<div class="switch-row"><span class="lbl">Surprise (hidden until tapped)</span><span class="switch"><input type="checkbox" id="sc-surprise"><span class="track"></span></span></div>' +
      '<button class="btn btn-primary" id="sc-save">Schedule</button><button class="btn btn-ghost" id="sc-no">Cancel</button>');
    sh.querySelector('#sc-no').onclick = closeSheet;
    sh.querySelector('#sc-save').onclick = async () => {
      const when = sh.querySelector('#sc-when').value;
      if (!when) { toast('Please pick a date and time.'); return; }
      const sendAtMs = new Date(when).getTime();
      if (sendAtMs <= Date.now()) { toast('Please pick a future time.'); return; }
      const sealed = await sealText(text);
      if (!sealed) { toast('Your partner’s message key isn’t available yet — ask your partner to open the app once, then try again.'); return; }
      const arr = ls.get('scheduled:' + S.coupleId, []);
      arr.push({ sendAtMs, surprise: sh.querySelector('#sc-surprise').checked, sealed, preview: text.substring(0, 40) });
      ls.set('scheduled:' + S.coupleId, arr);
      document.getElementById('c-input').value = '';
      closeSheet(); renderPending();
      toast('Scheduled. Keep this page open around that time.');
    };
  }
  async function sendText() {
    const input = document.getElementById('c-input');
    const text = input.value.trim();
    if (!text) return;
    if (!e2eeReady()) { status('Your partner’s message key isn’t available yet — ask your partner to open the app once, then try again.'); return; }
    status('Sending…');
    const wasSurprise = state.surprise;
    const replyTo = state.replyTo;
    try {
      const hours = disappearHours();
      const row = await sendChatTextNow(wasSurprise ? 'USSURPRISE1:' + text : text, state.thread, replyTo, hours ? Date.now() + hours * 3600000 : 0);
      if (row && row.id) {
        S.lastMsgIdSeen = Math.max(S.lastMsgIdSeen, row.id);
        // Live obs (a): show the just-sent message immediately from the
        // POST response instead of waiting for the next 4 s poll.
        if (!state.messages.some((m) => m.serverId === row.id)) {
          state.messages = state.messages.concat([{
            serverId: row.id, mine: true, kind: 'text', displayText: text, photoPath: '',
            surprise: wasSurprise, edited: false, readAt: null,
            createdAt: row.created_at || new Date().toISOString(),
            replyToId: replyTo, reactions: [], revealed: false,
            wire: row.ciphertext, nonce: row.nonce,
          }]);
          state.forceBottom = true;
          renderMessages();
        }
      }
      input.value = ''; state.replyTo = null; state.surprise = false;
      renderReplyBar(); status('');
      const chip = document.getElementById('c-surprise'); if (chip) chip.textContent = '🎁 Surprise: Off';
      load();
    } catch (e) { status('Could not send: ' + e.message); }
  }
  function renderReplyBar() {
    const bar = document.getElementById('reply-bar');
    if (!bar) return;
    if (!state.replyTo) { bar.hidden = true; bar.innerHTML = ''; return; }
    const target = state.messages.find((m) => m.serverId === state.replyTo);
    bar.hidden = false;
    bar.innerHTML = '<span>Replying to: “' + esc(target ? target.displayText.substring(0, 60) : 'message') + '”</span><button id="rb-x">Cancel</button>';
    document.getElementById('rb-x').onclick = () => { state.replyTo = null; renderReplyBar(); };
  }
  async function toggleRecord() {
    const btn = document.getElementById('c-mic');
    if (state.recording) { state.recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
      state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      state.recChunks = [];
      state.recorder.ondataavailable = (ev) => { if (ev.data.size) state.recChunks.push(ev.data); };
      state.recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        state.recording = false; btn.textContent = '🎙';
        const blob = new Blob(state.recChunks, { type: mime || 'audio/webm' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!bytes.length) { status('That recording was empty.'); return; }
        if (bytes.length > 2 * 1024 * 1024) { status('That voice message is too long.'); return; }
        status('Sending voice message…');
        try {
          const sealed = await E.sealChatBytes(S.myPriv, S.partnerPub, bytes);
          const rows = await api.post('/messages', { couple_id: S.coupleId, sender_id: uid(), ciphertext: sealed.wire, nonce: sealed.nonce, type: 'voice', thread: state.thread, reply_to_id: null, expires_at: null }, 'return=representation');
          const row = rows && rows[0];
          if (row && row.id) {
            // Live obs (a) + bug #3: cache the local bytes as the
            // playable URL (typed by sniffing, bug #5) and render now.
            state.voiceUrls.set(row.id, URL.createObjectURL(new Blob([bytes], { type: sniffAudioType(bytes) })));
            if (!state.messages.some((m) => m.serverId === row.id)) {
              state.messages = state.messages.concat([{
                serverId: row.id, mine: true, kind: 'voice', displayText: '', photoPath: '',
                surprise: false, edited: false, readAt: null,
                createdAt: row.created_at || new Date().toISOString(),
                replyToId: null, reactions: [], revealed: false,
                wire: row.ciphertext, nonce: row.nonce,
              }]);
              state.forceBottom = true;
              renderMessages();
            }
          }
          status(''); load();
        } catch (e) { status('Could not send: ' + e.message); }
      };
      state.recorder.start();
      state.recording = true; btn.textContent = '⏹';
      status('Recording… tap ⏹ to send (up to about 2 minutes).');
    } catch { status('Microphone access was not granted.'); }
  }
  async function sendPhoto(file) {
    if (!e2eeReady()) { status('Your partner’s message key isn’t available yet — ask your partner to open the app once, then try again.'); return; }
    status('Preparing photo…');
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const fileId = E.uuid();
      const sealed = await sealFileBytes(fileId, jpeg);
      if (!sealed) { status('Your partner’s message key isn’t available yet — ask your partner to open the app once, then try again.'); return; }
      const path = S.coupleId + '/media/' + fileId + '.bin';
      status('Uploading encrypted photo…');
      await api.storageUpload(path, sealed);
      const replyTo = state.replyTo;
      const row = await sendChatTextNow('USPHOTO1:' + path, state.thread, replyTo, 0);
      if (row && row.id) {
        // Live obs (a): render the photo now from the local JPEG.
        state.photoUrls.set(path, URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' })));
        if (!state.messages.some((m) => m.serverId === row.id)) {
          state.messages = state.messages.concat([{
            serverId: row.id, mine: true, kind: 'photo', displayText: '', photoPath: path,
            surprise: false, edited: false, readAt: null,
            createdAt: row.created_at || new Date().toISOString(),
            replyToId: replyTo, reactions: [], revealed: false,
            wire: row.ciphertext, nonce: row.nonce,
          }]);
          state.forceBottom = true;
          renderMessages();
        }
      }
      state.replyTo = null; renderReplyBar(); status(''); load();
    } catch (e) { status('Photo could not be sent: ' + e.message); }
  }
  const MSG_SELECT = 'id,sender_id,ciphertext,nonce,type,reply_to_id,edited,read_at,expires_at,created_at';
  /** Decrypts one page of server rows (fetched id.desc) into ascending view rows. */
  async function buildView(rowsDesc) {
    const now = Date.now();
    const view = [];
    const reactions = {};
    if (rowsDesc.length) {
      const ids = rowsDesc.map((r) => r.id).join(',');
      const rs = await api.get('/message_reactions?message_id=in.(' + ids + ')&select=message_id,user_id,emoji').catch(() => []);
      rs.forEach((r) => { (reactions[r.message_id] = reactions[r.message_id] || []).push(r); });
    }
    const hidden = new Set(ls.get('hiddenMsgs:' + S.coupleId, []));
    for (const r of rowsDesc.slice().reverse()) {
      if (hidden.has(r.id)) continue;
      const expMs = r.expires_at ? new Date(r.expires_at).getTime() : 0;
      if (expMs && expMs <= now) {
        if (r.sender_id === uid()) api.del('/messages?id=eq.' + r.id).catch(() => {});
        continue;
      }
      const mine = r.sender_id === uid();
      let displayText = '🔒 Could not open this message on this device.';
      let kind = r.type; let surprise = false; let photoPath = '';
      if (r.type === 'voice') {
        // Voice bytes are decrypted lazily by the renderer's fill step
        // (and cached) — decrypting every note on every poll was part
        // of bug #3.
        displayText = '';
      } else {
        // Realtime upgrade: reuse the decrypted view while the row's
        // sealed bytes are unchanged — a poll (or a realtime reload)
        // then only decrypts new or edited rows instead of the whole
        // window every tick. Only successful opens are cached: a
        // locked placeholder must be retried on the next load so a
        // healed partner key (bug #2) can still open the message.
        const sig = rowDecryptSignature(r);
        const cached = state.viewCache.get(r.id);
        if (cached && cached.sig === sig) {
          kind = cached.kind; displayText = cached.displayText;
          photoPath = cached.photoPath; surprise = cached.surprise;
        } else {
          try {
            const plain = await openChatWireRetry(r.ciphertext, r.nonce, r.type);
            if (typeof plain === 'string' && plain.startsWith('USPHOTO1:')) { kind = 'photo'; photoPath = plain.substring('USPHOTO1:'.length); displayText = ''; }
            else if (typeof plain === 'string' && plain.startsWith('USSURPRISE1:')) { surprise = true; displayText = plain.substring('USSURPRISE1:'.length); }
            else displayText = String(plain);
            state.viewCache.set(r.id, { sig, kind, displayText, photoPath, surprise });
          } catch { /* keep the locked placeholder */ }
        }
      }
      view.push({
        serverId: r.id, mine, kind, displayText, photoPath, surprise,
        edited: r.edited, readAt: r.read_at, createdAt: r.created_at,
        replyToId: r.reply_to_id, reactions: reactions[r.id] || [],
        revealed: state.revealedIds.has(r.id),
        wire: r.ciphertext, nonce: r.nonce,
      });
      if (!mine && !r.read_at && prefs().readReceiptsOff !== true) {
        api.patch('/messages?id=eq.' + r.id, { read_at: new Date().toISOString() }).catch(() => {});
      }
    }
    // Keep the decrypt cache bounded: drop entries for messages that
    // are neither in this page nor in the loaded (paged) history.
    if (state.viewCache.size > 400) {
      const keep = new Set(rowsDesc.map((r) => r.id));
      for (const m of state.messages) keep.add(m.serverId);
      for (const k of [...state.viewCache.keys()]) if (!keep.has(k)) state.viewCache.delete(k);
    }
    return view;
  }
  function mergeView(view) {
    const byId = new Map();
    for (const m of state.messages) byId.set(m.serverId, m);
    for (const m of view) byId.set(m.serverId, m);
    state.messages = [...byId.values()].sort((a, b) => a.serverId - b.serverId);
  }
  function updateEarlierBtn() {
    const b = document.getElementById('c-earlier');
    if (b) b.hidden = !state.hasEarlier;
  }
  async function load() {
    // Thread isolation (sweep 2026-11-18): mergeView() only ever adds
    // rows, so without a reset the main and secret threads mix in one
    // list — regular messages showed inside the secret view and vice
    // versa. When the thread changes, start from an empty view.
    if (state.viewThread !== state.thread) {
      state.viewThread = state.thread;
      state.messages = [];
      state.oldestId = null;
      state.hasEarlier = false;
      state.earlierExhausted = false;
      state.lastSig = '';
    }
    // Bug #2: the partner's public key is re-fetched alongside the
    // message poll, so a key rotation on their side heals this session
    // within one poll cycle instead of breaking it until re-login.
    await refreshPartnerKey();
    // For the polling fallback's "ting": remember the newest partner
    // message already on screen before this load merges new rows.
    const prevPartnerTop = state.messages.reduce((a, m) => (m.mine ? a : Math.max(a, m.serverId)), 0);
    try {
      const rows = await api.get('/messages?couple_id=eq.' + S.coupleId + '&thread=eq.' + state.thread + '&order=id.desc&limit=100&select=' + MSG_SELECT);
      if (rows.length) {
        const oldest = rows[rows.length - 1].id;
        if (!state.oldestId || oldest < state.oldestId) state.oldestId = oldest;
        if (!state.earlierExhausted && rows.length === 100) state.hasEarlier = true;
      }
      mergeView(await buildView(rows));
      renderMessages();
      // While realtime is connected it plays the ting itself; on the
      // polling fallback, a genuinely new partner message tings here.
      if (!rtConnected && prevPartnerTop > 0) {
        const newPartnerTop = state.messages.reduce((a, m) => (m.mine ? a : Math.max(a, m.serverId)), 0);
        if (newPartnerTop > prevPartnerTop) playTing();
      }
      updateEarlierBtn();
      // This load marked the visible partner messages read — refresh
      // the unread badge from the server count so it clears.
      refreshUnreadBadge();
    } catch (e) { status('Loading failed: ' + e.message); }
  }
  /** Bug #15: page in the next 100 older messages above the loaded window. */
  async function loadEarlier() {
    if (state.loadingEarlier || !state.oldestId) return;
    state.loadingEarlier = true;
    try {
      const rows = await api.get('/messages?couple_id=eq.' + S.coupleId + '&thread=eq.' + state.thread + '&id=lt.' + state.oldestId + '&order=id.desc&limit=100&select=' + MSG_SELECT);
      if (rows.length) {
        state.oldestId = rows[rows.length - 1].id;
        mergeView(await buildView(rows));
        renderMessages();
      }
      if (rows.length < 100) { state.hasEarlier = false; state.earlierExhausted = true; }
      updateEarlierBtn();
    } catch (e) { status('Loading earlier messages failed: ' + e.message); }
    state.loadingEarlier = false;
  }
  function renderMessages() {
    const list = document.getElementById('chat-list');
    if (!list) return;
    // Bug #3: skip the DOM rebuild entirely when nothing visible
    // changed — rebuilding on every poll destroyed playing voice
    // notes, recreated photos and yanked the scroll position.
    const sig = chatSignature(state.messages);
    if (sig === state.lastSig) {
      if (state.forceBottom) { list.scrollTop = list.scrollHeight; state.forceBottom = false; }
      return;
    }
    state.lastSig = sig;
    const prevTop = list.scrollTop;
    const prevHeight = list.scrollHeight;
    const wasAtBottom = prevHeight - prevTop - list.clientHeight < 80;
    if (!state.messages.length) { list.innerHTML = '<p class="muted center" style="margin-top:24px">No messages here yet. Say hello. 💌</p>'; return; }
    list.innerHTML = state.messages.map((m, i) => {
      const time = new Date(m.createdAt).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
      let inner = '';
      if (m.replyToId) {
        const q = state.messages.find((x) => x.serverId === m.replyToId);
        inner += '<span class="quote">' + esc(q ? (q.kind === 'photo' ? '📷 Photo' : q.displayText.substring(0, 60)) : 'Original message') + '</span>';
      }
      if (m.kind === 'photo') inner += '<span data-photo="' + i + '">Loading photo…</span>';
      else if (m.kind === 'voice') inner += '<span data-voice="' + i + '">Loading voice message…</span>';
      else if (m.surprise && !m.revealed && !m.mine) inner += '🎁 A surprise for you — tap to reveal';
      else inner += esc(m.displayText);
      const reacts = m.reactions.length ? '<div class="reactions">' + m.reactions.map((r) => '<span>' + esc(r.emoji) + '</span>').join('') + '</div>' : '';
      const meta = time + (m.edited ? ' · Edited' : '') + (m.mine && m.readAt ? ' · Read' : '');
      // Photo/voice bubbles use their tap for view/play, so they also
      // get an explicit ⋯ button for the message menu — a long press
      // alone is undiscoverable and unreliable with some input types.
      const menuBtn = (m.kind === 'photo' || m.kind === 'voice') ? '<button class="bubble-menu" data-menu="' + i + '" aria-label="Message options">⋯</button>' : '';
      return '<div class="bubble-row ' + (m.mine ? 'me' : 'her') + '"><button class="bubble" data-msg="' + i + '">' + inner + '</button>' + menuBtn + reacts + '<div class="bubble-meta">' + esc(meta) + '</div></div>';
    }).join('');
    list.querySelectorAll('[data-msg]').forEach((b) => { b.onclick = () => msgActions(Number(b.dataset.msg)); });
    list.querySelectorAll('[data-menu]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); msgActions(Number(b.dataset.menu)); }; });
    // Photo/voice bubbles: a tap does their own thing (view / play),
    // so the message menu (react/reply) opens on a long press instead.
    list.querySelectorAll('[data-msg]').forEach((b) => {
      const m = state.messages[Number(b.dataset.msg)];
      if (!m || (m.kind !== 'photo' && m.kind !== 'voice')) return;
      let timer = null;
      b.addEventListener('pointerdown', () => { timer = setTimeout(() => { state.lastLongPress = Date.now(); msgActions(Number(b.dataset.msg)); }, 600); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => b.addEventListener(ev, () => { if (timer) clearTimeout(timer); }));
      b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); });
    });
    // Fill photos + voice lazily.
    state.messages.forEach(async (m, i) => {
      if (m.kind === 'photo') {
        const slot = list.querySelector('[data-photo="' + i + '"]');
        if (!slot) return;
        try {
          let url = state.photoUrls.get(m.photoPath);
          if (!url) {
            const blob = await api.storageDownload(m.photoPath);
            const plain = await openFileBytes(E.fileIdFromPath(m.photoPath), blob);
            url = URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
            state.photoUrls.set(m.photoPath, url);
          }
          slot.innerHTML = '<img alt="Shared photo" src="' + url + '">';
          // Sweep fix 2026-11-18: the viewer opens from the image
          // itself (stopPropagation) — it must NOT override the
          // bubble's own click handler, which is how the message
          // menu (react/reply) became unreachable for photos.
          const img = slot.querySelector('img');
          img.onclick = (ev) => { ev.stopPropagation(); if (Date.now() - (state.lastLongPress || 0) < 800) return; const sh = sheet('<img class="full" alt="Shared photo" src="' + url + '"><button class="btn btn-ghost" id="pv-x">Close</button>'); sh.querySelector('#pv-x').onclick = closeSheet; };
        } catch { slot.textContent = '📷 This photo could not be opened on this device.'; }
      } else if (m.kind === 'voice') {
        const slot = list.querySelector('[data-voice="' + i + '"]');
        if (!slot) return;
        try {
          // Bug #3: decrypted bytes are cached per message — no server
          // re-fetch and no re-decrypt on later renders. Bug #5: the
          // Blob type is sniffed from the actual container bytes,
          // never forced to audio/webm.
          let url = state.voiceUrls.get(m.serverId);
          if (!url) {
            const bytes = await openChatWireRetry(m.wire, m.nonce, 'voice');
            url = URL.createObjectURL(new Blob([bytes], { type: sniffAudioType(bytes) }));
            state.voiceUrls.set(m.serverId, url);
          }
          slot.innerHTML = '';
          const a = document.createElement('audio'); a.controls = true; a.src = url; a.style.minWidth = '210px';
          slot.appendChild(a);
          // Clicks on the player controls must not bubble up to the
          // bubble's message-menu handler.
          slot.onclick = (ev) => { ev.stopPropagation(); };
        } catch { slot.textContent = '🎙 This voice message could not be opened on this device.'; }
      }
    });
    // Bug #3: keep the reading position — jump to the bottom only when
    // the user was already there (or just sent something); when older
    // messages were prepended, shift by the height they added.
    if (state.forceBottom || wasAtBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
    state.forceBottom = false;
  }
  function msgActions(i) {
    const m = state.messages[i];
    if (!m) return;
    if (m.surprise && !m.revealed && !m.mine) { m.revealed = true; state.revealedIds.add(m.serverId); renderMessages(); return; }
    const canEdit = m.mine && m.kind === 'text' && (Date.now() - new Date(m.createdAt).getTime() <= 15 * 60000);
    const sh = sheet('<h3>Message</h3>' +
      '<div class="emoji-row">' + REACTIONS.map((e) => '<button data-react="' + e + '">' + e + '</button>').join('') + '</div>' +
      '<button class="sheet-btn" id="ma-reply">↩ Reply</button>' +
      (canEdit ? '<button class="sheet-btn" id="ma-edit">✏ Edit (within 15 minutes)</button>' : '') +
      '<button class="sheet-btn danger" id="ma-hide">Delete for me (this browser only)</button>' +
      '<button class="btn btn-ghost" id="ma-x">Cancel</button>');
    sh.querySelector('#ma-x').onclick = closeSheet;
    sh.querySelectorAll('[data-react]').forEach((b) => { b.onclick = async () => {
      const emoji = b.dataset.react;
      const existing = m.reactions.find((r) => r.user_id === uid());
      try {
        if (existing && existing.emoji === emoji) await api.del('/message_reactions?message_id=eq.' + m.serverId + '&user_id=eq.' + uid());
        else await api.post('/message_reactions', { message_id: m.serverId, user_id: uid(), emoji }, 'resolution=merge-duplicates');
      } catch (e) { toast(e.message); }
      closeSheet(); load();
    }; });
    sh.querySelector('#ma-reply').onclick = () => { state.replyTo = m.serverId; closeSheet(); renderReplyBar(); document.getElementById('c-input').focus(); };
    const editBtn = sh.querySelector('#ma-edit');
    if (editBtn) editBtn.onclick = async () => {
      closeSheet();
      const sh2 = sheet('<h3>Edit message</h3><textarea id="ed-text">' + esc(m.displayText) + '</textarea><button class="btn btn-primary" id="ed-save">Save edit</button><button class="btn btn-ghost" id="ed-x">Cancel</button>');
      sh2.querySelector('#ed-x').onclick = closeSheet;
      sh2.querySelector('#ed-save').onclick = async () => {
        const text = sh2.querySelector('#ed-text').value.trim();
        if (!text) return;
        try {
          const sealed = await E.sealChatText(S.myPriv, S.partnerPub, m.surprise ? 'USSURPRISE1:' + text : text);
          await api.patch('/messages?id=eq.' + m.serverId, { ciphertext: sealed.wire, nonce: sealed.nonce, edited: true });
          closeSheet(); load();
        } catch (e) { toast(e.message); }
      };
    };
    sh.querySelector('#ma-hide').onclick = () => {
      const hidden = new Set(ls.get('hiddenMsgs:' + S.coupleId, []));
      hidden.add(m.serverId);
      ls.set('hiddenMsgs:' + S.coupleId, [...hidden]);
      closeSheet(); load();
    };
  }
  renderShell();
  load();
  chatScreenReload = () => { load(); };
  // Realtime upgrade: while the socket is live, new messages arrive
  // through it instantly, so this poll relaxes to a ~16 s safety net.
  // When the socket is down, the original 4 s poll runs unchanged.
  let chatPollTicks = 0;
  every(4000, async () => {
    chatPollTicks++;
    if (rtConnected && chatPollTicks % 4 !== 0) return;
    await load();
  });
  // Typing indicator fade — registered with every() (bug #14) so
  // showScreen() clears it instead of leaking one interval per visit.
  every(1000, async () => {
    const t = document.getElementById('chat-typing');
    if (t && S.partnerTypingUntil && Date.now() > S.partnerTypingUntil) t.textContent = '';
  });
  // Battery sharing is sent by the ONE app-level loop started in
  // startGlobalLoops() (build 2026-11-18.12) — it runs on every screen,
  // not only while chat is open.
});

// ---------------------------------------------------------------- Voice notes list
registerScreen('voice', () => {
  appEl().innerHTML = topbar('Voice Notes', { back: true, subtitle: 'Every voice message you two have shared' }) +
    '<div class="screen"><p class="muted" id="vn-status">Loading your voice notes…</p><div id="vn-list"></div></div>';
  wireBack({ name: 'chat' });
  (async () => {
    try {
      const rows = await api.get('/messages?couple_id=eq.' + S.coupleId + "&type=eq.voice&order=id.desc&limit=100&select=id,sender_id,ciphertext,nonce,created_at");
      const list = document.getElementById('vn-list');
      const status = document.getElementById('vn-status');
      if (!rows.length) { status.textContent = 'No voice notes yet. Record one from the chat screen.'; return; }
      status.textContent = '';
      list.innerHTML = rows.map((r, i) =>
        '<div class="card"><div class="flex"><span style="font-size:22px">🎙</span><div class="grow"><div>' + (r.sender_id === uid() ? 'You' : esc(S.partner ? S.partner.display_name : 'Partner')) + '</div>' +
        '<div class="tiny muted">' + new Date(r.created_at).toLocaleString('en-US') + '</div></div><button class="btn btn-soft" style="width:auto" data-vn="' + i + '">Play</button></div><div data-vn-slot="' + i + '"></div></div>').join('');
      list.querySelectorAll('[data-vn]').forEach((b) => { b.onclick = async () => {
        const r = rows[Number(b.dataset.vn)];
        const slot = list.querySelector('[data-vn-slot="' + b.dataset.vn + '"]');
        b.disabled = true; b.textContent = 'Opening…';
        try {
          const bytes = await openChatWireRetry(r.ciphertext, r.nonce, 'voice');
          const url = URL.createObjectURL(new Blob([bytes], { type: sniffAudioType(bytes) }));
          slot.innerHTML = ''; const a = document.createElement('audio'); a.controls = true; a.src = url; a.autoplay = true; slot.appendChild(a);
          b.textContent = 'Play';
        } catch { slot.innerHTML = '<p class="error-text small">This voice note could not be opened on this device.</p>'; b.textContent = 'Play'; }
        b.disabled = false;
      }; });
    } catch (e) {
      const status = document.getElementById('vn-status');
      if (status) status.textContent = 'Loading failed: ' + e.message;
    }
  })();
});

// ---------------------------------------------------------------- Settings
registerScreen('settings', () => {
  const p = prefs();
  let inviteCode = '';
  const render = () => {
    const pin = ls.get(pinKey(), null);
    appEl().innerHTML = topbar('Settings', { subtitle: S.me ? S.me.display_name + ' · ' + S.me.role : '' }) +
      '<div class="screen">' +
      // Profile photo
      '<h2 class="section">Profile</h2><div class="card">' +
      '<div class="flex"><div class="partner-ava" id="s-ava-view" title="View photo">' + avatarInner(S.me) + '</div>' +
      '<div class="grow"><div style="font-weight:600">' + esc(S.me ? S.me.display_name : '') + '</div><div class="muted small">' + esc(S.me ? S.me.role : '') + '</div></div></div>' +
      '<div style="height:12px"></div><div class="btn-row"><button class="btn btn-soft" id="s-ava-change">' + (S.me && S.me.avatar_data ? 'Change photo' : 'Add a photo') + '</button>' +
      (S.me && S.me.avatar_data ? '<button class="btn btn-ghost" id="s-ava-remove">Remove photo</button>' : '') + '</div>' +
      '<input type="file" id="s-ava-file" accept="image/*" hidden>' +
      '<p class="tiny muted" style="margin:8px 0 0">Your photo is saved with your profile, so your partner sees it in the app too. It is cropped to a small square and shrunk on this device first — the original file never leaves your phone or computer.</p></div>' +
      // Appearance
      '<h2 class="section">Appearance</h2><div class="card">' +
      '<div class="btn-row"><button class="btn ' + (themeMode() === 'warm' ? 'btn-primary' : 'btn-soft') + '" id="s-warm">☀️ Warm Editorial</button>' +
      '<button class="btn ' + (themeMode() === 'dark' ? 'btn-primary' : 'btn-soft') + '" id="s-dark">🌙 Dark Luxe</button>' +
      '<button class="btn ' + (themeMode() === 'cream' ? 'btn-primary' : 'btn-soft') + '" id="s-cream">🌅 Morning Cream</button></div>' +
      '<p class="tiny muted" style="margin:8px 0 0">Three designs — switch any time; your choice is remembered on this device.</p></div>' +
      // Linking
      '<h2 class="section">Linking</h2><div class="card" id="s-link"></div>' +
      // Relationship
      '<h2 class="section">Your relationship</h2><div class="card">' +
      '<label class="field" for="s-start">The day it all started</label><input type="date" id="s-start" value="' + esc(startDate()) + '">' +
      '<div style="height:10px"></div><button class="btn btn-soft" id="s-start-save">Save start date</button></div>' +
      // Chat privacy
      '<h2 class="section">Chat</h2><div class="card">' +
      '<div class="switch-row"><span class="lbl">Send read receipts</span><span class="switch"><input type="checkbox" id="s-receipts" ' + (p.readReceiptsOff === true ? '' : 'checked') + '><span class="track"></span></span></div>' +
      '<p class="tiny muted">When on, your partner sees “Read” under messages you have opened. Turning it off stops this browser from sending receipts.</p></div>' +
      // Sharing (opt-in)
      '<h2 class="section">Sharing — only if you both want it</h2><div class="card">' +
      '<div class="switch-row"><span class="lbl">Share my battery level</span><span class="switch"><input type="checkbox" id="s-battery" ' + (S.me && S.me.battery_share ? 'checked' : '') + '><span class="track"></span></span></div>' +
      '<p class="tiny muted">While on, this browser sends your battery percentage about once a minute while the app is open, and whenever the level changes. Nothing is sent while it is off.</p>' +
      '<h3 style="margin-top:14px">Arrival</h3>' +
      '<p class="tiny muted">Save one place below. Your partner is never shown your coordinates — only the moment you tap “I reached”, which shares the place’s name. (On the web there is no background location checking; the tap is the honest version.)</p>' +
      '<label class="field" for="s-arr-label">Place name</label><input type="text" id="s-arr-label" placeholder="Home">' +
      '<div class="btn-row"><span class="grow"><label class="field" for="s-arr-lat">Latitude</label><input type="text" id="s-arr-lat" inputmode="decimal"></span><span class="grow"><label class="field" for="s-arr-lng">Longitude</label><input type="text" id="s-arr-lng" inputmode="decimal"></span></div>' +
      '<label class="field" for="s-arr-radius">Radius (meters)</label><input type="number" id="s-arr-radius" value="150">' +
      '<div style="height:10px"></div><div class="btn-row"><button class="btn btn-soft" id="s-arr-geo">Use my location once</button><button class="btn btn-soft" id="s-arr-save">Save place</button></div>' +
      '<div style="height:10px"></div><button class="btn btn-primary" id="s-arr-reached">📍 I reached</button>' +
      '<p class="tiny muted" id="s-arr-status" style="margin:8px 0 0"></p></div>' +
      // Notifications & feel
      '<h2 class="section">Notifications &amp; feel</h2><div class="card">' +
      '<div class="switch-row"><span class="lbl">Stay connected while this page is open</span><span class="switch"><input type="checkbox" id="s-stay" ' + (p.stayConnected === false ? '' : 'checked') + '><span class="track"></span></span></div>' +
      '<p class="tiny muted">While this page is open, it checks every few seconds for new messages and taps, and can show browser notifications. This is not push: when the page is closed, nothing arrives until you open it again.' + (rcConnectionService() ? '' : ' (Currently turned off by the couple’s server settings.)') + '</p>' +
      '<div class="btn-row"><button class="btn btn-soft" id="s-notif">Allow browser notifications</button></div>' +
      '<p class="tiny muted" id="s-notif-status" style="margin:6px 0 0"></p>' +
      '<div class="switch-row"><span class="lbl">Sounds — a soft “ting” for new messages and tab taps</span><span class="switch"><input type="checkbox" id="s-sound" ' + (p.msgSound === false ? '' : 'checked') + '><span class="track"></span></span></div>' +
      '<label class="field">Vibration pattern for taps</label><div class="chips" id="s-vib">' +
      ['Gentle', 'Heartbeat', 'Excited'].map((v) => '<button class="chip ' + (vibPatternName() === v ? 'selected' : '') + '" data-vib="' + v + '">' + v + '</button>').join('') + '</div></div>' +
      // Security
      '<h2 class="section">Security</h2><div class="card" id="s-security"></div>' +
      // Platform notes
      '<h2 class="section">Good to know</h2><div class="card"><p class="small muted" style="margin:0">This web version has no home-screen widget — the Home tab shows the same information. Notifications and scheduled messages work while this page is open. Add this page to your home screen to open it like an app.</p><p class="tiny muted" style="margin:8px 0 0">Build ' + BUILD_ID + '</p></div>' +
      // Account
      '<h2 class="section">Account</h2><div class="card">' +
      '<button class="btn btn-ghost" id="s-logout">Sign out</button><div style="height:10px"></div>' +
      '<button class="btn btn-danger" id="s-wipe">Delete this browser’s local data</button>' +
      '<p class="tiny muted" style="margin:8px 0 0">Local data includes your wrapped message key, PIN, start date and preferences stored in this browser. Your account and shared data stay on the server.</p></div>' +
      '<div class="grow"></div></div>';
    wireSettings(inviteCode, (code) => { inviteCode = code; });
    renderSecurity();
  };
  const renderSecurity = () => {
    const box = document.getElementById('s-security');
    if (!box) return;
    let safety = '<p class="small muted">Link with your partner to see your safety number.</p>';
    if (S.partnerPub && S.myPub) {
      try { safety = '<label class="field">Your safety number — compare it with your partner, out loud or in person</label><p style="font-family:monospace;font-size:13px;word-break:break-all;margin:4px 0">' + esc(E.safetyNumber(S.myPub, S.partnerPub)) + '</p><p class="tiny muted">If this number ever changes without one of you signing in on a new device, someone may be impersonating a partner. Stop and check together.</p>'; }
      catch { safety = '<p class="small muted">Safety number unavailable right now.</p>'; }
    }
    const pin = ls.get(pinKey(), null);
    box.innerHTML = (S.partnerKeyChanged ? '<p class="small" style="color:var(--danger,#b3261e)">Your partner’s message key changed recently — they may have signed in on a new device. Compare the safety number below with your partner before trusting new messages.</p>' : '') + safety +
      '<label class="field">' + (pin && pin.on ? 'Change app PIN' : 'Set an app PIN (optional)') + '</label>' +
      '<div class="btn-row"><input type="password" inputmode="numeric" maxlength="4" id="s-pin" placeholder="4 digits" style="flex:1"><button class="btn btn-soft" style="width:auto" id="s-pin-save">' + (pin && pin.on ? 'Change PIN' : 'Set PIN') + '</button></div>' +
      (pin && pin.on ? '<div style="height:8px"></div><button class="btn btn-ghost" id="s-pin-off">Remove PIN</button>' : '') +
      '<p class="tiny muted" style="margin:8px 0 0">The PIN is stored only as a one-way hash in this browser. Your message private key itself is encrypted under your account password and is never sent anywhere.</p>';
    const save = document.getElementById('s-pin-save');
    if (save) save.onclick = async () => {
      const v = document.getElementById('s-pin').value.trim();
      if (!/^\d{4}$/.test(v)) { toast('Please enter 4 digits.'); return; }
      await setPin(v); toast('PIN saved.'); renderSecurity();
    };
    const off = document.getElementById('s-pin-off');
    if (off) off.onclick = () => { ls.del(pinKey()); toast('PIN removed.'); renderSecurity(); };
  };
  const wireSettings = (code, setCode) => {
    document.getElementById('s-warm').onclick = () => { setTheme('warm'); render(); };
    document.getElementById('s-dark').onclick = () => { setTheme('dark'); render(); };
    document.getElementById('s-cream').onclick = () => { setTheme('cream'); render(); };
    // Profile photo: pick → shrink on-device → save to profiles.avatar_data.
    const avaFile = document.getElementById('s-ava-file');
    const avaChange = document.getElementById('s-ava-change');
    avaChange.onclick = () => avaFile.click();
    const avaView = document.getElementById('s-ava-view');
    if (avaView) avaView.onclick = () => openAvatarViewer(S.me, { change: true });
    avaFile.onchange = async () => {
      const f = avaFile.files && avaFile.files[0];
      avaFile.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type || '')) { toast('That file is not a photo. Please pick an image.'); return; }
      avaChange.disabled = true; avaChange.textContent = 'Saving…';
      try {
        const dataUrl = await fileToAvatarDataUrl(f);
        await api.patch('/profiles?id=eq.' + uid(), { avatar_data: dataUrl });
        if (S.me) S.me.avatar_data = dataUrl;
        toast('Your profile photo is saved.');
        render();
      } catch (e) {
        toast(e.message === 'too-big' ? 'That photo is too detailed to keep as a small profile picture. Please try a simpler photo.'
          : (e.message === 'not-image' || e.message === 'bad-image') ? 'That file could not be read as a photo.'
          : 'Could not save your photo: ' + e.message);
        avaChange.disabled = false;
        avaChange.textContent = S.me && S.me.avatar_data ? 'Change photo' : 'Add a photo';
      }
    };
    const avaRemove = document.getElementById('s-ava-remove');
    if (avaRemove) avaRemove.onclick = async () => {
      avaRemove.disabled = true;
      try {
        await api.patch('/profiles?id=eq.' + uid(), { avatar_data: null });
        if (S.me) S.me.avatar_data = null;
        toast('Your profile photo has been removed.');
        render();
      } catch (e) { toast('Could not remove your photo: ' + e.message); avaRemove.disabled = false; }
    };
    document.getElementById('s-start-save').onclick = () => {
      const v = document.getElementById('s-start').value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { ls.set(prefKey('startDate'), v); toast('Start date saved.'); }
      else toast('Please pick a valid date.');
    };
    document.getElementById('s-receipts').onchange = (ev) => setPref('readReceiptsOff', !ev.target.checked);
    document.getElementById('s-stay').onchange = (ev) => setPref('stayConnected', ev.target.checked);
    const snd = document.getElementById('s-sound');
    if (snd) snd.onchange = (ev) => { setPref('msgSound', ev.target.checked); if (ev.target.checked) playTing(); };
    document.getElementById('s-battery').onchange = async (ev) => {
      try {
        await api.patch('/profiles?id=eq.' + uid(), { battery_share: ev.target.checked });
        if (S.me) S.me.battery_share = ev.target.checked;
        toast(ev.target.checked ? 'Battery sharing is on.' : 'Battery sharing is off.');
      } catch (e) { toast(e.message); ev.target.checked = !ev.target.checked; }
    };
    const notifStatus = () => {
      const el = document.getElementById('s-notif-status');
      if (el) el.textContent = ('Notification' in window) ? 'Browser notifications: ' + Notification.permission + '.' : 'This browser does not support notifications.';
    };
    notifStatus();
    document.getElementById('s-notif').onclick = async () => {
      if ('Notification' in window) { await Notification.requestPermission(); notifStatus(); }
    };
    document.querySelectorAll('#s-vib [data-vib]').forEach((b) => { b.onclick = () => { setPref('vibPattern', b.dataset.vib); feelTap(); render(); }; });
    // Arrival
    const arrStatus = (t) => { const el = document.getElementById('s-arr-status'); if (el) el.textContent = t; };
    (async () => {
      try {
        const rows = await api.get('/arrival_places?user_id=eq.' + uid() + '&select=label,lat,lng,radius_m&order=id.desc&limit=1');
        if (rows.length) {
          document.getElementById('s-arr-label').value = rows[0].label || '';
          document.getElementById('s-arr-lat').value = rows[0].lat ?? '';
          document.getElementById('s-arr-lng').value = rows[0].lng ?? '';
          document.getElementById('s-arr-radius').value = rows[0].radius_m || 150;
          arrStatus('Saved place: ' + (rows[0].label || ''));
        }
      } catch { /* arrival is optional */ }
    })();
    document.getElementById('s-arr-geo').onclick = () => {
      if (!navigator.geolocation) { arrStatus('This browser cannot share a location.'); return; }
      arrStatus('Reading your location once…');
      navigator.geolocation.getCurrentPosition((pos) => {
        document.getElementById('s-arr-lat').value = pos.coords.latitude.toFixed(6);
        document.getElementById('s-arr-lng').value = pos.coords.longitude.toFixed(6);
        arrStatus('Location filled in. Tap “Save place” to keep it.');
      }, () => arrStatus('Location was not available. You can type the coordinates instead.'), { timeout: 10000 });
    };
    document.getElementById('s-arr-save').onclick = async () => {
      const label = document.getElementById('s-arr-label').value.trim();
      const lat = parseFloat(document.getElementById('s-arr-lat').value);
      const lng = parseFloat(document.getElementById('s-arr-lng').value);
      const radius = parseInt(document.getElementById('s-arr-radius').value, 10) || 150;
      if (!label || Number.isNaN(lat) || Number.isNaN(lng)) { arrStatus('Please add a name and coordinates first.'); return; }
      try {
        await api.patch('/profiles?id=eq.' + uid(), { arrival_share: true });
        if (S.me) S.me.arrival_share = true;
        await api.del('/arrival_places?user_id=eq.' + uid());
        await api.post('/arrival_places', { user_id: uid(), label, lat, lng, radius_m: radius });
        arrStatus('Saved. Your partner will only ever see the place name when you tap “I reached”.');
      } catch (e) { arrStatus('Could not save: ' + e.message); }
    };
    document.getElementById('s-arr-reached').onclick = async () => {
      const label = document.getElementById('s-arr-label').value.trim();
      if (!S.coupleId) { arrStatus('Link with your partner first.'); return; }
      if (!label) { arrStatus('Save a place first, so the message has its name.'); return; }
      try {
        await api.post('/events', { couple_id: S.coupleId, sender_id: uid(), kind: 'presence', payload: 'arrival:' + label });
        arrStatus('Sent — your partner will see that you reached ' + label + ' when their app is open.');
      } catch (e) { arrStatus('Could not send: ' + e.message); }
    };
    // Linking box
    const linkBox = document.getElementById('s-link');
    if (S.partner) {
      linkBox.innerHTML = '<p style="margin:0">💞 You are linked with <strong>' + esc(S.partner.display_name) + '</strong>.</p>' +
        '<p class="tiny muted">Your chat is protected with end-to-end encryption. Only the two of you can ever be in this couple.</p>' +
        '<button class="btn btn-danger" id="s-unlink">Unlink from my partner</button>';
      document.getElementById('s-unlink').onclick = async () => {
        const ok = await confirmDlg('Unlink from your partner?', 'This ends the couple link for both of you and removes the shared couple space. This cannot be undone.', 'Unlink');
        if (!ok) return;
        try { await api.rpc('unlink_couple'); toast('You have been unlinked.'); await loadCouple(); render(); }
        catch (e) { toast(e.message); }
      };
    } else {
      linkBox.innerHTML =
        '<p class="small" style="margin-top:0">One of you creates an invitation code; the other enters it. Codes last 24 hours, and a couple always has exactly two people.</p>' +
        (code ? '<div class="card" style="background:var(--surfaceSoft);text-align:center"><div class="tiny muted">Your invitation code</div><div style="font-family:monospace;font-size:30px;letter-spacing:.2em">' + esc(code) + '</div><p class="tiny muted">Share it with your partner privately.</p></div>' : '<button class="btn btn-primary" id="s-invite">Create my invitation code</button>') +
        '<label class="field" for="s-join">Partner’s invitation code</label><input type="text" id="s-join" placeholder="e.g. AB12CD34" style="text-transform:uppercase">' +
        '<div style="height:10px"></div><button class="btn btn-soft" id="s-join-go">Link with this code</button>' +
        '<p class="error-text" id="s-link-err"></p>';
      const create = document.getElementById('s-invite');
      if (create) create.onclick = async () => {
        create.disabled = true;
        try { const c = await api.rpc('create_invite'); setCode(typeof c === 'string' ? c : String(c)); render(); }
        catch (e) { document.getElementById('s-link-err').textContent = e.message; create.disabled = false; }
      };
      document.getElementById('s-join-go').onclick = async () => {
        const codeIn = document.getElementById('s-join').value.trim().toUpperCase();
        const err = document.getElementById('s-link-err');
        if (!codeIn) { err.textContent = 'Please enter the code.'; return; }
        try {
          await api.rpc('join_with_code', { p_code: codeIn });
          toast('You are linked! 💞');
          await loadCouple();
          render();
        } catch (e) { err.textContent = e.message; }
      };
    }
    document.getElementById('s-logout').onclick = async () => { await api.logOut(); location.reload(); };
    document.getElementById('s-wipe').onclick = async () => {
      const ok = await confirmDlg('Delete this browser’s local data?', 'Your wrapped message key, PIN, start date and preferences in this browser will be removed. You will need your account password to unlock messages here again.', 'Delete local data');
      if (!ok) return;
      Object.keys(localStorage).filter((k) => k.startsWith('uaw.')).forEach((k) => localStorage.removeItem(k));
      await api.logOut();
      location.reload();
    };
  };
  render();
});

// ---------------------------------------------------------------- boot
initFeatures();
applyTheme();
(async () => {
  const session = api.loadSession();
  if (!session) { showScreen('onboarding'); return; }
  try {
    const profs = await api.get('/profiles?id=eq.' + uid() + '&select=id,display_name,role,battery_share,arrival_share,avatar_data');
    S.me = profs[0] || null;
  } catch { S.me = null; }
  const pin = ls.get(pinKey(), null);
  const proceed = () => {
    if (!S.me) { showScreen('auth'); return; }
    if (ls.get('wrappedKey:' + uid(), null)) showScreen('unlock');
    else showScreen('auth');
  };
  if (pin && pin.on) showScreen('pinlock', { next: proceed });
  else proceed();
})();
