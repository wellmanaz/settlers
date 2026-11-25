// UI smoke test: runs the real TV page and several phone pages, each in its own
// worker thread with a jsdom DOM. Phones are driven only through their DOM: form
// submit, button taps and map taps. Plays a whole game to a winner.
//
//   npm install && npm run test:ui        pages linked by BroadcastChannel (?net=local)
//   npm run test:ui:relay                 pages linked through a local MQTT broker (?net=relay),
//                                         the same relay code the live site falls back to
//
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- worker: one browser page ----------------

async function runPage() {
  const { JSDOM } = await import('jsdom');
  const { page, url, storage } = workerData;
  const html = readFileSync(join(ROOT, page), 'utf8')
    .replace(/<script[^>]*src=[^>]*><\/script>/g, ''); // we load scripts ourselves
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  for (const [k, v] of Object.entries(storage || {})) w.localStorage.setItem(k, v);
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  define('window', w);
  define('document', w.document);
  define('location', w.location);
  define('localStorage', w.localStorage);
  define('navigator', w.navigator);
  define('FormData', w.FormData);
  if (page === 'index.html') w.eval(readFileSync(join(ROOT, 'vendor/qrcode-generator-1.4.4.js'), 'utf8'));
  // The bundle starts with "use strict", so under eval its top-level var stays local: export it.
  if (url.includes('net=relay')) w.eval(`${readFileSync(join(ROOT, 'vendor/mqtt-5.16.1.min.js'), 'utf8')};window.mqtt = mqtt;`);
  w.BroadcastChannel = globalThis.BroadcastChannel;
  await import(pathToFileURL(join(ROOT, 'js', page === 'index.html' ? 'host.js' : 'phone.js')).href);
  const AsyncFunction = (async () => {}).constructor;
  parentPort.on('message', async ({ id, code }) => {
    try {
      const fn = new AsyncFunction('w', 'd', 'hf', 'tap', code);
      const tap = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      const value = await fn(w, w.document, w.hexfront, tap);
      parentPort.postMessage({ id, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
    } catch (err) {
      parentPort.postMessage({ id, error: String(err && err.stack || err) });
    }
  });
  parentPort.postMessage({ ready: true });
}

// ---------------- main: the test driver ----------------

function spawn(page, query, storage) {
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { page, url: `http://localhost/${page}${query}`, storage },
  });
  let seq = 0;
  const waiting = new Map();
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  worker.on('message', (m) => {
    if (m.ready) return readyResolve();
    const p = waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.value);
  });
  worker.on('error', (e) => { console.error(`${page} crashed:`, e); process.exit(1); });
  const run = (code) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, code });
  });
  return { worker, run, ready };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RELAY = isMainThread && process.argv[2] === 'relay';
let NETQ = 'net=local';

async function until(check, what, timeout = RELAY ? 10000 : 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

let rngState = 12345;
const rand = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
const pickOne = (arr) => arr[Math.floor(rand() * arr.length)];

async function startBroker() {
  const http = await import('node:http');
  const { WebSocketServer, createWebSocketStream } = await import('ws');
  const aedes = (await import('aedes')).default();
  const srv = http.createServer();
  new WebSocketServer({ server: srv }).on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return `ws://127.0.0.1:${srv.address().port}/mqtt`;
}

async function main() {
  if (RELAY) {
    NETQ = `net=relay&relay=${encodeURIComponent(await startBroker())}`;
    console.log('Linking pages through a local MQTT broker (relay mode)');
  }
  const t0 = Date.now();
  let host = spawn('index.html', `?${NETQ}`);
  await host.ready;
  const room = await until(() => host.run('return hf.app.room'), 'room code');
  const lobby = await host.run(`return {
    qr: !!d.querySelector('.qr svg'), code: d.querySelector('.room-code')?.textContent, start: d.getElementById('startBtn').disabled }`);
  assert.ok(lobby.qr, 'TV shows a QR code');
  assert.equal(lobby.code, room);
  assert.equal(lobby.start, true, 'Start disabled with no players');
  const tvStatus = await until(() => host.run(`const t = d.querySelector('[data-status]')?.textContent || ''; return /Online|Local test mode/.test(t) && t`), 'TV online status');
  console.log(`TV lobby up, room ${room}, status "${tvStatus}"`);

  if (RELAY) {
    // A wrong room code: the phone shows what it is doing, then a clear error instead of hanging.
    const lost = spawn('play.html', `?room=WRONG&${NETQ}`);
    await lost.ready;
    await lost.run(`const f = d.querySelector('[data-form="join"]'); f.querySelector('[name=name]').value = 'Zed'; f.requestSubmit();`);
    const step = await until(() => lost.run(`return d.getElementById('linkstep')?.textContent`), 'connection progress on the phone');
    const err = await until(() => lost.run(`return hf.ui.screen === 'join' && d.querySelector('.error')?.textContent`), 'wrong-room error', 20000);
    assert.match(err, /Couldn't connect to the TV/);
    assert.match(err, /didn't answer in room WRONG/);
    console.log(`Wrong room: phone showed "${step.trim()}", then "${err.trim()}"`);
    await lost.worker.terminate();
  }

  const names = ['Ana', 'Ben', 'Cy'];
  const phones = [];
  for (const name of names) {
    const ph = spawn('play.html', `?room=${room}&${NETQ}`);
    await ph.ready;
    await ph.run(`
      const f = d.querySelector('[data-form="join"]');
      f.querySelector('[name=name]').value = ${JSON.stringify(name)};
      f.requestSubmit();`);
    phones.push(ph);
  }
  await until(() => host.run('return hf.app.seats.filter(s => s.conn).length === 3'), '3 phones seated');
  await until(() => phones[2].run(`return hf.ui.screen === 'lobby' && hf.ui.lobby.players.length === 3`), 'phone lobby');
  const tvSlots = await host.run(`return [...d.querySelectorAll('.slot .pname')].map(e => e.textContent)`);
  assert.deepEqual(tvSlots, names);
  console.log('3 phones joined:', tvSlots.join(', '));

  await phones[1].run(`tap(d.querySelector('[data-do="start"]'))`);
  await until(() => host.run('return !!hf.app.game'), 'game start');
  await until(() => phones[0].run(`return hf.ui.screen === 'game'`), 'phones in game');
  const tvBoard = await host.run(`return { tiles: d.querySelectorAll('#board .tile').length, players: d.querySelectorAll('.prow').length }`);
  assert.equal(tvBoard.tiles, 24);
  assert.equal(tvBoard.players, 3);
  const privacy = await phones[0].run(`const v = hf.ui.view; return { mine: !!v.players[v.you].hand, others: v.players.filter(p => p.id !== v.you).every(p => !p.hand), rng: 'rng' in v }`);
  assert.deepEqual(privacy, { mine: true, others: true, rng: false }, 'phones only see their own hand');
  console.log('Game started, TV shows 24 tiles and 3 players');

  const hostGame = () => host.run(`const g = hf.app.game; return g && { phase: g.phase, current: g.current, version: g.version,
    discards: g.discards, winner: g.winner, turn: g.turn, trade: g.trade, players: g.players.map(p => p.hand) }`);

  // Do something on a phone, then wait for the TV state to move on.
  async function step(ph, code, label) {
    const before = (await hostGame()).version;
    const did = await ph.run(code);
    if (did === false) return false;
    try {
      await until(async () => (await hostGame()).version !== before, label, 2000);
    } catch (e) {
      const toast = await ph.run('return hf.ui.toast');
      throw new Error(`${label}: no state change (phone says: ${toast || 'nothing'})`);
    }
    return true;
  }

  // Wait until the given phone has rendered the latest state.
  async function synced(ph) {
    const v = (await hostGame()).version;
    await until(() => ph.run(`return hf.ui.view && hf.ui.view.version === ${v}`), 'phone sync');
  }

  const tapPickAndConfirm = `
    const spots = [...d.querySelectorAll('#map [data-pick]')];
    if (!spots.length) return false;
    tap(spots[Math.floor(Math.random() * spots.length)]);
    const ok = d.querySelector('[data-do="confirmPick"]');
    if (!ok || ok.disabled) throw new Error('confirm button not enabled after a map tap');
    tap(ok);`;

  let actions = 0;
  let tradedBetweenPlayers = false;
  let reconnected = false;
  let resumed = false;
  for (let guard = 0; guard < 8000; guard++) {
    const g = await hostGame();
    if (g.phase === 'gameover') break;

    // Mid-game: one phone drops and comes back, then the TV itself reloads and resumes.
    if (!reconnected && g.turn === 4 && g.phase === 'roll') {
      reconnected = true;
      await phones[2].run(`w.dispatchEvent(new w.Event('pagehide'))`);
      await phones[2].worker.terminate();
      await until(() => host.run('return hf.app.seats[2].conn === null'), 'TV marks phone offline');
      const offline = await host.run(`return d.querySelectorAll('.prow .badge').length`);
      assert.equal(offline, 1, 'TV shows the offline badge');
      // Same player on a "new" phone (no saved id) retakes the seat by name.
      const ph = spawn('play.html', `?room=${room}&${NETQ}`);
      await ph.ready;
      await ph.run(`const f = d.querySelector('[data-form="join"]'); f.querySelector('[name=name]').value = 'cy'; f.requestSubmit();`);
      await until(() => ph.run(`return hf.ui.screen === 'game' && hf.ui.view.you === 2`), 'seat retaken');
      phones[2] = ph;
      console.log(`Turn 4: phone 3 dropped and retook its seat`);
    }
    if (!resumed && g.turn === 6 && g.phase === 'roll') {
      resumed = true;
      const saved = await host.run(`return { 'hexfront:host': w.localStorage.getItem('hexfront:host') }`);
      await host.worker.terminate();
      host = spawn('index.html', `?${NETQ}`, saved);
      await host.ready;
      await until(() => host.run(`return !!d.getElementById('resumeBtn')`), 'resume prompt');
      await host.run(`tap(d.getElementById('resumeBtn'))`);
      await until(() => host.run(`return !!hf.app.game && hf.app.room === ${JSON.stringify(room)}`), 'resumed game');
      await until(() => host.run(`return hf.app.seats.every(s => s.conn !== null)`), 'phones rejoined after TV reload');
      console.log('Turn 6: TV reloaded, resumed the saved game, phones rejoined');
      continue;
    }

    if (g.phase === 'discard') {
      for (const pid of Object.keys(g.discards).map(Number)) {
        await synced(phones[pid]);
        await step(phones[pid], `
          for (let i = 0; i < 40; i++) {
            const btn = [...d.querySelectorAll('[data-bag="discardSel"][data-delta="1"]')].find(b => !b.disabled);
            const go = d.querySelector('[data-do="discard"]');
            if (!go.disabled) break;
            if (!btn) throw new Error('cannot pick enough cards');
            tap(btn);
          }
          tap(d.querySelector('[data-do="discard"]'));`, 'discard');
        actions++;
      }
      continue;
    }

    const ph = phones[g.current];
    await synced(ph);
    if (g.phase === 'setup' || g.phase === 'moveRaider') {
      await step(ph, tapPickAndConfirm, g.phase);
    } else if (g.phase === 'roll') {
      await step(ph, `tap(d.querySelector('[data-do="roll"]'))`, 'roll');
    } else if (g.phase === 'steal') {
      await step(ph, `tap(d.querySelector('[data-do="steal"]'))`, 'steal');
    } else if (g.phase === 'main') {
      // Try one player-to-player trade through the phones.
      const me = g.current;
      const other = (me + 1) % 3;
      const hands = g.players;
      const give = Object.keys(hands[me]).find((r) => hands[me][r] > 0);
      const want = give && Object.keys(hands[other]).find((r) => r !== give && hands[other][r] > 0);
      if (!tradedBetweenPlayers && give && want && g.turn > 2) {
        await step(ph, `
          tap(d.querySelector('[data-do="openTrade"]'));
          tap(d.querySelector('[data-do="tab"][data-tab="players"]'));
          tap(d.querySelector('[data-bag="offerGive"][data-res="${give}"][data-delta="1"]'));
          tap(d.querySelector('[data-bag="offerWant"][data-res="${want}"][data-delta="1"]'));
          tap(d.querySelector('[data-do="offer"]'));`, 'offer trade');
        await synced(phones[other]);
        const offerShown = await phones[other].run(`return !!d.querySelector('.offer [data-do="accept"]:not([disabled])')`);
        assert.ok(offerShown, 'the other phone sees the offer with Accept enabled');
        const tvShows = await host.run(`return !!d.querySelector('.trade-box')`);
        assert.ok(tvShows, 'TV shows the open offer');
        await step(phones[other], `tap(d.querySelector('[data-do="accept"]'))`, 'accept trade');
        const after = await hostGame();
        assert.equal(after.trade, null);
        assert.equal(after.players[other][give], hands[other][give] + 1);
        tradedBetweenPlayers = true;
        await synced(ph);
        await ph.run(`tap(d.querySelector('[data-do="closeTrade"]'))`);
        console.log(`Turn ${g.turn}: ${names[me]} traded 1 ${give} for 1 ${want} with ${names[other]} via phones`);
        actions += 2;
        continue;
      }
      const items = ['colony', 'outpost', 'conduit'];
      let built = false;
      for (const item of items) {
        const enabled = await ph.run(`const b = d.querySelector('[data-do="build"][data-item="${item}"]'); return !!b && !b.disabled`);
        if (!enabled) continue;
        await ph.run(`tap(d.querySelector('[data-do="build"][data-item="${item}"]'))`);
        built = await step(ph, tapPickAndConfirm, `build ${item}`);
        if (built) break;
        await ph.run(`const c = d.querySelector('[data-do="cancelPick"]'); c && tap(c);`);
      }
      if (!built) {
        // Bank trade through the phone when one resource piles up.
        const traded = await step(ph, `
          tap(d.querySelector('[data-do="openTrade"]'));
          const tab = d.querySelector('[data-do="tab"][data-tab="bank"]'); tap(tab);
          const gives = [...d.querySelectorAll('[data-do="bankGive"]')].filter(b => !b.disabled);
          if (!gives.length) { tap(d.querySelector('[data-do="closeTrade"]')); return false; }
          const give = gives[0].dataset.res;
          tap(gives[0]);
          const counts = Object.fromEntries([...d.querySelectorAll('.hand .chip')].map((c, i) => [['ice','carbon','metal','crystal','biomass'][i], Number(c.querySelector('.chip-n').textContent)]));
          const get = Object.keys(counts).filter(r => r !== give).sort((a, b) => counts[a] - counts[b])[0];
          tap(d.querySelector('[data-do="bankGet"][data-res="' + get + '"]'));
          tap(d.querySelector('[data-do="bankTrade"]'));`, 'bank trade');
        if (!traded) await step(ph, `tap(d.querySelector('[data-do="endTurn"]'))`, 'end turn');
        else await synced(ph);
        if (traded) await ph.run(`const c = d.querySelector('[data-do="closeTrade"]'); c && tap(c);`);
      }
    }
    actions++;
  }

  const end = await hostGame();
  assert.equal(end.phase, 'gameover', 'game reached a winner');
  assert.ok(tradedBetweenPlayers, 'a player trade happened');
  assert.ok(reconnected && resumed, 'reconnect and resume paths ran');
  const overlay = await host.run(`return d.querySelector('.winner h1')?.textContent`);
  assert.match(overlay, /wins!/);
  for (const ph of phones) await synced(ph);
  const phoneEnd = await phones[end.winner].run(`return d.querySelector('.panel .big')?.textContent`);
  assert.equal(phoneEnd, 'You win!');
  console.log(`Winner: ${overlay} after ${end.turn} turns and ${actions} phone actions (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // Back to the lobby from a phone.
  await phones[0].run(`tap(d.querySelector('[data-do="newGame"]'))`);
  await until(() => host.run('return hf.app.game === null && !!d.getElementById("startBtn")'), 'back to lobby');
  console.log('Play again returns everyone to the lobby');

  await host.worker.terminate();
  for (const ph of phones) await ph.worker.terminate();
  console.log('UI smoke test passed');
  process.exit(0);
}

if (!isMainThread) {
  await runPage();
} else {
  await main();
}
