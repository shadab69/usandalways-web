// US & Always — web feature screens: Games hub (Tic Tac Toe, Ludo, Spin
// the Bottle, Virtual Pet), Together hub (Playlist, Listen/Watch, Draw,
// Read), Memories hub (Album, Journey, Bucket List, Memories, Check-in,
// Conflict Resolution, Gifts) and the Couple Room. Every screen talks to
// the same Supabase tables and payload formats as the Android app.

import * as api from './api.mjs';
import * as E from './crypto.mjs';
import {
  S, registerScreen, showScreen, topbar, wireBack, esc, toast, sheet, closeSheet,
  confirmDlg, every, sealText, openText, sealFileBytes, openFileBytes, e2eeReady, setPlaybackHandler,
  BUILTIN, rcList, uid, todayIso, initials, daysTogether, prevIsoDay,
  cacheMyCheckin, openChatWireRetry,
} from './app.js';
import { latestRowPerUser, nextSpinCount, playbackDecision, classifyMediaLink, syncBroadcastDecision } from './logic.mjs';

const KEYS_NOT_READY = 'Your partner’s message key isn’t available yet — ask your partner to open the app once, then try again.';

function needLink(title) {
  appEl().innerHTML = topbar(title, { back: true }) +
    '<div class="screen"><div class="card"><h3>Link with your partner first</h3><p class="muted small">This part of US &amp; Always opens once the two of you are linked. Create an invitation code, or enter your partner’s code, in Settings.</p></div><button class="btn btn-primary" id="nl-go">Go to Settings</button></div>';
  wireBack({ name: 'home' });
  document.getElementById('nl-go').onclick = () => showScreen('settings');
  return true;
}
const appEl = () => document.getElementById('app');
function hubRow(icon, name, desc, screen, param) {
  return '<div class="hub-slot"><button class="hub-row" data-go="' + screen + '" data-param="' + (param || '') + '">' +
    '<span class="hub-tile">' + icon + '</span><span class="hub-text"><span class="hub-name">' + esc(name) + '</span>' +
    '<span class="hub-desc">' + esc(desc) + '</span></span><span class="hub-chevron">›</span></button></div>';
}
function wireHub() {
  appEl().querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => showScreen(b.dataset.go, b.dataset.param || undefined); });
}
async function loadGame(kind) {
  // One canonical row per couple+kind: the SMALLEST id, chosen the
  // same way on every device. (Before this, the newest row won — when
  // both partners opened a game for the first time at the same moment,
  // each created a row and the two phones followed different rows:
  // both sides waited for the other forever.) Extra active rows are
  // retired so they stop competing.
  const rows = await api.get('/games?couple_id=eq.' + S.coupleId + '&kind=eq.' + kind + '&status=eq.active&order=id.asc&select=id,state,turn_user,status,winner');
  if (rows.length > 1) {
    for (const extra of rows.slice(1)) {
      api.patch('/games?id=eq.' + extra.id, { status: 'superseded' }).catch(() => {});
    }
  }
  if (rows[0]) return rows[0];
  // No active game: fall back to the latest finished one so a won
  // game still displays its result until someone starts a new one.
  const done = await api.get('/games?couple_id=eq.' + S.coupleId + '&kind=eq.' + kind + '&order=created_at.desc&limit=1&select=id,state,turn_user,status,winner');
  return done[0] || null;
}
async function createGame(kind, state, turnUser) {
  const rows = await api.post('/games', { couple_id: S.coupleId, kind, state, turn_user: turnUser, status: 'active' }, 'return=representation');
  return rows[0];
}
async function patchGame(id, state, turnUser, status, winner) {
  const body = { state, turn_user: turnUser, status, updated_at: new Date().toISOString() };
  if (winner) body.winner = winner;
  await api.patch('/games?id=eq.' + id, body);
}
const partnerId = () => (S.partner ? S.partner.id : '');

// ================================================================ Games hub
function gamesHub() {
  if (!S.partner) return needLink('Games');
  appEl().innerHTML = topbar('Games and Your Pet', { back: true, subtitle: 'Play together, wherever you are' }) +
    '<div class="screen"><div class="hub">' +
    hubRow('⭕', 'Tic Tac Toe', 'The classic game, just the two of you.', 'ttt') +
    hubRow('🎲', 'Ludo Together', 'Race your tokens all the way home.', 'ludo') +
    hubRow('🍾', 'Spin the Bottle', 'A shared spin, then a truth or a dare.', 'spin') +
    hubRow('🐾', 'Virtual Pet', 'One little pet you both look after.', 'pet') +
    '</div></div>';
  wireBack({ name: 'together' });
  wireHub();
}

// ================================================================ Tic Tac Toe (state: {"s":"board|turn|status|scoreX|scoreO","x":xPlayerId})
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
function tttWinner(board) {
  for (const [a, b, c] of TTT_LINES) if (board[a] !== '.' && board[a] === board[b] && board[a] === board[c]) return board[a];
  return '';
}
function tttParse(s) {
  try {
    const p = String(s).split('|');
    return { board: p[0].length === 9 ? p[0] : '.........', turn: p[1] || 'X', status: p[2] || 'active', scoreX: parseInt(p[3], 10) || 0, scoreO: parseInt(p[4], 10) || 0 };
  } catch { return { board: '.........', turn: 'X', status: 'active', scoreX: 0, scoreO: 0 }; }
}
function tttSerialize(st) { return st.board + '|' + st.turn + '|' + st.status + '|' + st.scoreX + '|' + st.scoreO; }
function tttScreen() {
  if (!S.partner) return needLink('Tic Tac Toe');
  let game = null; let st = tttParse('.........|X|active|0|0'); let xPlayer = '';
  let saving = false; // bug #9: polls must not overwrite an in-flight move
  appEl().innerHTML = topbar('Tic Tac Toe', { back: true }) +
    '<div class="screen"><p class="center muted" id="ttt-status">Loading…</p>' +
    '<div class="ttt-grid" id="ttt-grid"></div>' +
    '<p class="center" id="ttt-score"></p>' +
    '<button class="btn btn-soft" id="ttt-rematch" hidden>Play another round</button>' +
    '<div class="grow"></div></div>';
  wireBack({ name: 'games' });
  const myMark = () => (xPlayer === uid() ? 'X' : 'O');
  const render = () => {
    const grid = document.getElementById('ttt-grid');
    if (!grid) return;
    grid.innerHTML = st.board.split('').map((c, i) => '<button class="ttt-cell" data-cell="' + i + '">' + (c === '.' ? '' : c) + '</button>').join('');
    grid.querySelectorAll('[data-cell]').forEach((b) => { b.onclick = () => move(Number(b.dataset.cell)); });
    const statusEl = document.getElementById('ttt-status');
    const scoreEl = document.getElementById('ttt-score');
    const xName = xPlayer === uid() ? 'You' : (S.partner ? S.partner.display_name : 'Partner');
    const oName = xPlayer === uid() ? (S.partner ? S.partner.display_name : 'Partner') : 'You';
    if (scoreEl) scoreEl.textContent = xName + ' (X): ' + st.scoreX + ' · ' + oName + ' (O): ' + st.scoreO;
    const rematch = document.getElementById('ttt-rematch');
    if (rematch) rematch.hidden = st.status === 'active';
    if (statusEl) {
      if (st.status === 'won') {
        const w = tttWinner(st.board);
        statusEl.textContent = (w === myMark() ? 'You won this round! 🎉' : (S.partner ? S.partner.display_name : 'Your partner') + ' won this round.');
      } else if (st.status === 'draw') statusEl.textContent = 'A draw — nobody takes this one.';
      else statusEl.textContent = st.turn === myMark() ? 'Your turn — you are ' + myMark() + '.' : 'Waiting for ' + (S.partner ? S.partner.display_name : 'your partner') + ' (' + st.turn + ')…';
    }
  };
  const load = async () => {
    if (saving) return; // bug #9: skip this poll cycle while a move is saving
    let row = await loadGame('tictactoe');
    if (!row) {
      xPlayer = uid();
      st = tttParse('.........|X|active|0|0');
      game = await createGame('tictactoe', { s: tttSerialize(st), x: xPlayer }, uid());
      // Bug #9: if both partners created a row at the same moment,
      // adopt the newest one so both devices play on the same row.
      row = await loadGame('tictactoe');
      if (row && row.id !== game.id) game = row;
    }
    if (row) {
      game = row;
      st = tttParse(row.state.s || '');
      xPlayer = row.state.x || '';
    }
    render();
  };
  const move = async (cell) => {
    if (!game || saving || st.status !== 'active' || st.turn !== myMark() || st.board[cell] !== '.') return;
    const boardArr = st.board.split('');
    boardArr[cell] = myMark();
    const board = boardArr.join('');
    const w = tttWinner(board);
    const next = { board, turn: myMark(), status: 'active', scoreX: st.scoreX, scoreO: st.scoreO };
    if (w) { next.status = 'won'; if (w === 'X') next.scoreX++; else next.scoreO++; }
    else if (!board.includes('.')) next.status = 'draw';
    else next.turn = myMark() === 'X' ? 'O' : 'X';
    st = next;
    render();
    const turnUser = next.status === 'active' ? (next.turn === 'X' ? xPlayer : partnerId()) : uid();
    saving = true;
    try {
      await patchGame(game.id, { s: tttSerialize(next), x: xPlayer }, turnUser, next.status, next.status === 'won' ? (w === 'X' ? xPlayer : partnerId()) : null);
    } catch (e) { toast(e.message); }
    saving = false;
  };
  document.getElementById('ttt-rematch').onclick = async () => {
    if (!game || saving) return;
    st = { board: '.........', turn: 'X', status: 'active', scoreX: st.scoreX, scoreO: st.scoreO };
    render();
    saving = true;
    try {
      await patchGame(game.id, { s: tttSerialize(st), x: xPlayer }, xPlayer, 'active', null);
    } catch (e) { toast(e.message); }
    saving = false;
  };
  load().catch((e) => toast(e.message));
  every(3000, load);
}

// ================================================================ Ludo (engine ported exactly from LudoEngine.java)
const Ludo = {
  TRACK: 52, BASE: -1, HOME: 56, STARTS: [0, 26], SAFE: [0, 8, 13, 21, 26, 34, 39, 47],
  newGame() { return { pos: Array(8).fill(-1), turn: 0, dice: 0, sixes: 0, winner: -1 }; },
  isSafe(cell) { return Ludo.SAFE.includes(cell); },
  absCell(player, progress) { if (progress < 0 || progress > 50) return -1; return (Ludo.STARTS[player] + progress) % Ludo.TRACK; },
  roll(s) {
    if (s.dice !== 0 || s.winner >= 0) return false;
    const value = 1 + Math.floor(Math.random() * 6);
    if (value === 6) {
      s.sixes++;
      if (s.sixes >= 3) { s.sixes = 0; s.turn = 1 - s.turn; return true; }
    } else s.sixes = 0;
    s.dice = value;
    return true;
  },
  movable(s, player) {
    const out = [];
    if (s.dice === 0 || s.winner >= 0 || player !== s.turn) return out;
    for (let t = 0; t < 4; t++) {
      const p = s.pos[player * 4 + t];
      if (p === Ludo.BASE) { if (s.dice === 6) out.push(t); }
      else if (p < Ludo.HOME && p + s.dice <= Ludo.HOME) out.push(t);
    }
    return out;
  },
  isStuck(s) { return s.dice !== 0 && s.winner < 0 && Ludo.movable(s, s.turn).length === 0; },
  passIfStuck(s) { if (!Ludo.isStuck(s)) return; s.dice = 0; s.sixes = 0; s.turn = 1 - s.turn; },
  move(s, player, token) {
    if (player !== s.turn || s.winner >= 0) return false;
    if (!Ludo.movable(s, player).includes(token)) return false;
    const idx = player * 4 + token;
    const from = s.pos[idx];
    const to = from === Ludo.BASE ? 0 : from + s.dice;
    s.pos[idx] = to;
    let captured = false;
    if (to >= 0 && to <= 50) {
      const cell = Ludo.absCell(player, to);
      if (!Ludo.isSafe(cell)) {
        const opp = 1 - player;
        for (let t = 0; t < 4; t++) {
          const oi = opp * 4 + t;
          if (s.pos[oi] >= 0 && s.pos[oi] <= 50 && Ludo.absCell(opp, s.pos[oi]) === cell) { s.pos[oi] = Ludo.BASE; captured = true; }
        }
      }
    }
    const broughtHome = to === Ludo.HOME;
    if (s.pos.slice(player * 4, player * 4 + 4).every((p) => p === Ludo.HOME)) s.winner = player;
    const extraRoll = s.dice === 6 || captured || broughtHome;
    s.dice = 0;
    if (!extraRoll && s.winner < 0) { s.sixes = 0; s.turn = 1 - player; }
    return true;
  },
  serialize(s) { return s.pos.join(',') + ';' + s.turn + ';' + s.dice + ';' + s.sixes + ';' + s.winner; },
  parse(text) {
    try {
      const parts = String(text).split(';');
      const pos = parts[0].split(',').map((x) => parseInt(x, 10));
      if (pos.length !== 8 || pos.some(Number.isNaN)) return Ludo.newGame();
      return { pos, turn: parseInt(parts[1], 10) || 0, dice: parseInt(parts[2], 10) || 0, sixes: parseInt(parts[3], 10) || 0, winner: parts[4] === undefined ? -1 : parseInt(parts[4], 10) };
    } catch { return Ludo.newGame(); }
  },
};
// Track coordinates: 52 cells around a rounded square loop (percent units).
function ludoCellXY(abs) {
  const side = Math.floor(abs / 13), off = abs % 13;
  const a = 10, b = 90, step = (b - a) / 13;
  if (side === 0) return [a + off * step + step / 2, b];        // bottom, left → right
  if (side === 1) return [b, b - off * step - step / 2];        // right, bottom → top
  if (side === 2) return [b - off * step - step / 2, a];        // top, right → left
  return [a, a + off * step + step / 2];                        // left, top → bottom
}
function ludoTokenXY(player, progress, tokenIdx) {
  if (progress === Ludo.BASE) {
    const cx = player === 0 ? 22 : 78, cy = player === 0 ? 78 : 22;
    return [cx + (tokenIdx % 2 ? 7 : -7), cy + (tokenIdx < 2 ? -7 : 7)];
  }
  if (progress === Ludo.HOME) return [50 + (player === 0 ? -4 : 4), 50 + (tokenIdx % 2 ? 3 : -3)];
  if (progress > 50) {
    const entry = ludoCellXY(Ludo.absCell(player, 50));
    const t = (progress - 50) / 6;
    return [entry[0] + (50 - entry[0]) * t, entry[1] + (50 - entry[1]) * t];
  }
  const [x, y] = ludoCellXY(Ludo.absCell(player, progress));
  return [x, y];
}
function ludoScreen() {
  if (!S.partner) return needLink('Ludo Together');
  let game = null; let st = Ludo.newGame(); let p0 = '';
  let saving = false; // bug #9: polls must not overwrite an in-flight save
  let passTimerFor = ''; // self-heal: a stuck roll must pass even after a reload
  const COLORS = ['#C05B2E', '#2774C8'];
  appEl().innerHTML = topbar('Ludo Together', { back: true }) +
    '<div class="screen"><p class="center muted" id="ludo-status">Loading…</p>' +
    '<div class="ludo-board" id="ludo-board"></div>' +
    '<div class="btn-row"><button class="btn btn-primary" id="ludo-roll">🎲 Roll the dice</button></div>' +
    '<p class="center" id="ludo-dice" style="font-size:20px"></p>' +
    '<button class="btn btn-soft" id="ludo-new" hidden>Start a new game</button><div class="grow"></div></div>';
  wireBack({ name: 'games' });
  const myIdx = () => (p0 === uid() ? 0 : 1);
  const render = () => {
    const board = document.getElementById('ludo-board');
    if (!board) return;
    let html = '';
    for (let i = 0; i < 52; i++) {
      const [x, y] = ludoCellXY(i);
      html += '<span class="ludo-cell' + (Ludo.isSafe(i) ? ' safe' : '') + '" style="left:' + x + '%;top:' + y + '%"></span>';
    }
    const movable = Ludo.movable(st, myIdx());
    st.pos.forEach((p, idx) => {
      const player = Math.floor(idx / 4), token = idx % 4;
      const [x, y] = ludoTokenXY(player, p, token);
      const can = player === myIdx() && movable.includes(token);
      html += '<button class="ludo-token' + (can ? ' movable' : '') + '" data-token="' + token + '" aria-label="Token" style="left:' + x + '%;top:' + y + '%;background:' + COLORS[player] + '"></button>';
    });
    board.innerHTML = html;
    board.querySelectorAll('[data-token]').forEach((b) => { b.onclick = () => doMove(Number(b.dataset.token)); });
    const statusEl = document.getElementById('ludo-status');
    const diceEl = document.getElementById('ludo-dice');
    const rollBtn = document.getElementById('ludo-roll');
    const newBtn = document.getElementById('ludo-new');
    if (newBtn) newBtn.hidden = false; // always available: a wedged game needs an escape hatch
    if (diceEl) diceEl.textContent = st.dice ? '🎲 ' + st.dice : '';
    if (rollBtn) rollBtn.disabled = !(st.winner < 0 && st.turn === myIdx() && st.dice === 0);
    if (statusEl) {
      if (st.winner >= 0) statusEl.textContent = st.winner === myIdx() ? 'You won! 🎉 All your tokens are home.' : (S.partner.display_name + ' won this game.');
      else if (st.turn === myIdx() && st.dice && movable.length === 0) statusEl.textContent = '🎲 ' + st.dice + ' — no token can move with this roll (a token needs a 6 to leave home). Turn passing…';
      else statusEl.textContent = st.turn === myIdx() ? (st.dice ? 'Your roll: tap a glowing token to move it.' : 'Your turn — roll the dice.') : 'Waiting for ' + S.partner.display_name + '…';
    }
    // Self-heal a stuck turn: if the saved state is my turn with a roll
    // that cannot move anything (e.g. the app was closed before the
    // auto-pass fired), pass it from here — the roll button's own timer
    // only runs on the device that rolled, in that same page view.
    if (st.winner < 0 && st.turn === myIdx() && st.dice !== 0 && movable.length === 0) {
      const key = (game ? game.id : 'nogame') + ':' + st.turn + ':' + st.dice + ':' + st.pos.join(',');
      if (passTimerFor !== key) {
        passTimerFor = key;
        setTimeout(async () => {
          if (passTimerFor !== key) return;
          Ludo.passIfStuck(st); render(); await save();
        }, 2500);
      }
    }
  };
  const save = async () => {
    if (!game) return;
    saving = true;
    try {
      const turnUser = st.turn === 0 ? p0 : partnerId();
      await patchGame(game.id, { s: Ludo.serialize(st), p0 }, turnUser, st.winner >= 0 ? 'won' : 'active', st.winner >= 0 ? (st.winner === 0 ? p0 : partnerId()) : null);
    } catch (e) { toast(e.message); }
    saving = false;
  };
  const load = async () => {
    if (saving) return; // bug #9: skip this poll cycle while a save is in flight
    let row = await loadGame('ludo');
    if (!row) {
      p0 = uid();
      st = Ludo.newGame();
      game = await createGame('ludo', { s: Ludo.serialize(st), p0 }, uid());
      // Bug #9: adopt the newest row if both partners created one.
      row = await loadGame('ludo');
      if (row && row.id !== game.id) game = row;
    }
    if (row) { game = row; st = Ludo.parse(row.state.s || ''); p0 = row.state.p0 || ''; }
    render();
  };
  const doMove = async (token) => {
    if (st.turn !== myIdx()) return;
    if (Ludo.move(st, myIdx(), token)) { render(); await save(); }
  };
  document.getElementById('ludo-roll').onclick = async () => {
    if (st.turn !== myIdx() || st.dice !== 0) return;
    Ludo.roll(st);
    render();
    await save();
    if (Ludo.isStuck(st)) {
      // Give the player time to read why nothing can move before the
      // turn passes (900ms felt like the roll was silently discarded).
      setTimeout(async () => { Ludo.passIfStuck(st); render(); await save(); }, 2000);
    }
  };
  document.getElementById('ludo-new').onclick = async () => {
    st = Ludo.newGame();
    if (game) { render(); await save(); }
  };
  load().catch((e) => toast(e.message));
  every(3000, load);
}

// ================================================================ Spin the Bottle (state: {"angle","prompt","by","n"})
function spinScreen() {
  if (!S.partner) return needLink('Spin the Bottle');
  // Bug #10: the counter starts at -1, matching Android — a partner's
  // first spin writes n = 0 and must not be mistaken for "no spin yet".
  let game = null; let count = -1; let angle = 0; let spinning = false;
  appEl().innerHTML = topbar('Spin the Bottle', { back: true }) +
    '<div class="screen"><div style="text-align:center;padding-top:8px"><div class="spin-wheel" id="spin-wheel" style="font-size:150px;line-height:220px">🍾</div></div>' +
    '<p class="center" id="spin-prompt" style="font-size:16px">Loading…</p>' +
    '<button class="btn btn-primary" id="spin-go">Spin the bottle</button>' +
    '<p class="tiny muted center">Both phones show the same spin result and the same truth or dare prompt.</p><div class="grow"></div></div>';
  wireBack({ name: 'games' });
  const render = (animate) => {
    const wheel = document.getElementById('spin-wheel');
    if (wheel) wheel.style.transform = 'rotate(' + (angle + (animate ? 1800 : 0)) + 'deg)';
  };
  const load = async () => {
    if (spinning) return; // bug #9: don't let a poll fight an in-flight spin save
    const row = await loadGame('spin');
    if (row) {
      game = row;
      const s = row.state || {};
      const next = nextSpinCount(count, s.n);
      if (next !== count) {
        count = next; angle = s.angle || 0;
        const p = document.getElementById('spin-prompt');
        if (p) p.textContent = s.prompt || '';
        render(row.state.by !== uid());
      }
    } else {
      const p = document.getElementById('spin-prompt');
      if (p) p.textContent = 'No spin yet — one of you goes first.';
    }
  };
  document.getElementById('spin-go').onclick = async () => {
    if (spinning) return;
    spinning = true;
    angle = Math.floor(Math.random() * 360);
    const prompts = rcList('truth_dare', BUILTIN.truthDare);
    const prompt = prompts[Math.floor(Math.random() * prompts.length)];
    count += 1;
    const p = document.getElementById('spin-prompt');
    if (p) p.textContent = prompt;
    render(true);
    const state = { angle, prompt, by: uid(), n: count };
    try {
      if (!game) game = await createGame('spin', state, uid());
      else await patchGame(game.id, state, uid(), 'active', null);
    } catch (e) { toast(e.message); }
    setTimeout(() => { spinning = false; }, 2800);
  };
  load().catch((e) => toast(e.message));
  every(3000, load);
}

// ================================================================ Virtual Pet (pet_state; decay from PetLogic.java)
const Pet = {
  decayed(h, hp, e, elapsedMs) {
    const el = Math.max(0, elapsedMs);
    const clamp = (v) => Math.max(0, Math.min(100, v));
    return [clamp(h - Math.floor(el / 480000)), clamp(hp - Math.floor(el / 720000)), clamp(e - Math.floor(el / 900000))];
  },
  mood(h, hp, e) { const avg = Math.floor((h + hp + e) / 3); return avg >= 70 ? 2 : avg >= 40 ? 1 : 0; },
};
function petScreen() {
  if (!S.partner) return needLink('Virtual Pet');
  let pet = null; let editing = false;
  appEl().innerHTML = topbar('Virtual Pet', { back: true, subtitle: 'One little pet you both look after' }) +
    '<div class="screen"><div id="pet-box"><p class="muted center">Loading your pet…</p></div><div class="grow"></div></div>';
  wireBack({ name: 'games' });
  const current = () => {
    if (!pet) return [80, 80, 80];
    return Pet.decayed(pet.hunger, pet.happiness, pet.energy, Date.now() - new Date(pet.updated_at).getTime());
  };
  const render = () => {
    const box = document.getElementById('pet-box');
    if (!box || !pet || editing) return;
    const [h, hp, e] = current();
    const mood = Pet.mood(h, hp, e);
    const face = mood === 2 ? '😺' : mood === 1 ? '🐱' : '😿';
    const moodText = mood === 2 ? 'is happy and loved.' : mood === 1 ? 'is doing okay.' : 'needs some care.';
    const bar = (label, v) => '<div style="margin:8px 0"><div class="flex" style="justify-content:space-between"><span class="small">' + label + '</span><span class="small muted">' + v + '</span></div><div class="stat-bar"><i style="width:' + v + '%"></i></div></div>';
    box.innerHTML = '<div class="pet-face">' + face + '</div>' +
      '<h1 class="display center" style="font-size:26px">' + esc(pet.name) + '</h1>' +
      '<p class="center muted small">' + esc(pet.name) + ' ' + moodText + '</p>' +
      '<div class="card">' + bar('🍲 Fullness', h) + bar('💗 Happiness', hp) + bar('⚡ Energy', e) + '</div>' +
      '<div class="btn-row"><button class="btn btn-soft" id="pet-feed">🍲 Feed</button><button class="btn btn-soft" id="pet-play">🎾 Play</button><button class="btn btn-soft" id="pet-rest">😴 Rest</button></div>' +
      '<div class="btn-row"><input type="text" id="pet-name" value="' + esc(pet.name) + '" aria-label="Pet name"><button class="btn btn-ghost" style="width:auto" id="pet-rename">Rename</button></div>';
    const act = async (fn) => {
      const [ch, chp, ce] = current();
      const [nh, nhp, ne] = fn(ch, chp, ce);
      const body = { hunger: nh, happiness: nhp, energy: ne, updated_at: new Date().toISOString() };
      try { await api.patch('/pet_state?couple_id=eq.' + S.coupleId, body); pet = { ...pet, ...body }; render(); }
      catch (e) { toast(e.message); }
    };
    document.getElementById('pet-feed').onclick = () => act((h, hp, e) => [Math.min(100, h + 25), hp, e]);
    document.getElementById('pet-play').onclick = () => act((h, hp, e) => [h, Math.min(100, hp + 20), Math.max(0, e - 10)]);
    document.getElementById('pet-rest').onclick = () => act((h, hp, e) => [h, hp, Math.min(100, e + 30)]);
    const nameInput = document.getElementById('pet-name');
    nameInput.addEventListener('focus', () => { editing = true; });
    nameInput.addEventListener('blur', () => { editing = false; });
    document.getElementById('pet-rename').onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) { toast('Please give your pet a name.'); return; }
      try { await api.patch('/pet_state?couple_id=eq.' + S.coupleId, { name, updated_at: new Date().toISOString() }); pet.name = name; editing = false; render(); toast('Say hello to ' + name + '!'); }
      catch (e) { toast(e.message); }
    };
  };
  const load = async () => {
    const rows = await api.get('/pet_state?couple_id=eq.' + S.coupleId + '&select=couple_id,name,hunger,happiness,energy,updated_at');
    if (!rows.length) {
      await api.post('/pet_state', { couple_id: S.coupleId, name: 'Milo', hunger: 80, happiness: 80, energy: 80 });
      return load();
    }
    pet = rows[0];
    render();
  };
  load().catch((e) => toast(e.message));
  every(5000, load);
}

// ================================================================ Together hub
function togetherHub(param) {
  if (!S.partner) return needLink('Together');
  if (param && ['playlist', 'listen', 'watch', 'draw', 'read'].includes(param)) return showScreen(param);
  appEl().innerHTML = topbar('Together', { subtitle: 'Quality time, side by side' }) +
    '<div class="screen"><p class="lede">Things to do together, even from far away.</p><div class="hub">' +
    hubRow('🎮', 'Games and Your Pet', 'Tic Tac Toe, Ludo, Spin the Bottle — and your shared pet.', 'games') +
    hubRow('🎵', 'Playlist', 'Songs and links you both love, in one shared list.', 'playlist') +
    hubRow('🎧', 'Listen Together', 'Hear the same song at the same moment.', 'listen') +
    hubRow('🎬', 'Watch Together', 'Watch a video together, in step.', 'watch') +
    hubRow('🎨', 'Draw Together', 'Doodle together on one shared canvas.', 'draw') +
    hubRow('📖', 'Read Together', 'Read the same book, page by page.', 'read') +
    hubRow('🏠', 'Our Room', 'Your shared space — a status line, your pet and more.', 'room') +
    '</div></div>';
  wireHub();
}

// ================================================================ Playlist
function playlistScreen() {
  if (!S.partner) return needLink('Playlist');
  appEl().innerHTML = topbar('Playlist', { back: true, subtitle: 'Songs and links you both love' }) +
    '<div class="screen"><div id="pl-list"><p class="muted">Loading your playlist…</p></div>' +
    '<div class="card"><h3>Add a link</h3><label class="field" for="pl-title">Title</label><input type="text" id="pl-title" placeholder="Our song">' +
    '<label class="field" for="pl-url">Link</label><input type="url" id="pl-url" placeholder="https://…">' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="pl-add">Add to our playlist</button></div><div class="grow"></div></div>';
  wireBack({ name: 'together' });
  const load = async () => {
    const rows = await api.get('/playlist_items?couple_id=eq.' + S.coupleId + '&order=id.asc&select=id,title,url,added_by');
    const box = document.getElementById('pl-list');
    if (!box) return;
    box.innerHTML = rows.length ? rows.map((r) =>
      '<div class="list-row"><span style="font-size:20px">🎵</span><div class="grow"><div>' + esc(r.title || 'Untitled') + '</div><div class="tiny muted">' + (r.added_by === uid() ? 'Added by you' : 'Added by ' + esc(S.partner.display_name)) + '</div></div>' +
      '<button class="btn btn-soft" style="width:auto" data-open="' + esc(r.url) + '">Open</button>' +
      '<button class="btn btn-ghost" style="width:auto" data-del="' + r.id + '">Delete</button></div>').join('')
      : '<p class="muted">Nothing here yet. Add the first song below.</p>';
    box.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => window.open(b.dataset.open, '_blank', 'noopener'); });
    box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => {
      if (!await confirmDlg('Remove from playlist?', 'This link will be removed for both of you.', 'Remove')) return;
      await api.del('/playlist_items?id=eq.' + b.dataset.del).catch((e) => toast(e.message));
      load();
    }; });
  };
  document.getElementById('pl-add').onclick = async () => {
    const title = document.getElementById('pl-title').value.trim();
    const url = document.getElementById('pl-url').value.trim();
    if (!url) { toast('Please paste a link.'); return; }
    const btn = document.getElementById('pl-add');
    btn.disabled = true; btn.textContent = 'Adding…';
    try {
      await api.post('/playlist_items', { couple_id: S.coupleId, added_by: uid(), title, url });
      document.getElementById('pl-title').value = ''; document.getElementById('pl-url').value = '';
      await load();
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = 'Add to our playlist';
  };
  load().catch((e) => toast(e.message));
  every(5000, load);
}

// ================================================================ Listen / Watch Together (playback_state)

// Loads the official YouTube IFrame API once (module-level promise,
// shared by every mount of the player screens). The API is what makes
// real position readback (getCurrentTime) and player-state events
// possible — with postMessage commands alone there is no way to know
// the viewer used the embed's own seek bar or pause button, which is
// why forwards never reached the partner. If the script cannot load
// (offline, blocked), callers fall back to the postMessage behaviour.
let ytApiPromise = null;
function loadYouTubeApi() {
  if (typeof window !== 'undefined' && window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; ytApiPromise = null; reject(e); } };
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prev) { try { prev(); } catch { /* an older handler must not block us */ } }
      if (!settled) { settled = true; resolve(window.YT); }
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => fail(new Error('YouTube API failed to load'));
    document.head.appendChild(tag);
    setTimeout(() => fail(new Error('YouTube API timed out')), 10000);
  });
  return ytApiPromise;
}

function playbackScreen(kind) {
  if (!S.partner) return needLink(kind === 'music' ? 'Listen Together' : 'Watch Together');
  const isMusic = kind === 'music';
  let appliedStamp = '';
  let media = null;
  let curUrl = '';       // URL currently loaded in either player
  let ytId = '';         // YouTube video id in the embed ('' = none)
  let ytPlaying = false; // last applied YouTube play state
  let ytPosSec = 0;      // YouTube position (seconds) as of ytPosAt
  let ytPosAt = 0;       // ms epoch when ytPosSec was current
  // Sync engine (build 2026-11-18.12): the shared-state model — the
  // last playback_state row applied or broadcast, its position
  // advancing by wall clock while playing. The sampler compares the
  // local player's real readback against it (logic.syncBroadcastDecision).
  let model = null;            // { positionMs, playing, atMs } | null
  let syncSuppressUntil = 0;   // settle window after an apply/broadcast
  let broadcastBusy = false;
  let blockPauseBroadcast = false; // partner pressed play; this side has not started yet
  let ytPlayer = null;         // YT.Player once the API owns the iframe
  let ytApiState = 'idle';     // idle | loading | ready | failed
  let ytPending = null;        // latest YouTube state to apply when the API is ready
  appEl().innerHTML = topbar(isMusic ? 'Listen Together' : 'Watch Together', { back: true }) +
    '<div class="screen"><p class="lede small">Paste a YouTube link, or a direct link to ' + (isMusic ? 'an audio' : 'a video') + ' file. Both of your devices play it and stay in step.</p>' +
    '<div class="card"><label class="field" for="pb-url">' + (isMusic ? 'Audio' : 'Video') + ' link</label><input type="url" id="pb-url" placeholder="https://…/' + (isMusic ? 'song.mp3' : 'movie.mp4') + '">' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="pb-set">Set for both of us</button>' +
    '<p class="tiny muted" style="margin:8px 0 0">YouTube links and direct file links (.mp3 / .mp4) play here. Netflix, Spotify and other apps block playing inside other apps, so their links can’t be used — the same honest limit as the Android app. Music and video share one “now playing” slot, so starting one replaces the other.</p>' +
    '<p class="error-text" id="pb-link-note" style="margin:8px 0 0" hidden></p></div>' +
    '<div class="card" id="pb-other" hidden></div>' +
    '<div class="card" id="pb-player-card" hidden>' +
    '<div id="pb-yt-wrap" hidden><div style="position:relative;padding-top:56.25%;background:#000;border-radius:12px;overflow:hidden">' +
    '<iframe id="pb-yt" title="YouTube player" style="position:absolute;left:0;top:0;width:100%;height:100%;border:0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>' +
    (isMusic ? '<p class="tiny muted" style="margin:8px 0 0">YouTube songs play with their video here.</p>' : '') +
    '<p class="tiny muted" style="margin:8px 0 0">Play, pause or forward on either side — the other side follows within a second or two.</p></div>' +
    (isMusic ? '<audio id="pb-media" controls></audio>' : '<video id="pb-media" controls playsinline></video>') +
    '<div class="btn-row" style="margin-top:10px"><button class="btn btn-soft" id="pb-play">▶ Play for both</button><button class="btn btn-soft" id="pb-pause">⏸ Pause for both</button></div>' +
    '<p class="tiny muted" id="pb-status" style="margin:8px 0 0"></p></div><div class="grow"></div></div>';
  wireBack({ name: 'together' });
  media = document.getElementById('pb-media');
  const status = (t) => { const el = document.getElementById('pb-status'); if (el) el.textContent = t; };
  const linkNote = (t) => { const el = document.getElementById('pb-link-note'); if (el) { el.textContent = t || ''; el.hidden = !t; } };
  // One playback_state row, exactly as the server will return it — the
  // client supplies updated_at, so a locally built row stamps the same
  // as the fetched one and the poll will not re-apply our own writes.
  const buildBody = (url, positionMs, playing) => ({
    couple_id: S.coupleId, kind, url, position_ms: Math.round(positionMs), playing,
    updated_by: uid(), updated_at: new Date().toISOString(),
  });
  const persist = (body) => api.post('/playback_state', body, 'resolution=merge-duplicates');

  // ---- Sync engine: read the local player's truth, compare it with
  // the shared model, and broadcast when they diverge — a play/pause
  // flip, or a position more than ~2.5 s from the model (a seek,
  // including one made with the player's own controls). Applying a
  // row sets the model FIRST, so the events the player fires while
  // obeying it read as "matches the model" and never echo back.
  const readLocal = () => {
    if (ytId) {
      if (ytPlayer && ytApiState === 'ready') {
        try {
          const st = ytPlayer.getPlayerState();
          if (st === -1 || st === 5) return null; // unstarted / cued: no truth yet
          const t = ytPlayer.getCurrentTime();
          if (typeof t !== 'number' || !Number.isFinite(t)) return null;
          return { positionMs: t * 1000, playing: st === 1 || st === 3 }; // playing, or buffering towards it
        } catch { return null; }
      }
      // postMessage fallback (API unavailable): there is no readback,
      // so the "truth" is the clock-advanced estimate — which tracks
      // the model, so the sampler stays silent, exactly as before.
      return { positionMs: currentPositionMs(), playing: ytPlaying };
    }
    if (media && media.getAttribute('src')) {
      return { positionMs: media.currentTime * 1000, playing: !media.paused && !media.ended };
    }
    return null;
  };
  const runSyncCheck = async () => {
    if (!model || !curUrl || broadcastBusy) return;
    if (Date.now() < syncSuppressUntil) return;
    const local = readLocal();
    if (!local) return;
    if (local.playing) blockPauseBroadcast = false;
    const dec = syncBroadcastDecision(model, local, Date.now());
    if (!dec) return;
    // The partner pressed play and this device has not started yet
    // (autoplay rules): do not "correct" them with a pause broadcast.
    // This side starts when its user taps the player — and that play
    // is itself a local truth the sampler then sees.
    if (!dec.playing && blockPauseBroadcast) return;
    broadcastBusy = true;
    const body = buildBody(curUrl, dec.positionMs, dec.playing);
    model = { positionMs: body.position_ms, playing: body.playing, atMs: Date.now() };
    syncSuppressUntil = Date.now() + 1200;
    try { await persist(body); } catch { /* the 3 s poll reconciles */ }
    broadcastBusy = false;
  };
  const pokeSync = () => { runSyncCheck().catch(() => {}); };

  // ---- YouTube control. Preferred path: the official IFrame API —
  // real getCurrentTime() readback and onStateChange events, so the
  // embed's own play / pause / seek controls are sync inputs too.
  // Fallback when the API script cannot load: postMessage commands
  // with a clock-advanced position estimate (the previous behaviour).
  const ytCommand = (func, args) => {
    const f = document.getElementById('pb-yt');
    if (!f || !f.contentWindow) return;
    try { f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [] }), 'https://www.youtube-nocookie.com'); } catch { /* frame not ready */ }
  };
  const sendYtState = () => {
    ytCommand('seekTo', [Math.max(0, Math.floor(ytPosSec)), true]);
    ytCommand(ytPlaying ? 'playVideo' : 'pauseVideo');
  };
  const applyYtState = (id, playing, targetSec) => {
    ytPlaying = playing; ytPosSec = targetSec; ytPosAt = Date.now();
    if (!ytPlayer) return;
    try {
      if (ytId !== id) {
        ytId = id;
        const arg = { videoId: id, startSeconds: Math.max(0, Math.floor(targetSec)) };
        if (playing) ytPlayer.loadVideoById(arg); else ytPlayer.cueVideoById(arg);
      } else {
        ytPlayer.seekTo(Math.max(0, targetSec), true);
        if (playing) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
      }
    } catch { /* not ready yet — onReady reapplies the pending state */ }
  };
  const ensureYtPlayer = () => {
    if (ytPlayer || ytApiState === 'loading' || ytApiState === 'ready' || ytApiState === 'failed') return;
    ytApiState = 'loading';
    loadYouTubeApi().then((YT) => {
      const f = document.getElementById('pb-yt');
      if (!f) { ytApiState = 'idle'; return; } // screen went away — retry on the next mount
      f.onload = null; // the API owns the frame now
      try {
        ytPlayer = new YT.Player('pb-yt', {
          host: 'https://www.youtube-nocookie.com',
          events: {
            onReady: () => {
              ytApiState = 'ready';
              if (ytPending) { const p = ytPending; ytPending = null; applyYtState(p.id, p.playing, p.targetSec); }
              pokeSync();
            },
            onStateChange: () => pokeSync(),
          },
        });
      } catch { ytApiState = 'failed'; }
    }).catch(() => { ytApiState = 'failed'; });
  };
  const showYt = (id, playing, targetSec) => {
    const wrap = document.getElementById('pb-yt-wrap');
    if (wrap) wrap.hidden = false;
    ytPlaying = playing; ytPosSec = targetSec; ytPosAt = Date.now();
    if (ytPlayer) {
      if (ytApiState === 'ready') applyYtState(id, playing, targetSec);
      else ytPending = { id, playing, targetSec };
      return;
    }
    ytPending = { id, playing, targetSec };
    const f = document.getElementById('pb-yt');
    if (f) {
      if (ytId !== id) {
        ytId = id;
        // Commands posted before the player is ready can be dropped, so
        // re-send the latest state once the new embed has loaded.
        f.onload = () => sendYtState();
        f.src = 'https://www.youtube-nocookie.com/embed/' + id + '?enablejsapi=1&start=' + Math.max(0, Math.floor(targetSec)) + '&rel=0&playsinline=1' + (playing ? '&autoplay=1' : '');
      } else {
        sendYtState();
      }
    }
    if (ytApiState !== 'failed') ensureYtPlayer();
  };
  const hideYt = () => {
    const wrap = document.getElementById('pb-yt-wrap');
    if (wrap) wrap.hidden = true;
    ytPending = null;
    if (ytPlayer) { try { ytPlayer.stopVideo(); } catch { /* ignore */ } }
    const f = document.getElementById('pb-yt');
    if (f && ytId && !ytPlayer) { f.onload = null; f.src = 'about:blank'; }
    ytId = ''; ytPlaying = false;
  };
  const stopPlayers = () => {
    if (media) { try { media.pause(); } catch { /* not ready */ } }
    hideYt();
  };
  const currentPositionMs = () => {
    if (ytId) {
      if (ytPlayer && ytApiState === 'ready') {
        try { const t = ytPlayer.getCurrentTime(); if (typeof t === 'number' && Number.isFinite(t)) return t * 1000; } catch { /* estimate below */ }
      }
      return Math.max(0, (ytPosSec + (ytPlaying ? (Date.now() - ytPosAt) / 1000 : 0)) * 1000);
    }
    return media ? media.currentTime * 1000 : 0;
  };

  // Apply one playback_state row — fetched, or built locally so a
  // button press shows on THIS screen at once instead of after the
  // next poll round-trip — to whichever player the URL needs.
  const applyRow = (row, force) => {
    const card = document.getElementById('pb-player-card');
    const other = document.getElementById('pb-other');
    if (other) other.hidden = true;
    if (card) card.hidden = false;
    const stamp = row.updated_at + '|' + row.url + '|' + row.playing + '|' + row.position_ms;
    if (!force && stamp === appliedStamp) return;
    appliedStamp = stamp;
    curUrl = row.url;
    // The sync model becomes this row BEFORE the players are driven,
    // so the events they fire while obeying it match the model and
    // never echo back as a fresh broadcast.
    const rowAtMs = new Date(row.updated_at).getTime();
    model = { positionMs: row.position_ms, playing: !!row.playing, atMs: Number.isFinite(rowAtMs) ? rowAtMs : Date.now() };
    syncSuppressUntil = Date.now() + 1200;
    if (row.playing && row.updated_by !== uid()) blockPauseBroadcast = true;
    const inp = document.getElementById('pb-url');
    if (inp && row.updated_by !== uid()) inp.value = row.url;
    const elapsed = row.playing ? (Date.now() - new Date(row.updated_at).getTime()) / 1000 : 0;
    const target = row.position_ms / 1000 + Math.max(0, elapsed);
    const cls = classifyMediaLink(row.url);
    if (cls.type === 'youtube') {
      // The direct element must never be handed a web-page URL.
      if (media.getAttribute('src')) { media.removeAttribute('src'); media.load(); }
      try { media.pause(); } catch { /* not ready */ }
      media.hidden = true;
      showYt(cls.id, !!row.playing, target);
      status(row.updated_by === uid() ? 'You set what is playing.' : S.partner.display_name + ' set what is playing.');
      return;
    }
    hideYt();
    media.hidden = false;
    if (media.getAttribute('src') !== row.url) media.src = row.url;
    const apply = () => {
      if (Math.abs(media.currentTime - target) > 1.5 && media.duration) media.currentTime = Math.min(target, media.duration - 0.2);
      if (row.playing) media.play().catch(() => { blockPauseBroadcast = true; status('Tap the player to start — your partner pressed play.'); });
      else media.pause();
      status(row.updated_by === uid() ? 'You set what is playing.' : S.partner.display_name + ' set what is playing.');
    };
    if (media.readyState >= 1) apply(); else media.addEventListener('loadedmetadata', apply, { once: true });
  };

  document.getElementById('pb-set').onclick = async () => {
    const url = document.getElementById('pb-url').value.trim();
    if (!url) { toast('Please paste a link first.'); return; }
    const cls = classifyMediaLink(url);
    if (cls.type === 'invalid') { linkNote(''); toast('That doesn’t look like a link. Paste the full link, starting with https://'); return; }
    if (cls.type === 'app') {
      const msg = 'Links from ' + cls.host + ' can’t be played inside another app — their rules, not ours. Paste a YouTube link, or a direct file link (.mp3 / .mp4), and it will play for both of you.';
      linkNote(msg);
      toast(msg);
      return;
    }
    linkNote('');
    const body = buildBody(url, 0, false);
    applyRow(body, true);
    toast('Set for both of you.');
    try { await persist(body); } catch (e) { toast(e.message); }
  };
  document.getElementById('pb-play').onclick = async () => {
    if (!curUrl) return;
    const body = buildBody(curUrl, currentPositionMs(), true);
    applyRow(body, true);
    try { await persist(body); } catch (e) { toast(e.message); }
  };
  document.getElementById('pb-pause').onclick = async () => {
    if (!curUrl) return;
    const body = buildBody(curUrl, currentPositionMs(), false);
    applyRow(body, true);
    try { await persist(body); } catch (e) { toast(e.message); }
  };
  // One row, from the poll or from realtime — same handling either way.
  const handleRow = (row) => {
    const card = document.getElementById('pb-player-card');
    const other = document.getElementById('pb-other');
    // Bug #7: the shared row may belong to the OTHER player (music vs
    // video). Never load the partner's video into this audio element
    // (or vice versa) and never write state against the wrong kind.
    const decision = playbackDecision(row, kind);
    if (decision === 'empty') { stopPlayers(); curUrl = ''; model = null; if (card) card.hidden = true; if (other) other.hidden = true; return; }
    if (decision === 'other') {
      stopPlayers(); curUrl = ''; model = null;
      if (card) card.hidden = true;
      if (other) {
        other.hidden = false;
        other.innerHTML = '<p style="margin:0">🎬 Your partner is ' + (row.kind === 'video' ? 'watching something in Watch Together' : 'listening to something in Listen Together') + ' right now.</p>' +
          '<p class="tiny muted" style="margin:8px 0 0">Music and video share one “now playing” slot — setting a link above takes the slot over for this player.</p>';
      }
      return;
    }
    applyRow(row, false);
  };
  const load = async () => {
    const rows = await api.get('/playback_state?couple_id=eq.' + S.coupleId + '&select=kind,url,position_ms,playing,updated_by,updated_at');
    if (!rows.length) return;
    handleRow(rows[0]);
  };
  load().catch(() => {});
  every(3000, () => load());
  // Sync sampler: the safety net behind the player events — catches
  // anything they missed within about a second.
  every(1000, () => runSyncCheck());
  // The media element's own controls are sync inputs too: their events
  // poke an immediate check instead of waiting for the sampler.
  media.addEventListener('play', pokeSync);
  media.addEventListener('pause', pokeSync);
  media.addEventListener('seeked', pokeSync);
  // Realtime: a partner's row lands the moment it is written, not at
  // the next 3 s poll. Our own rows are ignored here — they were
  // already applied locally when broadcast (the poll's stamp check
  // covers the rest). Unregistered by showScreen on the way out.
  setPlaybackHandler((row) => {
    if (!row || row.couple_id !== S.coupleId) return;
    if (row.updated_by === uid()) return;
    handleRow(row);
  });
}

// ================================================================ Draw Together (draw_strokes)
// The six Android brush colours, stored in draw_strokes.color as the
// signed 32-bit ARGB int Android's Color.rgb produces.
const argbOf = (r, g, b) => ((255 << 24) | (r << 16) | (g << 8) | b) | 0;
const BRUSHES = [
  { css: '#8E44AD', argb: argbOf(142, 68, 173) }, { css: '#D63031', argb: argbOf(214, 48, 49) },
  { css: '#2774C8', argb: argbOf(39, 116, 200) }, { css: '#27AE60', argb: argbOf(39, 174, 96) },
  { css: '#E67E22', argb: argbOf(230, 126, 34) }, { css: '#1E1E1E', argb: argbOf(30, 30, 30) },
];
function argbToCss(c) {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
function drawScreen() {
  if (!S.partner) return needLink('Draw Together');
  let brush = BRUSHES[0];
  let drawing = false; let points = []; let lastId = 0; let strokes = [];
  appEl().innerHTML = topbar('Draw Together', { back: true, subtitle: 'One shared canvas' }) +
    '<div class="screen"><canvas class="draw" id="draw-canvas" width="800" height="800"></canvas>' +
    '<div class="chips" id="draw-colors">' + BRUSHES.map((b, i) => '<button class="chip' + (i === 0 ? ' selected' : '') + '" data-brush="' + i + '" style="color:' + b.css + '">●</button>').join('') + '</div>' +
    '<button class="btn btn-ghost" id="draw-clear">Clear the board for both of us</button><div class="grow"></div></div>';
  wireBack({ name: 'together' });
  const canvas = document.getElementById('draw-canvas');
  const ctx = canvas.getContext('2d');
  const render = () => {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvasBg') || '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) {
      if (!s.points || !s.points.length) continue;
      ctx.strokeStyle = argbToCss(s.color);
      ctx.lineWidth = Math.max(2, (s.width || 5) * (canvas.width / 400));
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = p[0] * canvas.width, y = p[1] * canvas.height;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  };
  const load = async () => {
    const rows = await api.get('/draw_strokes?couple_id=eq.' + S.coupleId + '&order=id.desc&limit=200&select=id,points,color,width');
    const ordered = rows.slice().reverse();
    const out = [];
    for (const r of ordered) {
      if (r.id <= lastId && strokes.length) { /* still rebuild from the window */ }
      if (!r.points || r.points.length === 0) out.length = 0; // a clear row wipes everything before it
      else out.push(r);
    }
    strokes = out;
    if (ordered.length) lastId = ordered[ordered.length - 1].id;
    if (!drawing) render();
  };
  const pos = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return [Math.round(((ev.clientX - rect.left) / rect.width) * 1000) / 1000, Math.round(((ev.clientY - rect.top) / rect.height) * 1000) / 1000];
  };
  canvas.addEventListener('pointerdown', (ev) => { drawing = true; points = [pos(ev)]; canvas.setPointerCapture(ev.pointerId); });
  canvas.addEventListener('pointermove', (ev) => { if (!drawing) return; points.push(pos(ev)); strokes = strokes.concat([{ points: points.slice(), color: brush.argb, width: 5 }]); render(); strokes = strokes.slice(0, -1); });
  canvas.addEventListener('pointerup', async () => {
    if (!drawing) return;
    drawing = false;
    if (points.length < 2) { points = []; return; }
    const body = { couple_id: S.coupleId, author: uid(), points, color: brush.argb, width: 5 };
    points = [];
    try { await api.post('/draw_strokes', body); load(); } catch (e) { toast(e.message); }
  });
  document.querySelectorAll('#draw-colors [data-brush]').forEach((b) => { b.onclick = () => { brush = BRUSHES[Number(b.dataset.brush)]; document.querySelectorAll('#draw-colors .chip').forEach((x) => x.classList.remove('selected')); b.classList.add('selected'); }; });
  document.getElementById('draw-clear').onclick = async () => {
    if (!await confirmDlg('Clear the drawing board?', 'Both of you will see a blank canvas. This cannot be undone.', 'Clear')) return;
    try { await api.post('/draw_strokes', { couple_id: S.coupleId, author: uid(), points: [], color: 0, width: 0 }); strokes = []; render(); load(); }
    catch (e) { toast(e.message); }
  };
  load().catch((e) => toast(e.message));
  every(3000, load);
}

// ================================================================ Read Together (books + reading_progress)
function splitPages(text) {
  const pages = [];
  if (!text) return [''];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + 1200);
    if (end < text.length) {
      const window = text.substring(at + 600, end);
      const rel = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
      if (rel >= 0) end = at + 600 + rel;
    }
    pages.push(text.substring(at, end).trim());
    at = end;
  }
  return pages.length ? pages : [''];
}
function readScreen() {
  if (!S.partner) return needLink('Read Together');
  let currentBook = null; let pages = []; let page = 0;
  appEl().innerHTML = topbar('Read Together', { back: true }) +
    '<div class="screen"><p class="lede small">Import a plain-text (.txt) book. It is encrypted on this device before upload, and your pages stay in step: you can see which page your partner is on.</p>' +
    '<div id="read-list"><p class="muted">Loading your books…</p></div>' +
    '<div id="read-reader"></div>' +
    '<div class="card"><h3>Import a book</h3><label class="field" for="book-title">Book title</label><input type="text" id="book-title" placeholder="Untitled book">' +
    '<label class="field" for="book-file">.txt file</label><input type="file" id="book-file" accept=".txt,text/plain">' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="book-add">Import this book</button><p class="tiny muted" id="book-status" style="margin:8px 0 0"></p></div><div class="grow"></div></div>';
  wireBack({ name: 'together' });
  const loadList = async () => {
    const rows = await api.get('/books?couple_id=eq.' + S.coupleId + '&order=created_at.desc&select=id,title,storage_path,added_by');
    const box = document.getElementById('read-list');
    if (!box) return;
    box.innerHTML = rows.length ? rows.map((b) =>
      '<div class="list-row"><span style="font-size:20px">📖</span><div class="grow"><div>' + esc(b.title || 'Untitled book') + '</div><div class="tiny muted">' + (b.added_by === uid() ? 'Added by you' : 'Added by ' + esc(S.partner.display_name)) + '</div></div><button class="btn btn-soft" style="width:auto" data-book="' + b.id + '">Read</button></div>').join('')
      : '<p class="muted">No books yet. Import the first one below.</p>';
    box.querySelectorAll('[data-book]').forEach((btn) => { btn.onclick = () => openBook(rows.find((r) => r.id === btn.dataset.book)); });
  };
  const openBook = async (book) => {
    const reader = document.getElementById('read-reader');
    reader.innerHTML = '<div class="card"><p class="muted">Downloading and decrypting the book…</p></div>';
    try {
      const blob = await api.storageDownload(book.storage_path);
      const plain = await openFileBytes(E.fileIdFromPath(book.storage_path), blob);
      if (!plain) throw new Error('This book could not be decrypted on this device.');
      currentBook = book;
      pages = splitPages(new TextDecoder().decode(plain));
      page = 0;
      const prog = await api.get('/reading_progress?book_id=eq.' + book.id + '&select=user_id,page');
      const mine = prog.find((r) => r.user_id === uid());
      if (mine && mine.page >= 1 && mine.page <= pages.length) page = mine.page - 1;
      renderPage(prog);
    } catch (e) { reader.innerHTML = '<div class="card"><p class="error-text">' + esc(e.message) + '</p></div>'; }
  };
  const renderPage = async (progRows) => {
    const reader = document.getElementById('read-reader');
    if (!reader || !currentBook) return;
    let prog = progRows;
    if (!prog) { try { prog = await api.get('/reading_progress?book_id=eq.' + currentBook.id + '&select=user_id,page'); } catch { prog = []; } }
    const partnerProg = (prog || []).find((r) => r.user_id !== uid());
    reader.innerHTML = '<div class="card"><h3>' + esc(currentBook.title || 'Untitled book') + '</h3>' +
      '<p class="tiny muted">Page ' + (page + 1) + ' of ' + pages.length + (partnerProg ? ' · Your partner is on page ' + partnerProg.page : '') + '</p>' +
      '<div class="book-page">' + esc(pages[page]) + '</div>' +
      '<div class="btn-row" style="margin-top:12px"><button class="btn btn-soft" id="rp-prev">← Previous</button><button class="btn btn-soft" id="rp-next">Next →</button></div></div>';
    document.getElementById('rp-prev').onclick = () => goTo(page - 1);
    document.getElementById('rp-next').onclick = () => goTo(page + 1);
  };
  const goTo = async (p) => {
    const clamped = Math.max(0, Math.min(pages.length - 1, p));
    page = clamped;
    renderPage();
    try { await api.post('/reading_progress', { book_id: currentBook.id, user_id: uid(), page: clamped + 1 }, 'resolution=merge-duplicates'); } catch { /* progress is best-effort */ }
  };
  document.getElementById('book-add').onclick = async () => {
    const file = document.getElementById('book-file').files[0];
    const statusEl = document.getElementById('book-status');
    if (!file) { toast('Please choose a .txt file.'); return; }
    if (!e2eeReady()) { toast(KEYS_NOT_READY); return; }
    try {
      const text = await file.text();
      if (!text.trim()) { statusEl.textContent = 'That file appears to be empty.'; return; }
      const title = document.getElementById('book-title').value.trim() || 'Untitled book';
      statusEl.textContent = 'Encrypting and uploading the book…';
      const fileId = E.uuid();
      const sealed = await sealFileBytes(fileId, new TextEncoder().encode(text));
      const path = S.coupleId + '/books/' + fileId + '.bin';
      await api.storageUpload(path, sealed);
      await api.post('/books', { couple_id: S.coupleId, added_by: uid(), title, storage_path: path });
      statusEl.textContent = 'Your book has been added for both of you.';
      loadList();
    } catch (e) { statusEl.textContent = 'That book file could not be read. ' + e.message; }
  };
  loadList().catch((e) => toast(e.message));
  every(6000, () => { if (currentBook) renderPage(); });
}

// ================================================================ Memories hub
function memoriesHub(param) {
  if (!S.partner) return needLink('Memories');
  if (param && ['album', 'journey', 'bucket', 'memoriesView', 'checkin', 'conflict', 'gifts'].includes(param)) return showScreen(param);
  appEl().innerHTML = topbar('Memories', { subtitle: 'The story of the two of you' }) +
    '<div class="screen"><div class="card"><div class="flex"><span style="font-size:26px">🔥</span><div><div style="font-weight:600" id="mem-streak">Your together streak</div><div class="tiny muted">Days in a row with a message or a check-in from either of you.</div></div></div></div>' +
    '<div class="hub">' +
    hubRow('📷', 'Photo Album', 'Photos that only the two of you can see.', 'album') +
    hubRow('🗺', 'Our Journey', 'The places that are part of your story.', 'journey') +
    hubRow('✨', 'Bucket List', 'Things you want to do together one day.', 'bucket') +
    hubRow('💌', 'Memories', 'Your first conversation, and this day in your story.', 'memoriesView') +
    hubRow('🌸', 'Daily Check-in', 'Tell each other how today really feels.', 'checkin') +
    hubRow('🕊', 'Conflict Resolution', 'Kind questions for the hard moments.', 'conflict') +
    hubRow('🎁', 'Digital Gifts', 'Send a rose, a hug or a love letter.', 'gifts') +
    '</div></div>';
  wireHub();
  (async () => {
    try {
      const days = new Set();
      const checkins = await api.get('/checkins?couple_id=eq.' + S.coupleId + '&select=day');
      checkins.forEach((c) => days.add(c.day));
      const msgs = await api.get('/messages?couple_id=eq.' + S.coupleId + '&select=created_at&order=id.desc&limit=1000');
      msgs.forEach((m) => days.add(todayIso(new Date(m.created_at))));
      let streak = 0; let cursor = todayIso();
      if (!days.has(cursor)) cursor = prevIsoDay(cursor);
      while (days.has(cursor)) { streak++; cursor = prevIsoDay(cursor); }
      const el = document.getElementById('mem-streak');
      if (el) el.textContent = streak > 0 ? 'Together streak: ' + streak + (streak === 1 ? ' day' : ' days') : 'Your together streak starts with a message or a check-in.';
    } catch { /* card keeps its label */ }
  })();
}

// ================================================================ Photo Album (album_items + sealed storage)
async function downscaleJpeg(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  return new Uint8Array(await blob.arrayBuffer());
}
function albumScreen() {
  if (!S.partner) return needLink('Photo Album');
  const urls = new Map();
  appEl().innerHTML = topbar('Photo Album', { back: true, subtitle: 'Photos that only the two of you can see' }) +
    '<div class="screen"><div id="album-box"><p class="muted">Loading your album…</p></div>' +
    '<div class="card"><h3>Add a photo</h3><label class="field" for="al-caption">Caption (optional, encrypted)</label><input type="text" id="al-caption" placeholder="A moment to keep">' +
    '<label class="field" for="al-file">Photo</label><input type="file" id="al-file" accept="image/*">' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="al-add">Add to our album</button><p class="tiny muted" id="al-status" style="margin:8px 0 0"></p></div><div class="grow"></div></div>';
  wireBack({ name: 'memories' });
  const load = async () => {
    const rows = await api.get('/album_items?couple_id=eq.' + S.coupleId + '&order=id.desc&select=id,storage_path,caption,added_by,created_at');
    const box = document.getElementById('album-box');
    if (!box) return;
    if (!rows.length) { box.innerHTML = '<p class="muted">No photos yet. Add the first one below — it is encrypted before it leaves this device.</p>'; return; }
    box.innerHTML = '<div class="album-grid">' + rows.map((r, i) => '<button data-al="' + i + '" aria-label="Album photo">Loading…</button>').join('') + '</div>';
    rows.forEach(async (r, i) => {
      const btn = box.querySelector('[data-al="' + i + '"]');
      if (!btn) return;
      try {
        let url = urls.get(r.storage_path);
        if (!url) {
          const blob = await api.storageDownload(r.storage_path);
          const plain = await openFileBytes(E.fileIdFromPath(r.storage_path), blob);
          url = URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
          urls.set(r.storage_path, url);
        }
        btn.innerHTML = '<img alt="Album photo" src="' + url + '">';
        btn.onclick = async () => {
          const caption = r.caption ? await openText(r.caption) : '';
          const sh = sheet('<img class="full" alt="Album photo" src="' + url + '">' +
            (caption ? '<p>' + esc(caption) + '</p>' : '') +
            '<p class="tiny muted">Added by ' + (r.added_by === uid() ? 'you' : esc(S.partner.display_name)) + ' · ' + new Date(r.created_at).toLocaleDateString('en-US') + '</p>' +
            '<button class="btn btn-ghost" id="al-x">Close</button>');
          sh.querySelector('#al-x').onclick = closeSheet;
        };
      } catch { btn.textContent = '🔒'; }
    });
  };
  document.getElementById('al-add').onclick = async () => {
    const file = document.getElementById('al-file').files[0];
    const statusEl = document.getElementById('al-status');
    if (!file) { toast('Please choose a photo.'); return; }
    if (!e2eeReady()) { toast(KEYS_NOT_READY); return; }
    try {
      statusEl.textContent = 'Encrypting and uploading…';
      const jpeg = await downscaleJpeg(file);
      const fileId = E.uuid();
      const sealed = await sealFileBytes(fileId, jpeg);
      const path = S.coupleId + '/album/' + fileId + '.bin';
      await api.storageUpload(path, sealed);
      const captionText = document.getElementById('al-caption').value.trim();
      const caption = captionText ? await sealText(captionText) : '';
      await api.post('/album_items', { couple_id: S.coupleId, added_by: uid(), storage_path: path, caption: caption || '' });
      statusEl.textContent = 'Added to your album.';
      document.getElementById('al-caption').value = '';
      load();
    } catch (e) { statusEl.textContent = 'Could not add: ' + e.message; }
  };
  load().catch((e) => toast(e.message));
  every(8000, load);
}

// ================================================================ Our Journey (journey_places)
function journeyScreen() {
  if (!S.partner) return needLink('Our Journey');
  appEl().innerHTML = topbar('Our Journey', { back: true, subtitle: 'The places that are part of your story' }) +
    '<div class="screen"><div id="j-map"></div><div id="j-list"><p class="muted">Loading your journey…</p></div>' +
    '<div class="card"><h3>Add a place</h3><label class="field" for="j-name">Place name</label><input type="text" id="j-name" placeholder="The lake where we first talked">' +
    '<label class="field" for="j-date">Visited on</label><input type="date" id="j-date">' +
    '<label class="field" for="j-note">Note (optional, encrypted)</label><textarea id="j-note" placeholder="What happened here…"></textarea>' +
    '<div class="btn-row"><span class="grow"><label class="field" for="j-lat">Latitude (optional)</label><input type="text" id="j-lat" inputmode="decimal"></span><span class="grow"><label class="field" for="j-lng">Longitude (optional)</label><input type="text" id="j-lng" inputmode="decimal"></span></div>' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="j-add">Add this place</button>' +
    '<p class="tiny muted" style="margin:8px 0 0">Places are only ever the ones you type in here — this app never tracks your location.</p></div><div class="grow"></div></div>';
  wireBack({ name: 'memories' });
  const load = async () => {
    const rows = await api.get('/journey_places?couple_id=eq.' + S.coupleId + '&order=id.desc&select=id,name,note,visited_on,lat,lng,added_by');
    const box = document.getElementById('j-list');
    if (!box) return;
    const mapBox = document.getElementById('j-map');
    const withCoords = rows.find((r) => r.lat !== null && r.lng !== null);
    if (mapBox) {
      mapBox.innerHTML = withCoords
        ? '<iframe class="map" title="Map of your latest place" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=' + (withCoords.lng - 0.02) + '%2C' + (withCoords.lat - 0.02) + '%2C' + (withCoords.lng + 0.02) + '%2C' + (withCoords.lat + 0.02) + '&layer=mapnik&marker=' + withCoords.lat + '%2C' + withCoords.lng + '"></iframe>'
        : '';
    }
    if (!rows.length) { box.innerHTML = '<p class="muted">No places yet. Add the first one below.</p>'; return; }
    box.innerHTML = '';
    for (const r of rows) {
      const note = r.note ? await openText(r.note) : '';
      const div = document.createElement('div');
      div.className = 'list-row';
      div.innerHTML = '<span style="font-size:20px">📍</span><div class="grow"><div>' + esc(r.name) + '</div>' +
        '<div class="tiny muted">' + (r.visited_on ? esc(r.visited_on) + ' · ' : '') + (r.added_by === uid() ? 'Added by you' : 'Added by ' + esc(S.partner.display_name)) + '</div>' +
        (note ? '<div class="small">' + esc(note) + '</div>' : '') + '</div>';
      box.appendChild(div);
    }
  };
  document.getElementById('j-add').onclick = async () => {
    const name = document.getElementById('j-name').value.trim();
    if (!name) { toast('Please name the place.'); return; }
    const noteText = document.getElementById('j-note').value.trim();
    const note = noteText ? await sealText(noteText) : '';
    if (noteText && !note) { toast(KEYS_NOT_READY); return; }
    const latV = document.getElementById('j-lat').value.trim();
    const lngV = document.getElementById('j-lng').value.trim();
    try {
      await api.post('/journey_places', {
        couple_id: S.coupleId, added_by: uid(), name, note: note || '',
        visited_on: document.getElementById('j-date').value || null,
        lat: latV === '' ? null : parseFloat(latV), lng: lngV === '' ? null : parseFloat(lngV),
      });
      toast('Place added to your journey.');
      load();
    } catch (e) { toast(e.message); }
  };
  load().catch((e) => toast(e.message));
  every(8000, load);
}

// ================================================================ Bucket List (bucket_items, sealed titles)
function bucketScreen() {
  if (!S.partner) return needLink('Bucket List');
  appEl().innerHTML = topbar('Bucket List', { back: true, subtitle: 'Things you want to do together one day' }) +
    '<div class="screen"><div id="b-list"><p class="muted">Loading your bucket list\u2026</p></div>' +
    '<div class="card"><label class="field" for="b-input">Something to dream about</label><input type="text" id="b-input" placeholder="Watch the sunrise at the Taj Mahal">' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="b-add">Add to our list</button></div><div class="grow"></div></div>';
  wireBack({ name: 'memories' });
  // Titles are decrypted once into this cache; taps update the screen
  // instantly and the save travels in the background (no full reload
  // wait for the strikethrough or the delete to show).
  let cache = null;
  const render = () => {
    const box = document.getElementById('b-list');
    if (!box || !cache) return;
    if (!cache.length) { box.innerHTML = '<p class="muted">Nothing here yet. Dream the first one below.</p>'; return; }
    box.innerHTML = '';
    for (const r of cache) {
      const div = document.createElement('div');
      div.className = 'list-row';
      div.innerHTML = '<span style="font-size:20px">' + (r.done ? '\u2705' : '\u2728') + '</span><div class="grow"><div' + (r.done ? ' style="text-decoration:line-through"' : '') + '>' + esc(r.title) + '</div>' +
        '<div class="tiny muted">' + (r.done && r.done_at ? 'Done ' + new Date(r.done_at).toLocaleDateString('en-US') : (r.added_by === uid() ? 'Added by you' : 'Added by ' + esc(S.partner.display_name))) + '</div></div>' +
        '<button class="btn btn-soft" style="width:auto" data-toggle="' + r.id + '">' + (r.done ? 'Undo' : 'Done') + '</button>' +
        '<button class="btn btn-ghost" style="width:auto" data-del="' + r.id + '">Delete</button>';
      box.appendChild(div);
    }
    box.querySelectorAll('[data-toggle]').forEach((b) => { b.onclick = () => {
      const r = cache.find((x) => String(x.id) === String(b.dataset.toggle));
      if (!r) return;
      r.done = !r.done;
      r.done_at = r.done ? new Date().toISOString() : null;
      render();
      api.patch('/bucket_items?id=eq.' + r.id, { done: r.done, done_at: r.done_at })
        .catch((e) => { toast(e.message); load(); });
    }; });
    box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => {
      if (!await confirmDlg('Remove this dream?', 'It will be removed from your shared bucket list for both of you.', 'Remove')) return;
      cache = cache.filter((x) => String(x.id) !== String(b.dataset.del));
      render();
      api.del('/bucket_items?id=eq.' + b.dataset.del)
        .catch((e) => { toast(e.message); load(); });
    }; });
  };
  const load = async () => {
    const rows = await api.get('/bucket_items?couple_id=eq.' + S.coupleId + '&order=id.asc&select=id,title,done,done_at,added_by');
    const fresh = [];
    for (const r of rows) {
      fresh.push({ id: r.id, title: (await openText(r.title)) || '\U0001F512 Could not open this item on this device.', done: r.done, done_at: r.done_at, added_by: r.added_by });
    }
    cache = fresh;
    render();
  };
  document.getElementById('b-add').onclick = async () => {
    const text = document.getElementById('b-input').value.trim();
    if (!text) { toast('Please write the dream first.'); return; }
    const sealed = await sealText(text);
    if (!sealed) { toast(KEYS_NOT_READY); return; }
    const btn = document.getElementById('b-add');
    btn.disabled = true; btn.textContent = 'Adding\u2026';
    try {
      await api.post('/bucket_items', { couple_id: S.coupleId, added_by: uid(), title: sealed });
      document.getElementById('b-input').value = '';
      await load();
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = 'Add to our list';
  };
  load().catch((e) => toast(e.message));
  every(8000, load);
}

// ================================================================ Memories (first conversation + on this day)
function memoriesViewScreen() {
  if (!S.partner) return needLink('Memories');
  appEl().innerHTML = topbar('Memories', { back: true, subtitle: 'From your own shared history' }) +
    '<div class="screen"><h2 class="section">Your first conversation</h2><div class="card" id="mv-first"><p class="muted">Loading…</p></div>' +
    '<h2 class="section">On this day</h2><div class="card" id="mv-day"><p class="muted">Loading…</p></div><div class="grow"></div></div>';
  wireBack({ name: 'memories' });
  const decryptRow = async (r) => {
    if (r.type === 'voice') return '🎙 Voice message';
    try {
      const plain = await openChatWireRetry(r.ciphertext, r.nonce, r.type);
      if (typeof plain === 'string' && plain.startsWith('USPHOTO1:')) return '📷 A photo you shared';
      if (typeof plain === 'string' && plain.startsWith('USSURPRISE1:')) return '🎁 ' + plain.substring('USSURPRISE1:'.length);
      return String(plain);
    } catch { return '🔒 Could not open this message on this device.'; }
  };
  const renderRows = async (rows) => rows.length ? (await Promise.all(rows.map(async (r) =>
    '<p style="margin:6px 0"><span class="tiny muted">' + new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + (r.sender_id === uid() ? 'You' : esc(S.partner.display_name)) + '</span><br>' + esc(await decryptRow(r)) + '</p>'))).join('') : '<p class="muted">Nothing here yet.</p>';
  (async () => {
    try {
      const first = await api.get('/messages?couple_id=eq.' + S.coupleId + '&thread=eq.main&order=id.asc&limit=10&select=id,sender_id,ciphertext,nonce,type,created_at');
      document.getElementById('mv-first').innerHTML = await renderRows(first);
      const recent = await api.get('/messages?couple_id=eq.' + S.coupleId + '&thread=eq.main&order=id.desc&limit=500&select=id,sender_id,ciphertext,nonce,type,created_at');
      const now = new Date();
      const onDay = recent.filter((r) => { const d = new Date(r.created_at); return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() < now.getFullYear(); });
      document.getElementById('mv-day').innerHTML = onDay.length ? await renderRows(onDay.slice(0, 20)) : '<p class="muted">No messages from this day in earlier years yet — your story is still being written.</p>';
    } catch (e) { toast(e.message); }
  })();
}

// ================================================================ Daily Check-in (checkins)
function checkinScreen() {
  if (!S.partner) return needLink('Daily Check-in');
  let mood = '';
  appEl().innerHTML = topbar('Daily Check-in', { back: true, subtitle: 'Tell each other how today really feels' }) +
    '<div class="screen"><div class="card"><h3>Today’s check-ins</h3><div id="ci-both"><p class="muted">Loading today’s check-ins…</p></div></div>' +
    '<div class="card"><h3>How do you feel today?</h3><div class="chips" id="ci-moods">' +
    BUILTIN.moods.map((m) => '<button class="chip" data-mood="' + m + '">' + m + '</button>').join('') + '</div>' +
    '<label class="field" for="ci-note">A note for your partner (optional, encrypted)</label><textarea id="ci-note" placeholder="A few honest words…"></textarea>' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="ci-save">Save my check-in</button></div><div class="grow"></div></div>';
  wireBack({ name: 'memories' });
  document.querySelectorAll('#ci-moods [data-mood]').forEach((b) => { b.onclick = () => { mood = b.dataset.mood; document.querySelectorAll('#ci-moods .chip').forEach((x) => x.classList.remove('selected')); b.classList.add('selected'); }; });
  const load = async () => {
    const rows = await api.get('/checkins?couple_id=eq.' + S.coupleId + '&day=eq.' + todayIso() + '&select=user_id,mood,note');
    const box = document.getElementById('ci-both');
    if (!box) return;
    const mine = rows.find((r) => r.user_id === uid());
    const theirs = rows.find((r) => r.user_id !== uid());
    const line = async (label, r) => {
      if (!r) return '<p style="margin:6px 0"><strong>' + esc(label) + ':</strong> Not yet</p>';
      const note = r.note ? await openText(r.note) : '';
      return '<p style="margin:6px 0"><strong>' + esc(label) + ':</strong> ' + esc(r.mood) + (note ? '<br><span class="small muted">“' + esc(note) + '”</span>' : '') + '</p>';
    };
    box.innerHTML = await line('You', mine) + await line(S.partner.display_name, theirs);
    if (mine) {
      mood = mine.mood;
      document.querySelectorAll('#ci-moods .chip').forEach((x) => x.classList.toggle('selected', x.dataset.mood === mood));
    }
  };
  document.getElementById('ci-save').onclick = async () => {
    if (!mood) { toast('Please pick how you feel first.'); return; }
    const noteText = document.getElementById('ci-note').value.trim();
    const note = noteText ? await sealText(noteText) : '';
    if (noteText && !note) { toast(KEYS_NOT_READY); return; }
    try {
      await api.post('/checkins', { couple_id: S.coupleId, user_id: uid(), day: todayIso(), mood, note: note || '' }, 'resolution=merge-duplicates');
      cacheMyCheckin(mood); // live obs (c): Home's card reflects this save immediately
      toast('Your check-in has been saved.');
      load();
    } catch (e) { toast(e.message); }
  };
  load().catch((e) => toast(e.message));
  every(6000, load);
}

// ================================================================ Conflict Resolution (conflict_answers)
function conflictScreen() {
  if (!S.partner) return needLink('Conflict Resolution');
  const questions = rcList('conflict_questions', BUILTIN.conflictQuestions);
  let index = Math.min(parseInt(localStorage.getItem('uaw.conflictIndex:' + S.coupleId) || '0', 10) || 0, questions.length - 1);
  appEl().innerHTML = topbar('Conflict Resolution', { back: true, subtitle: 'Kind questions for the hard moments' }) +
    '<div class="screen"><div class="card"><p class="tiny muted" id="cf-count"></p><p id="cf-q" style="font-size:17px;line-height:1.35"></p>' +
    '<div class="btn-row"><button class="btn btn-soft" id="cf-prev">← Previous</button><button class="btn btn-soft" id="cf-next">Next →</button></div></div>' +
    '<div class="card"><h3>Your answers</h3><div id="cf-answers"><p class="muted">Loading…</p></div>' +
    '<label class="field" for="cf-input">Your answer (encrypted)</label><textarea id="cf-input" placeholder="Answer honestly and kindly…"></textarea>' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="cf-save">Save my answer</button>' +
    '<p class="tiny muted" style="margin:8px 0 0">Answers are revealed only once both of you have answered — and they stay encrypted on the server either way.</p></div><div class="grow"></div></div>';
  wireBack({ name: 'memories' });
  const renderQ = () => {
    document.getElementById('cf-count').textContent = 'Question ' + (index + 1) + ' of ' + questions.length;
    document.getElementById('cf-q').textContent = questions[index];
    localStorage.setItem('uaw.conflictIndex:' + S.coupleId, String(index));
  };
  const load = async () => {
    renderQ();
    // Bug #4: duplicates can exist (no unique constraint), so read
    // newest-first and take the LATEST row per user.
    const rows = await api.get('/conflict_answers?couple_id=eq.' + S.coupleId + '&question_id=eq.' + index + '&order=id.desc&select=id,user_id,answer');
    const box = document.getElementById('cf-answers');
    if (!box) return;
    const { mine, theirs } = latestRowPerUser(rows, uid());
    if (mine && theirs) {
      const myText = await openText(mine.answer);
      const theirText = await openText(theirs.answer);
      box.innerHTML = '<p style="margin:6px 0"><strong>You:</strong> ' + esc(myText || '🔒 Could not open on this device.') + '</p>' +
        '<p style="margin:6px 0"><strong>' + esc(S.partner.display_name) + ':</strong> ' + esc(theirText || '🔒 Could not open on this device.') + '</p>';
    } else {
      box.innerHTML = '<p class="muted" style="margin:4px 0">You: ' + (mine ? 'answered ✓' : 'not yet') + ' · ' + esc(S.partner.display_name) + ': ' + (theirs ? 'answered ✓' : 'not yet') + '</p>' +
        '<p class="tiny muted">Both answers appear here once both of you have answered.</p>';
    }
  };
  document.getElementById('cf-prev').onclick = () => { index = (index + questions.length - 1) % questions.length; document.getElementById('cf-input').value = ''; load(); };
  document.getElementById('cf-next').onclick = () => { index = (index + 1) % questions.length; document.getElementById('cf-input').value = ''; load(); };
  document.getElementById('cf-save').onclick = async () => {
    const text = document.getElementById('cf-input').value.trim();
    if (!text) { toast('Please write your answer first.'); return; }
    const sealed = await sealText(text);
    if (!sealed) { toast(KEYS_NOT_READY); return; }
    try {
      // Bug #4: conflict_answers has NO unique constraint, so the old
      // merge-duplicates upsert could never conflict and every save
      // inserted a duplicate. Delete my previous answer(s) for this
      // question first, then insert the new one.
      await api.del('/conflict_answers?couple_id=eq.' + S.coupleId + '&question_id=eq.' + index + '&user_id=eq.' + uid());
      await api.post('/conflict_answers', { couple_id: S.coupleId, question_id: String(index), user_id: uid(), answer: sealed });
      document.getElementById('cf-input').value = '';
      toast('Your answer has been saved.');
      load();
    } catch (e) { toast(e.message); }
  };
  load().catch((e) => toast(e.message));
  every(6000, load);
}

// ================================================================ Digital Gifts (gifts)
const GIFT_EMOJI = { Rose: '🌹', Chocolate: '🍫', Hug: '🤗', Kiss: '💋', 'Love Letter': '💌', Star: '⭐' };
function giftsScreen() {
  if (!S.partner) return needLink('Digital Gifts');
  let kind = '';
  const kinds = rcList('gift_kinds', BUILTIN.giftKinds);
  appEl().innerHTML = topbar('Digital Gifts', { back: true, subtitle: 'Little surprises, sealed until opened' }) +
    '<div class="screen"><div id="g-list"><p class="muted">Loading your gifts…</p></div>' +
    '<div class="card"><h3>Send a gift</h3><div class="chips" id="g-kinds">' +
    kinds.map((k) => '<button class="chip" data-kind="' + esc(k) + '">' + (GIFT_EMOJI[k] || '🎁') + ' ' + esc(k) + '</button>').join('') + '</div>' +
    '<label class="field" for="g-note">A note inside (optional, encrypted)</label><textarea id="g-note" placeholder="For you, because…"></textarea>' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="g-send">Send this gift</button></div><div class="grow"></div></div>';
  wireBack({ name: 'memories' });
  document.querySelectorAll('#g-kinds [data-kind]').forEach((b) => { b.onclick = () => { kind = b.dataset.kind; document.querySelectorAll('#g-kinds .chip').forEach((x) => x.classList.remove('selected')); b.classList.add('selected'); }; });
  const load = async () => {
    const rows = await api.get('/gifts?couple_id=eq.' + S.coupleId + '&order=id.desc&select=id,sender_id,kind,note,opened_at,created_at');
    const box = document.getElementById('g-list');
    if (!box) return;
    if (!rows.length) { box.innerHTML = '<p class="muted">No gifts yet. Send the first one below.</p>'; return; }
    box.innerHTML = '';
    for (const r of rows) {
      const mine = r.sender_id === uid();
      const div = document.createElement('div');
      div.className = 'card';
      if (!mine && !r.opened_at) {
        div.innerHTML = '<div class="gift-sealed">🎁</div><p class="center" style="margin:6px 0">A gift from ' + esc(S.partner.display_name) + ' — sealed until you open it.</p><button class="btn btn-primary" data-open-gift="' + r.id + '">Open my gift</button>';
      } else {
        const note = r.note ? await openText(r.note) : '';
        div.innerHTML = '<div class="flex"><span style="font-size:30px">' + (GIFT_EMOJI[r.kind] || '🎁') + '</span><div class="grow"><div><strong>' + esc(r.kind) + '</strong></div>' +
          '<div class="tiny muted">' + (mine ? 'Sent by you' : 'From ' + esc(S.partner.display_name)) + ' · ' + new Date(r.created_at).toLocaleDateString('en-US') + (r.opened_at ? ' · Opened' : ' · Not opened yet') + '</div>' +
          (note ? '<div class="small" style="margin-top:4px">“' + esc(note) + '”</div>' : '') + '</div></div>';
      }
      box.appendChild(div);
    }
    box.querySelectorAll('[data-open-gift]').forEach((b) => { b.onclick = async () => {
      await api.patch('/gifts?id=eq.' + b.dataset.openGift, { opened_at: new Date().toISOString() }).catch((e) => toast(e.message));
      load();
    }; });
  };
  document.getElementById('g-send').onclick = async () => {
    if (!kind) { toast('Please pick a gift first.'); return; }
    const noteText = document.getElementById('g-note').value.trim();
    const note = noteText ? await sealText(noteText) : '';
    if (noteText && !note) { toast(KEYS_NOT_READY); return; }
    try {
      await api.post('/gifts', { couple_id: S.coupleId, sender_id: uid(), kind, note: note || '' });
      document.getElementById('g-note').value = '';
      toast('Your gift is on its way. 🎁');
      load();
    } catch (e) { toast(e.message); }
  };
  load().catch((e) => toast(e.message));
  every(6000, load);
}

// ================================================================ Couple Room (room_state + pet summary)
function roomScreen() {
  if (!S.partner) return needLink('Our Room');
  appEl().innerHTML = topbar('Our Room', { back: true, subtitle: 'Your shared space' }) +
    '<div class="screen"><div class="card"><div class="flex">' +
    '<div class="partner-ava">' + esc(initials(S.me.display_name)) + '</div><div class="grow"><strong>' + esc(S.me.display_name) + '</strong><div class="tiny muted">' + esc(S.me.role) + '</div></div>' +
    '<div style="font-size:22px">💞</div>' +
    '<div class="partner-ava">' + esc(initials(S.partner.display_name)) + '</div><div class="grow"><strong>' + esc(S.partner.display_name) + '</strong><div class="tiny muted">' + esc(S.partner.role) + '</div></div></div>' +
    '<p class="center" style="margin:14px 0 0"><span class="hero-days" style="font-size:34px">' + daysTogether() + '</span> <span class="muted">days together</span></p></div>' +
    '<div class="card"><h3>Our status line</h3><p id="room-status" class="muted">Loading…</p>' +
    '<label class="field" for="room-input">Say it together (encrypted)</label><input type="text" id="room-input" placeholder="Counting down to December…">' +
    '<div style="height:10px"></div><button class="btn btn-primary" id="room-save">Save our status</button></div>' +
    '<div class="card" id="room-pet"><h3>🐾 Your pet</h3><p class="muted">Loading…</p></div>' +
    '<div class="hub">' +
    hubRow('🎮', 'Games', 'Tic Tac Toe, Ludo and Spin the Bottle.', 'games') +
    hubRow('🐾', 'Visit your pet', 'Feed, play and rest together.', 'pet') +
    hubRow('🌸', 'Daily check-in', 'Tell each other how today really feels.', 'checkin') +
    '</div></div>';
  wireBack({ name: 'home' });
  wireHub();
  const load = async () => {
    try {
      const rows = await api.get('/room_state?couple_id=eq.' + S.coupleId + '&select=status_text,updated_by');
      const el = document.getElementById('room-status');
      if (el) {
        if (rows.length && rows[0].status_text) {
          const text = await openText(rows[0].status_text);
          el.textContent = text ? '“' + text + '”' : '🔒 Could not open the status on this device.';
          el.classList.remove('muted');
        } else el.textContent = 'No status line yet — write your first one below.';
      }
      const pets = await api.get('/pet_state?couple_id=eq.' + S.coupleId + '&select=name,hunger,happiness,energy,updated_at');
      const petBox = document.getElementById('room-pet');
      if (petBox) {
        if (pets.length) {
          const pet = pets[0];
          const [h, hp, e] = Pet.decayed(pet.hunger, pet.happiness, pet.energy, Date.now() - new Date(pet.updated_at).getTime());
          const mood = Pet.mood(h, hp, e);
          petBox.innerHTML = '<h3>' + (mood === 2 ? '😺' : mood === 1 ? '🐱' : '😿') + ' ' + esc(pet.name) + '</h3><p class="muted small" style="margin:0">Fullness ' + h + ' · Happiness ' + hp + ' · Energy ' + e + '</p>';
        } else petBox.innerHTML = '<h3>🐾 Your pet</h3><p class="muted small" style="margin:0">Your pet appears here once you visit the pet screen together.</p>';
      }
    } catch { /* room still renders */ }
  };
  document.getElementById('room-save').onclick = async () => {
    const value = document.getElementById('room-input').value.trim();
    if (!value) { toast('Please write a status line first.'); return; }
    const sealed = await sealText(value);
    if (!sealed) { toast(KEYS_NOT_READY); return; }
    try {
      await api.post('/room_state', { couple_id: S.coupleId, status_text: sealed, updated_by: uid() }, 'resolution=merge-duplicates');
      toast('Your status line is saved.');
      load();
    } catch (e) { toast(e.message); }
  };
  load();
  every(6000, load);
}

// ================================================================ registration
export function initFeatures() {
  registerScreen('games', gamesHub);
  registerScreen('ttt', tttScreen);
  registerScreen('ludo', ludoScreen);
  registerScreen('spin', spinScreen);
  registerScreen('pet', petScreen);
  registerScreen('together', togetherHub);
  registerScreen('playlist', playlistScreen);
  registerScreen('listen', () => playbackScreen('music'));
  registerScreen('watch', () => playbackScreen('video'));
  registerScreen('draw', drawScreen);
  registerScreen('read', readScreen);
  registerScreen('memories', memoriesHub);
  registerScreen('album', albumScreen);
  registerScreen('journey', journeyScreen);
  registerScreen('bucket', bucketScreen);
  registerScreen('memoriesView', memoriesViewScreen);
  registerScreen('checkin', checkinScreen);
  registerScreen('conflict', conflictScreen);
  registerScreen('gifts', giftsScreen);
  registerScreen('room', roomScreen);
}
