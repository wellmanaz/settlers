// Realtime link between the TV (host) and the phones (clients).
//
// mode "auto"  (default): each phone first tries a direct WebRTC link (PeerJS). If that
//                doesn't open within a few seconds, which happens when the router keeps
//                devices apart or the phone is on mobile data, the phone switches to a
//                relay through a free public MQTT broker over secure WebSockets.
//                The TV listens on both, so phones can mix.
// mode "peer"  : direct WebRTC links only.
// mode "relay" : relay only.
// mode "local" : BroadcastChannel between tabs of one browser. For testing
//                on a single computer: open the TV page and several phone tabs.
//
// Everything here works from static hosting such as GitHub Pages.

const ID_PREFIX = 'hexfront-v1-';
const TOPIC_PREFIX = 'hexfront/v1/';
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const MQTT_SRC = 'vendor/mqtt-5.16.1.min.js';

// STUN finds each device's public address; TURN relays traffic when no direct path exists.
// The TURN entry is the free relay that PeerJS itself ships as its default. It is not
// guaranteed to be up, which is why the MQTT relay below exists.
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

// Free public MQTT brokers that accept secure WebSocket connections without an account.
// The TV listens on all of them; a phone uses the first one where the TV answers.
export const RELAY_URLS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const DIRECT_TIMEOUT_MS = 9000; // per stage: reach the matchmaking server, then open the data channel
const RELAY_STEP_MS = 9000; // per relay server: connect, then hear back from the TV

export function makeRoomCode(len = 5) {
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

export function cleanRoomCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
}

export function netMode() {
  const p = new URLSearchParams(location.search).get('net');
  return ['local', 'peer', 'relay'].includes(p) ? p : 'auto';
}

// Optional ?relay=wss://host/path to use one specific broker (for example a private one).
export function relayOverride() {
  const p = new URLSearchParams(location.search).get('relay');
  return p && /^wss?:\/\/[^\s"'<>]+$/.test(p) ? p : null;
}

const relayUrls = () => (relayOverride() ? [relayOverride()] : RELAY_URLS);
const hostId = (room) => ID_PREFIX + room;
const topicBase = (room) => TOPIC_PREFIX + room;
const randomTag = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

let mqttLoading = null;
function loadMqtt() {
  if (window.mqtt) return Promise.resolve(window.mqtt);
  if (!mqttLoading) {
    mqttLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MQTT_SRC;
      s.onload = () => (window.mqtt ? resolve(window.mqtt) : reject(new Error('relay library missing')));
      s.onerror = () => { mqttLoading = null; reject(new Error('relay library failed to load')); };
      document.head.appendChild(s);
    });
  }
  return mqttLoading;
}

const parse = (payload) => {
  try { return JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload)); } catch { return null; }
};

// ---------- host ----------

// handlers: onReady(), onMessage(connId, msg), onLeave(connId),
//           onStatus(text, ok), onNotice(text)  (a short-lived event to show on the TV)
export function createHost(room, mode, handlers) {
  if (mode === 'local') return localHost(room, handlers);
  if (mode === 'peer') {
    return peerHost(room, { ...handlers, onStatus: (s) => handlers.onStatus?.(s.ok ? 'Online: phones can join' : `Not online: ${s.text}`, s.ok) });
  }
  if (mode === 'relay') {
    return relayHost(room, { ...handlers, onStatus: (s) => handlers.onStatus?.(s.ok ? `Online through the relay (${s.up} of ${s.total} servers)` : `Not online: ${s.text}`, s.ok) });
  }
  return autoHost(room, handlers);
}

function autoHost(room, h) {
  let peerState = { ok: false, text: 'contacting the matchmaking server…' };
  let relayState = { ok: false, up: 0, total: relayUrls().length, text: 'contacting relay servers…' };
  const report = () => {
    const p = peerState;
    const r = relayState;
    let text;
    if (p.ok && r.ok) text = 'Online: phones can join';
    else if (p.ok) text = `Online with direct links only. Relay: ${r.text}`;
    else if (r.ok) text = `Online through the relay. Direct links: ${p.text}`;
    else text = `Not online yet. Direct links: ${p.text} Relay: ${r.text}`;
    h.onStatus?.(text, p.ok || r.ok);
  };
  const peer = peerHost(room, { ...h, onStatus: (s) => { peerState = s; report(); } });
  const relay = relayHost(room, { ...h, onStatus: (s) => { relayState = s; report(); } });
  report();
  return {
    send(connId, msg) { (connId.startsWith('r') ? relay : peer).send(connId, msg); },
    close() { peer.close(); relay.close(); },
  };
}

function localHost(room, h) {
  const ch = new BroadcastChannel(hostId(room));
  ch.onmessage = ({ data }) => {
    if (!data || data.to !== 'host') return;
    if (data.kind === 'msg') h.onMessage(data.from, data.msg);
    if (data.kind === 'bye') h.onLeave(data.from);
  };
  setTimeout(() => {
    h.onStatus?.('Local test mode (same browser only)', true);
    h.onReady?.();
    // Phones from before a TV reload never see a disconnect here, so ask them all to rejoin.
    ch.postMessage({ to: '*', kind: 'msg', msg: { t: 'who' } });
  }, 0);
  return {
    send(connId, msg) { ch.postMessage({ to: connId, kind: 'msg', msg }); },
    close() { ch.close(); },
  };
}

// onStatus receives { ok, text }. Connection ids start with "p:".
function peerHost(room, h) {
  const conns = new Map();
  let peer = null;
  let closed = false;
  let retries = 0;
  const status = (ok, text) => h.onStatus?.({ ok, text });

  const start = () => {
    if (!window.Peer) { status(false, 'the PeerJS library failed to load.'); return; }
    peer = new window.Peer(hostId(room), { debug: 1, config: { iceServers: ICE_SERVERS } });
    peer.on('open', () => {
      retries = 0;
      status(true, 'ready.');
      h.onReady?.();
    });
    peer.on('connection', (conn) => {
      const id = `p:${conn.peer}:${conn.connectionId}`;
      let opened = false;
      let warned = false;
      const warn = () => {
        if (opened || warned || closed) return;
        warned = true;
        h.onNotice?.("A phone can't open a direct link on this network, so it will switch to the relay.");
      };
      h.onNotice?.('A phone found the TV and is opening a direct link…');
      // Shortly before the phone gives up and switches, so the relay notice comes after this one.
      const slow = setTimeout(warn, DIRECT_TIMEOUT_MS - 2000);
      conn.on('iceStateChanged', (state) => { if (state === 'failed') warn(); });
      conn.on('open', () => { opened = true; clearTimeout(slow); conns.set(id, conn); });
      conn.on('data', (msg) => { conns.set(id, conn); h.onMessage(id, msg); });
      const gone = () => {
        clearTimeout(slow);
        if (!opened) warn(); // the phone gave up on the direct link
        if (conns.delete(id)) h.onLeave(id);
      };
      conn.on('close', gone);
      conn.on('error', gone);
    });
    peer.on('disconnected', () => {
      if (closed) return;
      status(false, 'lost the matchmaking server, retrying…');
      setTimeout(() => { if (!closed && peer && !peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on('error', (err) => {
      if (closed) return;
      if (err.type === 'unavailable-id' && retries < 10) {
        // A refreshed TV page can find its old room id still held for a few seconds.
        retries++;
        status(false, 'reclaiming the room code…');
        peer.destroy();
        setTimeout(start, 3000);
        return;
      }
      if (err.type === 'peer-unavailable') return; // about one phone, not the TV
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        status(false, `can't reach the matchmaking server (${err.type}), retrying…`);
        return;
      }
      status(false, `error (${err.type || err.message}).`);
    });
  };
  start();

  return {
    send(connId, msg) {
      const c = conns.get(connId);
      if (c && c.open) c.send(msg);
    },
    close() { closed = true; peer?.destroy(); },
  };
}

// onStatus receives { ok, up, total, text }. Connection ids start with "r<broker index>:".
//
// Topics, all under hexfront/v1/<ROOM>:
//   /h        phones -> TV     {k:'hello'|'msg'|'bye', f:<phone tag>, m:<message>}
//   /c/<tag>  TV -> one phone  {k:'welcome'|'msg', m:<message>}
//   /all      TV -> phones     {k:'msg', m:{t:'who'}} after the TV (re)connects, {k:'gone'} when it leaves
function relayHost(room, h) {
  const urls = relayUrls();
  const base = topicBase(room);
  const clients = [];
  const up = new Set();
  let closed = false;
  let failure = '';
  const status = () => {
    const ok = up.size > 0;
    let text;
    if (ok) text = `ready (${up.size} of ${urls.length} servers).`;
    else if (failure) text = failure;
    else text = 'contacting relay servers…';
    h.onStatus?.({ ok, up: up.size, total: urls.length, text });
  };
  const goneMsg = JSON.stringify({ k: 'gone' });
  const sayGone = () => clients.forEach((c) => { try { if (c.connected) c.publish(`${base}/all`, goneMsg); } catch { /* ignore */ } });

  loadMqtt().then((mqtt) => {
    if (closed) return;
    urls.forEach((url, i) => {
      const c = mqtt.connect(url, {
        clientId: `hxtv-${randomTag()}`,
        forceNativeWebSocket: true,
        timerVariant: 'native', // plain timers: the default spins up a Blob-URL worker, which some browsers refuse
        clean: true,
        keepalive: 30,
        connectTimeout: 8000,
        reconnectPeriod: 4000,
        will: { topic: `${base}/all`, payload: goneMsg, qos: 0, retain: false },
      });
      clients.push(c);
      c.on('connect', () => {
        c.subscribe(`${base}/h`, { qos: 0 }, (err) => {
          if (err || closed) return;
          up.add(i);
          status();
          h.onReady?.();
          // Phones that were linked before a TV reload re-introduce themselves.
          c.publish(`${base}/all`, JSON.stringify({ k: 'msg', m: { t: 'who' } }));
        });
      });
      const down = () => { if (up.delete(i)) status(); };
      c.on('close', down);
      c.on('offline', down);
      c.on('error', () => { /* 'close' follows */ });
      c.on('message', (topic, payload) => {
        const d = parse(payload);
        if (!d || typeof d.f !== 'string' || !/^[0-9a-f]{6,32}$/.test(d.f)) return;
        const id = `r${i}:${d.f}`;
        if (d.k === 'hello') {
          h.onNotice?.('A phone is connecting through the relay…');
          c.publish(`${base}/c/${d.f}`, JSON.stringify({ k: 'welcome' }));
        } else if (d.k === 'msg') {
          h.onMessage(id, d.m);
        } else if (d.k === 'bye') {
          h.onLeave(id);
        }
      });
    });
    window.addEventListener('pagehide', sayGone);
    setTimeout(() => { if (!closed && !up.size) { failure = "can't reach any relay server."; status(); } }, 15000);
  }).catch((err) => {
    failure = `${err.message}.`;
    status();
  });
  status();

  return {
    send(connId, msg) {
      const m = /^r(\d+):([0-9a-f]+)$/.exec(connId);
      const c = m && clients[Number(m[1])];
      if (c && c.connected) c.publish(`${base}/c/${m[2]}`, JSON.stringify({ k: 'msg', m: msg }));
    },
    close() {
      closed = true;
      window.removeEventListener('pagehide', sayGone);
      sayGone();
      clients.forEach((c) => c.end(false));
    },
  };
}

// ---------- client (phone) ----------

// handlers: onOpen(how), onMessage(msg), onClose(reason), onStatus(text)
// how is 'direct', 'relay' or 'local'. reason is 'left' when the phone closed it itself.
export function createClient(room, mode, handlers) {
  if (mode === 'local') return localClient(room, handlers);
  if (mode === 'peer') return peerClient(room, handlers);
  if (mode === 'relay') return relayClient(room, handlers);
  return autoClient(room, handlers);
}

// Once a direct link has failed on this page, later reconnects go straight to the relay.
let directFailed = false;

function autoClient(room, h) {
  let cur = null;
  let opened = false;
  let closed = false;
  const onOpen = (how) => { opened = true; h.onOpen?.(how); };
  const startRelay = (why) => {
    if (closed) return;
    directFailed = true;
    h.onStatus?.(`${why} Switching to the relay…`);
    cur = relayClient(room, { ...h, onOpen });
  };
  if (directFailed) {
    startRelay('The direct link failed earlier.');
  } else {
    cur = peerClient(room, {
      ...h,
      onOpen,
      onClose: (reason) => {
        if (opened || reason === 'left') { h.onClose?.(reason); return; }
        startRelay(reason);
      },
    });
  }
  return {
    send(msg) { cur?.send(msg); },
    close() { closed = true; cur?.close(); },
    get open() { return !!cur && cur.open; },
  };
}

function localClient(room, h) {
  const me = `local-${Math.random().toString(36).slice(2, 10)}`;
  const ch = new BroadcastChannel(hostId(room));
  ch.onmessage = ({ data }) => {
    if (data && (data.to === me || data.to === '*') && data.kind === 'msg') h.onMessage(data.msg);
  };
  const bye = () => ch.postMessage({ to: 'host', from: me, kind: 'bye' });
  window.addEventListener('pagehide', bye);
  setTimeout(() => h.onOpen?.('local'), 0);
  return {
    send(msg) { ch.postMessage({ to: 'host', from: me, kind: 'msg', msg }); },
    close() { bye(); ch.close(); window.removeEventListener('pagehide', bye); },
    get open() { return true; },
  };
}

function peerClient(room, h) {
  let conn = null;
  let done = false;
  let timer = null;
  if (!window.Peer) {
    setTimeout(() => h.onClose?.('The direct-link library failed to load.'), 0);
    return { send() {}, close() {}, get open() { return false; } };
  }
  h.onStatus?.('Reaching the matchmaking server…');
  const peer = new window.Peer({ debug: 1, config: { iceServers: ICE_SERVERS } });
  const finish = (reason) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { peer.destroy(); } catch { /* ignore */ }
    h.onClose?.(reason);
  };
  timer = setTimeout(() => finish("Couldn't reach the matchmaking server."), DIRECT_TIMEOUT_MS);
  peer.on('open', () => {
    clearTimeout(timer);
    if (done) return;
    h.onStatus?.(`Looking for the TV in room ${room}…`);
    conn = peer.connect(hostId(room), { reliable: true, serialization: 'json' });
    // Before this fix a link that never opened left the phone waiting forever.
    timer = setTimeout(() => finish("A direct link to the TV didn't open."), DIRECT_TIMEOUT_MS);
    conn.on('iceStateChanged', (state) => {
      if (state === 'checking') h.onStatus?.('Found the TV. Opening a direct link…');
      if (state === 'failed') finish('A direct link to the TV is blocked on this network.');
    });
    conn.on('open', () => { clearTimeout(timer); if (!done) h.onOpen?.('direct'); });
    conn.on('data', (msg) => { if (!done) h.onMessage(msg); });
    conn.on('close', () => finish('The direct link closed.'));
    conn.on('error', () => finish('The direct link failed.'));
  });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') finish(`The matchmaking server doesn't know room ${room}.`);
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) finish("Couldn't reach the matchmaking server.");
    else finish(`Direct link error (${err.type}).`);
  });
  peer.on('disconnected', () => {
    // Losing the broker is fine once the data channel is up.
    if (!conn || !conn.open) finish('Lost the matchmaking server.');
  });
  return {
    send(msg) { if (conn && conn.open) conn.send(msg); },
    close() { finish('left'); },
    get open() { return !done && !!conn && conn.open; },
  };
}

function relayClient(room, h) {
  const urls = relayUrls();
  const base = topicBase(room);
  const tag = randomTag();
  let client = null;
  let idx = -1;
  let reached = 0;
  let open = false;
  let done = false;
  let stepTimer = null;
  let helloTimer = null;

  const stopClient = () => {
    clearTimeout(stepTimer);
    clearInterval(helloTimer);
    const c = client;
    client = null;
    if (c) {
      if (open && c.connected) { try { c.publish(`${base}/h`, JSON.stringify({ k: 'bye', f: tag })); } catch { /* ignore */ } }
      c.end(false);
    }
  };
  const finish = (reason) => {
    if (done) return;
    stopClient();
    done = true;
    open = false;
    h.onClose?.(reason);
  };

  const tryNext = (mqtt) => {
    stopClient();
    if (done) return;
    idx++;
    if (idx >= urls.length) {
      finish(reached
        ? `The TV didn't answer in room ${room}. Check the code on the TV, and that the TV page is open and says it's online.`
        : "Couldn't reach a relay server from this phone. Check its internet connection.");
      return;
    }
    h.onStatus?.(`Trying relay server ${idx + 1} of ${urls.length}…`);
    const c = mqtt.connect(urls[idx], {
      clientId: `hxph-${tag}-${idx}`,
      forceNativeWebSocket: true,
      timerVariant: 'native', // plain timers: the default spins up a Blob-URL worker, which some browsers refuse
      clean: true,
      keepalive: 20,
      connectTimeout: 6000,
      reconnectPeriod: 0,
      will: { topic: `${base}/h`, payload: JSON.stringify({ k: 'bye', f: tag }), qos: 0, retain: false },
    });
    client = c;
    stepTimer = setTimeout(() => { if (client === c && !open) tryNext(mqtt); }, RELAY_STEP_MS);
    c.on('connect', () => {
      if (client !== c) return;
      reached++;
      h.onStatus?.(`Relay server ${idx + 1} reached. Looking for the TV in room ${room}…`);
      c.subscribe([`${base}/c/${tag}`, `${base}/all`], { qos: 0 }, (err) => {
        if (err || client !== c) return;
        const hello = () => { if (c.connected) c.publish(`${base}/h`, JSON.stringify({ k: 'hello', f: tag })); };
        hello();
        helloTimer = setInterval(hello, 1500);
      });
    });
    c.on('message', (topic, payload) => {
      if (client !== c) return;
      const d = parse(payload);
      if (!d) return;
      if (d.k === 'welcome' && !open) {
        open = true;
        clearTimeout(stepTimer);
        clearInterval(helloTimer);
        h.onOpen?.('relay');
      } else if (d.k === 'msg' && open) {
        h.onMessage(d.m);
      } else if (d.k === 'gone' && open) {
        finish('The TV went offline.');
      }
    });
    c.on('error', () => { /* 'close' follows; handled there */ });
    c.on('close', () => {
      if (client !== c) return;
      if (open) finish('Lost the relay server.');
      else tryNext(mqtt);
    });
  };

  h.onStatus?.('Loading the relay…');
  loadMqtt().then((mqtt) => { if (!done) tryNext(mqtt); })
    .catch((err) => finish(`The relay could not start: ${err.message}.`));

  return {
    send(msg) {
      if (open && client && client.connected) client.publish(`${base}/h`, JSON.stringify({ k: 'msg', f: tag, m: msg }));
    },
    close() { finish('left'); },
    get open() { return open && !!client && client.connected; },
  };
}
