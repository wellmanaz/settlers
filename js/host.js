// TV host: owns the game state, draws the board, and talks to the phones.
import {
  createGame, applyAction, publicView, victoryPoints, countPieces, longestConduit,
  RESOURCES, RESOURCE_INFO, PLAYER_COLORS, PLAYER_COLOR_NAMES, COSTS, ITEM_NAMES, WIN_POINTS, LIMITS,
} from './engine.js';
import { renderBoard, esc } from './render.js';
import { iconSvg } from './icons.js';
import { createHost, makeRoomCode, netMode } from './net.js';

const SAVE_KEY = 'hexfront:host';
const root = document.getElementById('app');

const app = {
  mode: netMode(),
  room: null,
  net: null,
  seats: [], // { clientId, name, color, conn }
  game: null,
  previews: {}, // pid -> { kind, id, item }
  status: { text: 'Starting…', ok: false },
};

// ---------- persistence ----------

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      room: app.room,
      mode: app.mode,
      seats: app.seats.map(({ clientId, name, color }) => ({ clientId, name, color })),
      game: app.game,
      savedAt: Date.now(),
    }));
  } catch { /* storage full or blocked: the game still runs */ }
}

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (s && s.room && s.mode === app.mode) return s;
  } catch { /* ignore */ }
  return null;
}

// ---------- networking ----------

function openRoom(room) {
  app.room = room;
  app.net = createHost(room, app.mode, {
    onReady: () => render(),
    onMessage,
    onLeave,
    onStatus: (text, ok) => { app.status = { text, ok }; renderStatus(); },
  });
  render();
}

function send(seat, msg) {
  if (seat.conn) app.net.send(seat.conn, msg);
}

function broadcast() {
  app.seats.forEach((seat, i) => {
    if (!seat.conn) return;
    if (app.game) {
      send(seat, { t: 'state', view: publicView(app.game, i), connected: app.seats.map((s) => !!s.conn) });
    } else {
      send(seat, {
        t: 'lobby',
        room: app.room,
        you: i,
        players: app.seats.map((s) => ({ name: s.name, color: s.color, connected: !!s.conn })),
      });
    }
  });
}

const seatOfConn = (conn) => app.seats.findIndex((s) => s.conn === conn);
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);

function onMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  // A phone we do not know (for example after the TV page reloaded) is asked to join again.
  if (msg.t !== 'join' && seatOfConn(conn) < 0) {
    app.net.send(conn, { t: 'who' });
    return;
  }
  switch (msg.t) {
    case 'join': return handleJoin(conn, msg);
    case 'start': {
      if (app.game) return;
      if (app.seats.length < 2) return app.net.send(conn, { t: 'error', error: 'Need at least 2 players' });
      startGame();
      return;
    }
    case 'leave': {
      const i = seatOfConn(conn);
      if (i < 0 || app.game) return;
      app.seats.splice(i, 1);
      app.seats.forEach((s, k) => { s.color = PLAYER_COLORS[k]; });
      app.net.send(conn, { t: 'left' });
      save(); broadcast(); render();
      return;
    }
    case 'act': {
      const pid = seatOfConn(conn);
      if (pid < 0 || !app.game) return;
      const res = applyAction(app.game, pid, msg.action);
      if (!res.ok) { app.net.send(conn, { t: 'error', error: res.error }); return; }
      delete app.previews[pid];
      save(); broadcast(); render();
      return;
    }
    case 'preview': {
      const pid = seatOfConn(conn);
      if (pid < 0 || !app.game) return;
      const tgt = msg.target;
      if (tgt && ['vertex', 'edge', 'hex'].includes(tgt.kind) && Number.isInteger(tgt.id)) {
        app.previews[pid] = { kind: tgt.kind, id: tgt.id, item: tgt.item };
      } else {
        delete app.previews[pid];
      }
      renderBoardOnly();
      return;
    }
    case 'newGame': {
      if (seatOfConn(conn) < 0 || !app.game || app.game.phase !== 'gameover') return;
      backToLobby();
      return;
    }
    default:
  }
}

function handleJoin(conn, msg) {
  const clientId = String(msg.clientId || '').slice(0, 40);
  const name = cleanName(msg.name) || 'Player';
  if (!clientId) return;
  let seat = app.seats.find((s) => s.clientId === clientId);
  if (!seat && app.game) {
    // A player whose phone lost its saved id can retake a free seat by using the same name.
    seat = app.seats.find((s) => !s.conn && s.name.toLowerCase() === name.toLowerCase());
    if (seat) seat.clientId = clientId;
  }
  if (!seat) {
    if (app.game) {
      app.net.send(conn, { t: 'denied', reason: 'A game is already running. To retake a seat, join with the same name as a disconnected player.' });
      return;
    }
    if (app.seats.length >= 4) {
      app.net.send(conn, { t: 'denied', reason: 'This room already has 4 players.' });
      return;
    }
    seat = { clientId, name, color: PLAYER_COLORS[app.seats.length], conn: null };
    app.seats.push(seat);
  }
  // Drop any other seat still bound to this connection.
  app.seats.forEach((s) => { if (s !== seat && s.conn === conn) s.conn = null; });
  seat.conn = conn;
  if (!app.game) seat.name = name;
  app.net.send(conn, { t: 'joined', seat: app.seats.indexOf(seat) });
  save(); broadcast(); render();
}

function onLeave(conn) {
  const i = seatOfConn(conn);
  if (i < 0) return;
  app.seats[i].conn = null;
  delete app.previews[i];
  broadcast(); render();
}

function startGame() {
  app.game = createGame({
    players: app.seats.map((s) => ({ name: s.name, color: s.color })),
    seed: Math.floor(Math.random() * 2 ** 31),
  });
  app.previews = {};
  save(); broadcast(); render();
}

function backToLobby() {
  app.game = null;
  app.previews = {};
  save(); broadcast(); render();
}

// ---------- rendering ----------

function controllerUrl() {
  const u = new URL('play.html', location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', app.room);
  if (app.mode === 'local') u.searchParams.set('net', 'local');
  return u.toString();
}

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '<div class="qr-missing">QR unavailable</div>';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'Scan to join' });
}

const resIcon = (r) => `<span class="res" style="--rc:${RESOURCE_INFO[r].color};--ri:${RESOURCE_INFO[r].ink}">${iconSvg(r)}</span>`;
const costHtml = (cost) => Object.entries(cost).flatMap(([r, n]) => Array(n).fill(resIcon(r))).join('');

function render() {
  if (!app.room) return;
  if (app.game) renderGame();
  else renderLobby();
}

function renderStatus() {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = app.status.text;
    el.className = `status-text ${app.status.ok ? 'ok' : 'warn'}`;
  }
}

function renderLobby() {
  const url = controllerUrl();
  const slots = [0, 1, 2, 3].map((i) => {
    const s = app.seats[i];
    if (!s) return `<li class="slot empty"><span class="swatch"></span><span>Open seat</span></li>`;
    return `<li class="slot" style="--pc:${s.color}"><span class="swatch"></span><span class="pname">${esc(s.name)}</span>
      <span class="pcolor">${PLAYER_COLOR_NAMES[i]}</span>${s.conn ? '' : '<span class="badge">offline</span>'}</li>`;
  }).join('');
  root.innerHTML = `
  <div class="tv lobby">
    <header class="title">
      <h1 class="logo">HEX<span>FRONT</span></h1>
      <p class="tagline">Stake your claims across the asteroid belt</p>
    </header>
    <div class="lobby-grid">
      <section class="card join-card">
        <div class="qr">${qrSvg(url)}</div>
        <div class="join-text">
          <div class="label">Scan with your phone camera, or open</div>
          <div class="url">${esc(url.replace(/^https?:\/\//, '').replace(/\?.*$/, ''))}</div>
          <div class="label">and enter room code</div>
          <div class="room-code">${esc(app.room)}</div>
        </div>
      </section>
      <section class="card seats">
        <h2>Players ${app.seats.length}/4</h2>
        <ul class="slots">${slots}</ul>
        <button id="startBtn" class="tv-btn primary" ${app.seats.length >= 2 ? '' : 'disabled'}>Start game</button>
        <p class="hint">2 to 4 players. Anyone can also tap Start on their phone.</p>
      </section>
    </div>
    <section class="card rules">
      <h3>How to win</h3>
      <p>First to <b>${WIN_POINTS} points</b>. Outposts score 1, colonies 2, and the longest conduit network (5+) scores 2.
      Dice rolls pay every outpost touching a tile with that number. A roll of 7 sends the raiders: big hands lose half, and the roller moves the raiders to block a tile and steal a card.</p>
      <div class="costs">
        <span>${ITEM_NAMES.conduit} ${costHtml(COSTS.conduit)}</span>
        <span>${ITEM_NAMES.outpost} ${costHtml(COSTS.outpost)}</span>
        <span>${ITEM_NAMES.colony} ${costHtml(COSTS.colony)}</span>
      </div>
    </section>
    <footer class="footer"><span id="status"></span>
      <button id="fsBtn" class="tv-btn small">Full screen</button>
      <button id="newRoomBtn" class="tv-btn small">New room code</button>
    </footer>
  </div>`;
  renderStatus();
  document.getElementById('startBtn').onclick = () => { if (app.seats.length >= 2) startGame(); };
  document.getElementById('fsBtn').onclick = goFullscreen;
  document.getElementById('newRoomBtn').onclick = () => {
    app.net?.close();
    app.seats = [];
    openRoom(makeRoomCode());
    save();
  };
}

function phaseText(g) {
  const cur = g.players[g.current];
  const name = esc(cur.name);
  switch (g.phase) {
    case 'setup': return `${name}: place ${g.setup.step === 'outpost' ? 'an outpost' : 'a conduit'}`;
    case 'roll': return `${name}: roll the dice`;
    case 'main': return `${name}: build, trade, or end turn`;
    case 'discard': {
      const who = Object.keys(g.discards).map((p) => esc(g.players[p].name)).join(', ');
      return `Raid! Waiting for ${who} to dump cards`;
    }
    case 'moveRaider': return `${name}: move the raiders`;
    case 'steal': return `${name}: pick who to raid`;
    default: return '';
  }
}

function diceHtml(g) {
  if (!g.dice) return '<div class="dice idle"><span class="die">?</span><span class="die">?</span></div>';
  const sum = g.dice[0] + g.dice[1];
  return `<div class="dice ${sum === 7 ? 'seven' : ''}"><span class="die">${g.dice[0]}</span><span class="die">${g.dice[1]}</span><span class="sum">= ${sum}</span></div>`;
}

function gainsHtml(g) {
  if (!g.production || g.production.roll === 7) return '';
  const rows = Object.entries(g.production.gains).map(([pid, bag]) => {
    const items = Object.entries(bag).map(([r, n]) => `<span class="gain">+${n}${resIcon(r)}</span>`).join('');
    return `<div class="gain-row" style="--pc:${g.players[pid].color}"><span class="swatch"></span>${esc(g.players[pid].name)} ${items}</div>`;
  }).join('');
  return rows || '<div class="gain-row muted">Nobody produced</div>';
}

function playersHtml(g) {
  return g.players.map((p) => {
    const c = countPieces(g, p.id);
    const cards = RESOURCES.reduce((s, r) => s + p.hand[r], 0);
    const isCur = p.id === g.current && g.phase !== 'gameover';
    const online = !!app.seats[p.id]?.conn;
    return `<li class="prow ${isCur ? 'current' : ''}" style="--pc:${p.color}">
      <span class="swatch"></span>
      <span class="pname">${esc(p.name)}${online ? '' : ' <span class="badge">offline</span>'}</span>
      <span class="vp">${victoryPoints(g, p.id)}</span>
      <span class="pstats">${cards} cards · net ${longestConduit(g, p.id)}${g.longest.holder === p.id ? ' <b class="longest">LONGEST</b>' : ''}
        · ${LIMITS.outpost - c.outpost}/${LIMITS.colony - c.colony}/${LIMITS.conduit - c.conduit} left</span>
    </li>`;
  }).join('');
}

function tradeHtml(g) {
  const t = g.trade;
  if (!t) return '';
  const bag = (b) => Object.entries(b).filter(([, n]) => n > 0).map(([r, n]) => `${n}${resIcon(r)}`).join(' ');
  const declined = t.declined.map((p) => esc(g.players[p].name)).join(', ');
  return `<div class="trade-box" style="--pc:${g.players[t.from].color}">
    <div class="trade-title">${esc(g.players[t.from].name)} offers</div>
    <div class="trade-line">${bag(t.give)} <span class="arrow">for</span> ${bag(t.want)}</div>
    ${declined ? `<div class="muted">Declined: ${declined}</div>` : ''}
  </div>`;
}

function previewList(g) {
  return Object.entries(app.previews).map(([pid, p]) => ({ ...p, color: g.players[pid].color }));
}

function boardSvg(g) {
  return renderBoard(g, {
    previews: previewList(g),
    flashRoll: g.phase === 'main' && g.production ? g.production.roll : null,
  });
}

function renderBoardOnly() {
  const el = document.getElementById('board');
  if (el && app.game) el.innerHTML = boardSvg(app.game);
}

function renderGame() {
  const g = app.game;
  const cur = g.players[g.current];
  const url = controllerUrl();
  const over = g.phase === 'gameover';
  const log = g.log.slice(-7).reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');
  root.innerHTML = `
  <div class="tv game">
    <main class="board-area">
      <div id="board" class="board">${boardSvg(g)}</div>
      <div class="legend">
        ${RESOURCES.map((r) => `<span>${resIcon(r)} ${RESOURCE_INFO[r].name}</span>`).join('')}
        <span class="sep"></span>
        <span>${ITEM_NAMES.conduit} ${costHtml(COSTS.conduit)}</span>
        <span>${ITEM_NAMES.outpost} ${costHtml(COSTS.outpost)}</span>
        <span>${ITEM_NAMES.colony} ${costHtml(COSTS.colony)}</span>
      </div>
    </main>
    <aside class="side">
      <div class="turn-banner" style="--pc:${cur.color}">
        <div class="turn-label">${g.phase === 'setup' ? 'Setup' : `Turn ${g.turn}`}</div>
        <div class="turn-text">${phaseText(g)}</div>
      </div>
      <div class="roll-area">${diceHtml(g)}<div class="gains">${gainsHtml(g)}</div></div>
      <ul class="players">${playersHtml(g)}</ul>
      ${tradeHtml(g)}
      <ol class="log">${log}</ol>
      <div class="mini-join">
        <div class="mini-qr">${qrSvg(url)}</div>
        <div>Rejoin: room <b>${esc(app.room)}</b><br><span id="status"></span></div>
      </div>
    </aside>
    ${over ? `<div class="overlay"><div class="winner" style="--pc:${g.players[g.winner].color}">
        <div class="crown">★</div>
        <h1>${esc(g.players[g.winner].name)} wins!</h1>
        <ol class="final">${g.players.slice().sort((a, b) => victoryPoints(g, b.id) - victoryPoints(g, a.id))
          .map((p) => `<li style="--pc:${p.color}"><span class="swatch"></span>${esc(p.name)} <b>${victoryPoints(g, p.id)}</b></li>`).join('')}</ol>
        <button id="againBtn" class="tv-btn primary">Play again</button>
      </div></div>` : ''}
  </div>`;
  renderStatus();
  const again = document.getElementById('againBtn');
  if (again) again.onclick = backToLobby;
}

// ---------- TV niceties ----------

function goFullscreen() {
  const el = document.documentElement;
  (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or not allowed */ }
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('click', keepAwake);

// ---------- boot ----------

function boot() {
  const saved = loadSaved();
  if (saved && (saved.game ? saved.game.phase !== 'gameover' : saved.seats.length > 0)) {
    root.innerHTML = `
    <div class="tv resume">
      <h1 class="logo">HEX<span>FRONT</span></h1>
      <div class="card">
        <h2>${saved.game ? 'A game is still in progress' : 'A lobby is still open'}</h2>
        <p>Room <b>${esc(saved.room)}</b> · ${saved.seats.map((s) => esc(s.name)).join(', ')}${saved.game ? ` · turn ${saved.game.turn}` : ''}</p>
        <div class="row">
          <button id="resumeBtn" class="tv-btn primary">Resume</button>
          <button id="freshBtn" class="tv-btn">Start fresh</button>
        </div>
        <p class="hint">Phones reconnect on their own when you resume.</p>
      </div>
    </div>`;
    document.getElementById('resumeBtn').onclick = () => {
      app.seats = saved.seats.map((s) => ({ ...s, conn: null }));
      app.game = saved.game;
      openRoom(saved.room);
    };
    document.getElementById('freshBtn').onclick = () => {
      localStorage.removeItem(SAVE_KEY);
      openRoom(makeRoomCode());
      save();
    };
    return;
  }
  openRoom(makeRoomCode());
  save();
}

boot();
keepAwake();

// Exposed for automated tests and debugging in the browser console.
window.hexfront = { app };
