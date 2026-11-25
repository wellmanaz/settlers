// Phone controller: shows your hand, lets you pick spots on a mini board and sends actions to the TV.
import {
  RESOURCES, RESOURCE_INFO, COSTS, ITEM_NAMES, LIMITS, WIN_POINTS,
  legalSpots, legalRaiderHexes, buildBlocker, tradeRate, canAfford, handTotal, emptyHand, countPieces,
} from './engine.js';
import { renderBoard, onBoardPick, esc } from './render.js';
import { iconSvg } from './icons.js';
import { createClient, cleanRoomCode, netMode } from './net.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);

const store = {
  get: (k, d = '') => { try { return localStorage.getItem(`hexfront:${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`hexfront:${k}`, v); } catch { /* ignore */ } },
};

function clientId() {
  let id = store.get('clientId');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    store.set('clientId', id);
  }
  return id;
}

const ui = {
  screen: 'join', // join | connecting | lobby | game
  mode: netMode(),
  room: cleanRoomCode(params.get('room') || store.get('room')),
  name: store.get('name'),
  error: '',
  lobby: null,
  view: null,
  connected: [],
  link: 'down', // up | down | retrying
  linkVia: '', // direct | relay | local, once linked
  linkStep: '', // what the connection is doing right now
  linkSince: 0, // when the current connection attempt started
  errorDetail: '',
  joined: false,
  pick: null, // user-chosen build in main phase: { item }
  selected: null, // { key, id }
  panel: 'actions', // actions | trade
  tradeTab: 'bank',
  bankGive: null,
  bankGet: null,
  offerGive: emptyHand(),
  offerWant: emptyHand(),
  discardSel: emptyHand(),
  toast: '',
};

let client = null;
let attempt = null; // token of the current connection attempt
let retryTimer = null;
let toastTimer = null;

// ---------- connection ----------

function connect() {
  clearTimeout(retryTimer);
  const old = client;
  client = null;
  attempt = null;
  old?.close();
  ui.link = ui.joined ? 'retrying' : 'down';
  ui.linkStep = 'Starting…';
  ui.linkSince = Date.now();
  if (!ui.joined) ui.screen = 'connecting';
  render();
  // Handlers can fire while createClient is still running, before `client` is set,
  // so each attempt is identified by a token rather than by the client object.
  const token = {};
  attempt = token;
  const current = () => attempt === token;
  client = createClient(ui.room, ui.mode, {
    onOpen: (how) => {
      if (!current()) return;
      ui.linkVia = how;
      ui.linkStep = 'Linked. Joining the game…';
      renderLinkStep();
      client.send({ t: 'join', clientId: clientId(), name: ui.name });
    },
    onStatus: (text) => {
      if (!current()) return;
      ui.linkStep = text;
      renderLinkStep();
    },
    onMessage: (msg) => { if (current()) onMessage(msg); },
    onClose: (reason) => {
      if (!current()) return;
      attempt = null;
      client = null;
      if (reason === 'left') return;
      if (!ui.joined) {
        ui.error = "Couldn't connect to the TV.";
        ui.errorDetail = reason || '';
        ui.screen = 'join';
        render();
        return;
      }
      ui.link = 'retrying';
      ui.linkStep = `${reason || 'Lost the TV.'} Trying again…`;
      render();
      retryTimer = setTimeout(connect, 2500);
    },
  });
}

// Updates just the connection-progress line, so typing elsewhere isn't disturbed.
function renderLinkStep() {
  const el = document.getElementById('linkstep');
  if (!el) return;
  const secs = Math.max(0, Math.round((Date.now() - ui.linkSince) / 1000));
  el.textContent = `${ui.linkStep} (${secs}s)`;
}
setInterval(() => { if (ui.screen === 'connecting' || ui.link !== 'up') renderLinkStep(); }, 1000);

function send(msg) {
  if (!client || !client.open) { toast('Not connected to the TV yet'); return; }
  client.send(msg);
}
const act = (action) => send({ t: 'act', action });
const preview = (target) => { if (client?.open) client.send({ t: 'preview', target }); };

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'joined':
      ui.joined = true;
      ui.link = 'up';
      ui.error = '';
      ui.errorDetail = '';
      store.set('room', ui.room);
      break;
    case 'who':
      // The TV restarted and lost track of this phone: introduce ourselves again.
      if (ui.joined) client?.send({ t: 'join', clientId: clientId(), name: ui.name });
      return;
    case 'denied':
      ui.joined = false;
      ui.error = msg.reason;
      ui.screen = 'join';
      client?.close();
      break;
    case 'left':
      ui.joined = false;
      ui.screen = 'join';
      ui.lobby = null;
      client?.close();
      break;
    case 'lobby':
      ui.lobby = msg;
      ui.view = null;
      ui.screen = 'lobby';
      break;
    case 'state': {
      const before = ui.view;
      ui.view = msg.view;
      ui.connected = msg.connected || [];
      ui.screen = 'game';
      onNewState(before, msg.view);
      break;
    }
    case 'error':
      toast(msg.error);
      return;
    default:
      return;
  }
  render();
}

function onNewState(before, v) {
  const me = v.you;
  const myTurnNow = v.current === me && v.phase !== 'gameover';
  const myTurnBefore = before && before.current === me && before.phase === v.phase;
  if (myTurnNow && !myTurnBefore && (v.phase === 'roll' || v.phase === 'setup')) buzz([80, 60, 80]);
  if (v.trade && v.trade.from !== me && (!before?.trade || before.trade.id !== v.trade.id)) buzz([40]);
  if (v.phase === 'discard' && v.discards[me] && before?.phase !== 'discard') buzz([200]);
  // Reset transient UI when the situation changes.
  if (v.phase !== 'main' || v.current !== me) { ui.pick = null; ui.panel = 'actions'; }
  if (!before || before.phase !== v.phase || before.current !== v.current) ui.selected = null;
  if (v.phase !== 'discard') ui.discardSel = emptyHand();
  const hand = v.players[me].hand;
  for (const r of RESOURCES) ui.offerGive[r] = Math.min(ui.offerGive[r], hand[r]);
}

function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
}

function toast(text) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = ''; renderToast(); }, 2800);
  renderToast();
}

// ---------- what am I picking on the map? ----------

function activePick(v) {
  const me = v.you;
  if (v.current !== me) return null;
  if (v.phase === 'setup') return { item: v.setup.step, kind: v.setup.step === 'outpost' ? 'vertex' : 'edge', ids: legalSpots(v, me, v.setup.step) };
  if (v.phase === 'moveRaider') return { item: 'raider', kind: 'hex', ids: legalRaiderHexes(v) };
  if (v.phase === 'main' && ui.pick) {
    const item = ui.pick.item;
    return { item, kind: item === 'conduit' ? 'edge' : 'vertex', ids: legalSpots(v, me, item) };
  }
  return null;
}

const pickKey = (p) => (p ? `${p.item}` : '');

function selectedFor(pick) {
  return ui.selected && ui.selected.key === pickKey(pick) ? ui.selected.id : null;
}

// ---------- rendering ----------

const resChip = (r, n, extra = '') => `<span class="chip" style="--rc:${RESOURCE_INFO[r].color};--ri:${RESOURCE_INFO[r].ink}" ${extra}>
  <span class="chip-icon">${iconSvg(r)}</span><span class="chip-n">${n}</span></span>`;
const resIcon = (r) => `<span class="ri" style="--rc:${RESOURCE_INFO[r].color};--ri:${RESOURCE_INFO[r].ink}">${iconSvg(r)}</span>`;
const costIcons = (cost) => Object.entries(cost).flatMap(([r, n]) => Array(n).fill(resIcon(r))).join('');
const bagText = (bag) => Object.entries(bag).filter(([, n]) => n > 0).map(([r, n]) => `${n}${resIcon(r)}`).join(' ');

function render() {
  if (ui.screen === 'join') return renderJoin();
  if (ui.screen === 'connecting') {
    root.innerHTML = `<div class="screen center"><h1 class="logo">HEX<span>FRONT</span></h1><p class="big">Connecting to room ${esc(ui.room)}…</p>
      <p class="linkstep" id="linkstep" role="status" aria-live="polite"></p>
      <button class="btn ghost" data-do="cancelJoin">Cancel</button></div>`;
    renderLinkStep();
    return;
  }
  if (ui.screen === 'lobby') renderLobby();
  else renderGame();
  renderLinkStep();
}

function renderJoin() {
  root.innerHTML = `
  <form class="screen center join" data-form="join">
    <h1 class="logo">HEX<span>FRONT</span></h1>
    <p class="muted">Phone controller</p>
    <label>Room code<input name="room" value="${esc(ui.room)}" maxlength="8" autocapitalize="characters" autocomplete="off" required></label>
    <label>Your name<input name="name" value="${esc(ui.name)}" maxlength="16" autocomplete="nickname" required></label>
    <button class="btn primary big" type="submit">Join</button>
    ${ui.error ? `<div class="error" role="alert"><b>${esc(ui.error)}</b>${ui.errorDetail ? `<br>${esc(ui.errorDetail)}` : ''}</div>` : ''}
    ${ui.mode !== 'auto' ? `<p class="muted">Connection mode: ${esc(ui.mode)}</p>` : ''}
  </form>`;
}

function linkLabel() {
  if (ui.linkVia === 'direct') return 'Linked directly to the TV';
  if (ui.linkVia === 'relay') return 'Linked to the TV through the relay';
  if (ui.linkVia === 'local') return 'Local test link';
  return '';
}

function renderLobby() {
  const l = ui.lobby;
  const rows = l.players.map((p, i) => `<li style="--pc:${p.color}"><span class="dot"></span>${esc(p.name)}${i === l.you ? ' <b>(you)</b>' : ''}${p.connected ? '' : ' <i>offline</i>'}</li>`).join('');
  root.innerHTML = `
  <div class="screen lobby">
    <h1 class="logo small">HEX<span>FRONT</span></h1>
    <h2>Room ${esc(l.room)}</h2>
    <ul class="plist">${rows}</ul>
    <button class="btn primary big" data-do="start" ${l.players.length >= 2 ? '' : 'disabled'}>Start game</button>
    <p class="muted">${l.players.length < 2 ? 'Waiting for at least one more player.' : 'Start when everyone is in (up to 4).'}</p>
    <button class="btn ghost" data-do="leave">Leave room</button>
    <p class="muted small">${linkLabel()}</p>
  </div>`;
}

function renderGame() {
  const v = ui.view;
  const me = v.you;
  const p = v.players[me];
  const pick = activePick(v);
  const sel = selectedFor(pick);
  const cur = v.players[v.current];
  const myTurn = v.current === me;
  const turnText = v.phase === 'gameover' ? 'Game over' : myTurn ? 'Your turn' : `${esc(cur.name)}'s turn`;
  const map = renderBoard(v, {
    compact: true,
    highlight: pick ? { kind: pick.kind, ids: pick.ids } : null,
    selected: sel !== null ? { kind: pick.kind, id: sel, item: pick.item === 'raider' ? null : pick.item, color: p.color } : null,
    flashRoll: v.phase === 'main' && v.production ? v.production.roll : null,
  });
  root.innerHTML = `
  <div class="screen game" style="--pc:${p.color}">
    <header class="mebar">
      <span class="dot"></span><b class="me-name">${esc(p.name)}</b>
      <span class="pts">${p.points}<small>/${WIN_POINTS}</small></span>
      <span class="turn ${myTurn ? 'mine' : ''}" style="--tc:${cur.color}">${turnText}</span>
    </header>
    ${ui.link !== 'up' ? '<div class="linkbar" role="status">Reconnecting to the TV… <span id="linkstep"></span></div>' : ''}
    <div class="map" id="map">${map}</div>
    <div class="hand">${RESOURCES.map((r) => resChip(r, p.hand[r])).join('')}</div>
    <section class="panel">${panelHtml(v, pick, sel)}</section>
    <div class="toast ${ui.toast ? 'show' : ''}" id="toast">${esc(ui.toast)}</div>
  </div>`;
}

function renderToast() {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = ui.toast;
  el.classList.toggle('show', !!ui.toast);
}

function panelHtml(v, pick, sel) {
  const me = v.you;
  const hand = v.players[me].hand;
  const cur = v.players[v.current];

  if (v.phase === 'gameover') {
    const w = v.players[v.winner];
    return `<div class="center"><p class="big">${w.id === me ? 'You win!' : `${esc(w.name)} wins!`}</p>
      <button class="btn primary big" data-do="newGame">Back to lobby</button></div>`;
  }

  if (v.phase === 'discard') {
    const need = v.discards[me];
    if (!need) return waiting(`Raid! Waiting for others to dump cards.`);
    const chosen = handTotal(ui.discardSel);
    return `<p class="prompt warn">Raid! Dump ${need} cards (${chosen}/${need})</p>
      ${stepperGrid('discardSel', (r) => hand[r])}
      <button class="btn primary big" data-do="discard" ${chosen === need ? '' : 'disabled'}>Dump ${need}</button>`;
  }

  if (pick) {
    const names = { outpost: 'an outpost', conduit: 'a conduit', colony: 'a colony', raider: 'the raiders' };
    const where = { vertex: 'corner', edge: 'edge', hex: 'tile' }[pick.kind];
    const canCancel = v.phase === 'main';
    const header = v.phase === 'setup'
      ? `Setup: place ${names[pick.item]} for free`
      : pick.item === 'raider' ? 'Move the raiders to block a tile' : `Build ${names[pick.item]}`;
    return `<p class="prompt">${header}</p>
      <p class="muted">${pick.ids.length ? `Tap a glowing ${where} on the map${sel !== null ? ', then confirm' : ''}.` : 'No legal spot.'}</p>
      <div class="row">
        ${canCancel ? '<button class="btn ghost" data-do="cancelPick">Cancel</button>' : ''}
        <button class="btn primary big grow" data-do="confirmPick" ${sel !== null ? '' : 'disabled'}>${pick.item === 'raider' ? 'Send raiders here' : 'Place here'}</button>
      </div>`;
  }

  if (v.current !== me) {
    let html = waiting(`${esc(cur.name)} is ${v.phase === 'setup' ? 'placing pieces' : v.phase === 'roll' ? 'about to roll' : 'taking their turn'}.`);
    if (v.trade && v.trade.from !== me) html += offerCard(v);
    return html + lastRoll(v);
  }

  if (v.phase === 'roll') {
    return `<button class="btn primary huge" data-do="roll">Roll dice</button>`;
  }

  if (v.phase === 'steal') {
    return `<p class="prompt">Raid who?</p><div class="col">${v.stealFrom.map((pid) => {
      const o = v.players[pid];
      return `<button class="btn big" style="--pc:${o.color}" data-do="steal" data-pid="${pid}"><span class="dot"></span>${esc(o.name)} (${o.cards} cards)</button>`;
    }).join('')}</div>`;
  }

  if (v.phase === 'main') {
    if (ui.panel === 'trade') return tradePanel(v);
    const left = countPieces(v, me);
    const builds = ['conduit', 'outpost', 'colony'].map((item) => {
      const why = buildBlocker(v, me, item);
      return `<button class="btn build" data-do="build" data-item="${item}" ${why ? 'disabled' : ''}>
        <span class="bname">${ITEM_NAMES[item]}</span><span class="bcost">${costIcons(COSTS[item])}</span>
        <span class="bwhy">${why || `${LIMITS[item] - left[item]} left`}</span></button>`;
    }).join('');
    return `${lastRoll(v)}<div class="builds">${builds}</div>
      <div class="row">
        <button class="btn grow" data-do="openTrade">Trade</button>
        <button class="btn primary grow" data-do="endTurn">End turn</button>
      </div>`;
  }
  return waiting('…');
}

function waiting(text) {
  return `<p class="waiting">${text}</p>`;
}

function lastRoll(v) {
  if (!v.production) return '';
  const mine = v.production.gains[v.you];
  const got = mine ? `you got ${bagText(mine)}` : 'nothing for you';
  return `<p class="rolled">Rolled <b>${v.production.roll}</b>${v.production.roll === 7 ? '' : `: ${got}`}</p>`;
}

function offerCard(v) {
  const t = v.trade;
  if (t.declined.includes(v.you)) return `<p class="muted">You declined ${esc(v.players[t.from].name)}'s offer.</p>`;
  const can = canAfford(v.players[v.you].hand, t.want);
  return `<div class="offer" style="--pc:${v.players[t.from].color}">
    <p><b>${esc(v.players[t.from].name)}</b> offers ${bagText(t.give)}<br>for your ${bagText(t.want)}</p>
    <div class="row">
      <button class="btn ghost grow" data-do="decline">Decline</button>
      <button class="btn primary grow" data-do="accept" ${can ? '' : 'disabled'}>${can ? 'Accept' : 'Not enough'}</button>
    </div></div>`;
}

function stepperGrid(bagName, maxFor) {
  const bag = ui[bagName];
  return `<div class="steppers">${RESOURCES.map((r) => `
    <div class="stepper" style="--rc:${RESOURCE_INFO[r].color};--ri:${RESOURCE_INFO[r].ink}">
      <button class="sbtn" data-do="step" data-bag="${bagName}" data-res="${r}" data-delta="-1" ${bag[r] > 0 ? '' : 'disabled'}>−</button>
      <span class="sval"><span class="chip-icon">${iconSvg(r)}</span>${bag[r]}</span>
      <button class="sbtn" data-do="step" data-bag="${bagName}" data-res="${r}" data-delta="1" ${maxFor(r) > bag[r] ? '' : 'disabled'}>+</button>
    </div>`).join('')}</div>`;
}

function tradePanel(v) {
  const me = v.you;
  const hand = v.players[me].hand;
  const tabs = `<div class="tabs">
    <button class="tab ${ui.tradeTab === 'bank' ? 'on' : ''}" data-do="tab" data-tab="bank">Bank</button>
    <button class="tab ${ui.tradeTab === 'players' ? 'on' : ''}" data-do="tab" data-tab="players">Players</button>
    <button class="tab back" data-do="closeTrade">Done</button></div>`;
  if (ui.tradeTab === 'bank') {
    const give = RESOURCES.map((r) => {
      const rate = tradeRate(v, me, r);
      return `<button class="pickres ${ui.bankGive === r ? 'on' : ''}" style="--rc:${RESOURCE_INFO[r].color};--ri:${RESOURCE_INFO[r].ink}" data-do="bankGive" data-res="${r}" ${hand[r] >= rate ? '' : 'disabled'}>
        ${iconSvg(r)}<small>${rate}:1</small></button>`;
    }).join('');
    const get = RESOURCES.map((r) => `<button class="pickres ${ui.bankGet === r ? 'on' : ''}" style="--rc:${RESOURCE_INFO[r].color};--ri:${RESOURCE_INFO[r].ink}" data-do="bankGet" data-res="${r}" ${r === ui.bankGive ? 'disabled' : ''}>${iconSvg(r)}</button>`).join('');
    const ready = ui.bankGive && ui.bankGet && ui.bankGive !== ui.bankGet && hand[ui.bankGive] >= tradeRate(v, me, ui.bankGive);
    return `${tabs}<p class="label">Give</p><div class="resrow">${give}</div>
      <p class="label">Get 1</p><div class="resrow">${get}</div>
      <button class="btn primary big" data-do="bankTrade" ${ready ? '' : 'disabled'}>Trade with bank</button>`;
  }
  if (v.trade && v.trade.from === me) {
    const declined = v.trade.declined.map((p) => esc(v.players[p].name)).join(', ');
    return `${tabs}<div class="offer mine"><p>Your offer: ${bagText(v.trade.give)} for ${bagText(v.trade.want)}</p>
      <p class="muted">${declined ? `Declined by ${declined}. ` : ''}Waiting for someone to accept…</p>
      <button class="btn ghost big" data-do="cancelOffer">Cancel offer</button></div>`;
  }
  const ready = handTotal(ui.offerGive) > 0 && handTotal(ui.offerWant) > 0
    && !RESOURCES.some((r) => ui.offerGive[r] > 0 && ui.offerWant[r] > 0);
  return `${tabs}<p class="label">You give</p>${stepperGrid('offerGive', (r) => hand[r])}
    <p class="label">You want</p>${stepperGrid('offerWant', () => 9)}
    <button class="btn primary big" data-do="offer" ${ready ? '' : 'disabled'}>Offer to everyone</button>`;
}

// ---------- input ----------

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form="join"]');
  if (!form) return;
  ev.preventDefault();
  const data = new FormData(form);
  ui.room = cleanRoomCode(data.get('room'));
  ui.name = String(data.get('name') || '').trim().slice(0, 16);
  if (!ui.room || !ui.name) { ui.error = 'Enter the room code and your name.'; render(); return; }
  store.set('name', ui.name);
  ui.error = '';
  ui.errorDetail = '';
  keepAwake();
  connect();
});

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-do]');
  if (!el || el.disabled) return;
  const v = ui.view;
  const d = el.dataset;
  switch (d.do) {
    case 'cancelJoin': { const c = client; client = null; attempt = null; c?.close(); ui.screen = 'join'; break; }
    case 'start': send({ t: 'start' }); return;
    case 'leave': send({ t: 'leave' }); return;
    case 'newGame': send({ t: 'newGame' }); return;
    case 'roll': act({ type: 'roll' }); return;
    case 'endTurn': act({ type: 'endTurn' }); return;
    case 'build': ui.pick = { item: d.item }; ui.selected = null; break;
    case 'cancelPick': ui.pick = null; ui.selected = null; preview(null); break;
    case 'confirmPick': {
      const pick = activePick(v);
      const id = selectedFor(pick);
      if (!pick || id === null) return;
      if (pick.item === 'raider') act({ type: 'moveRaider', hex: id });
      else act({ type: 'build', item: pick.item, at: id });
      ui.selected = null;
      ui.pick = null;
      break;
    }
    case 'steal': act({ type: 'steal', victim: Number(d.pid) }); return;
    case 'discard': act({ type: 'discard', cards: { ...ui.discardSel } }); return;
    case 'step': {
      const bag = ui[d.bag];
      bag[d.res] = Math.max(0, bag[d.res] + Number(d.delta));
      if (d.bag === 'offerGive' && bag[d.res] > 0) ui.offerWant[d.res] = 0;
      if (d.bag === 'offerWant' && bag[d.res] > 0) ui.offerGive[d.res] = 0;
      break;
    }
    case 'openTrade': ui.panel = 'trade'; break;
    case 'closeTrade': ui.panel = 'actions'; break;
    case 'tab': ui.tradeTab = d.tab; break;
    case 'bankGive': ui.bankGive = d.res; if (ui.bankGet === d.res) ui.bankGet = null; break;
    case 'bankGet': ui.bankGet = d.res; break;
    case 'bankTrade': act({ type: 'bankTrade', give: ui.bankGive, get: ui.bankGet }); return;
    case 'offer': act({ type: 'offerTrade', give: { ...ui.offerGive }, want: { ...ui.offerWant } }); return;
    case 'cancelOffer': act({ type: 'cancelTrade' }); return;
    case 'accept': act({ type: 'acceptTrade', tradeId: v.trade.id }); return;
    case 'decline': act({ type: 'declineTrade', tradeId: v.trade.id }); return;
    default: return;
  }
  render();
});

// Map taps (delegated; the map is re-rendered often).
onBoardPick(root, (kind, id) => {
  const v = ui.view;
  if (!v) return;
  const pick = activePick(v);
  if (!pick || pick.kind !== kind || !pick.ids.includes(id)) return;
  ui.selected = { key: pickKey(pick), id };
  preview({ kind, id, item: pick.item === 'raider' ? null : pick.item });
  render();
});

// ---------- keep alive ----------

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* ignore */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (ui.joined) keepAwake();
  if (ui.joined && (!client || !client.open)) connect();
});

// Auto-join if this phone has played in this room before.
render();
if (ui.room && ui.name && params.get('room') && store.get('room') === ui.room) connect();

window.hexfront = { ui };
