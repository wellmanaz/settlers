// Network test: the real connection code in js/net.js against a real WebRTC stack
// (node-datachannel), a local PeerJS matchmaking server and a local MQTT broker.
// Each scenario runs in its own process because net.js remembers a failed direct link.
//
//   npm install && npm run test:net
//
// Scenarios: direct (phone links straight to the TV), fallback (direct link blocked,
// phone switches to the relay), no-tv (wrong room gives a clear error), relay-only-tv
// (matchmaking server down, everyone uses the relay), tv-reload (phones notice the TV
// leaving and rejoin when it is back).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIOS = ['direct', 'fallback', 'no-tv', 'relay-only-tv', 'tv-reload'];
const scenario = process.argv[2];

if (!scenario) {
  let failed = 0;
  for (const s of SCENARIOS) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), s], { encoding: 'utf8', timeout: 90000 });
    const line = (r.stdout || '').split('\n').find((l) => /PASS|FAIL/.test(l)) || `FAIL: no result (${r.status})\n${r.stderr}`;
    console.log(`${s.padEnd(14)} ${line.trim()}`);
    if (!/PASS/.test(line)) { failed++; process.stdout.write(r.stdout || ''); }
  }
  console.log(failed ? `${failed} network scenario(s) failed` : 'All network scenarios passed');
  process.exit(failed ? 1 : 0);
}

const poly = (await import('node-datachannel/polyfill')).default;
const { WebSocketServer, createWebSocketStream } = await import('ws');
const { ExpressPeerServer } = await import('peer');
const express = (await import('express')).default;
const aedes = (await import('aedes')).default();
const repo = ROOT;
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`, ...a);

// PeerJS broker on 9000
const app = express();
const srv = http.createServer(app);
app.use('/', ExpressPeerServer(srv, { path: '/' }));
await new Promise((r) => srv.listen(9000, '127.0.0.1', r));
// MQTT over WebSocket on 9001
const msrv = http.createServer();
const wss = new WebSocketServer({ server: msrv });
wss.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
await new Promise((r) => msrv.listen(9001, '127.0.0.1', r));

globalThis.window = globalThis;
globalThis.self = globalThis;
const listeners = {};
globalThis.addEventListener = (k, f) => { (listeners[k] ||= []).push(f); };
globalThis.removeEventListener = (k, f) => { listeners[k] = (listeners[k] || []).filter((x) => x !== f); };
globalThis.location = { search: '?relay=ws://127.0.0.1:9001/mqtt', protocol: 'http:', href: 'http://localhost/' };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36', platform: 'Linux' }, configurable: true });
// Node's own WebSocket is the native kind that the mqtt browser bundle insists on.
for (const k of Object.keys(poly)) if (k !== 'default') globalThis[k] = poly[k];
// A peer connection created with config.__block learns no candidates and offers none,
// like a phone whose network can't reach the TV directly.
const BasePC = poly.RTCPeerConnection;
globalThis.RTCPeerConnection = class extends BasePC {
  constructor(cfg) {
    super(cfg);
    if (cfg && cfg.__block) {
      Object.defineProperty(this, 'onicecandidate', { get: () => null, set: () => {}, configurable: true });
      this.addIceCandidate = async () => {};
      const srd = this.setRemoteDescription.bind(this);
      this.setRemoteDescription = (d) => srd({ type: d.type, sdp: String(d.sdp).split(/\r?\n/).filter((l) => !l.startsWith('a=candidate')).join('\r\n') });
    }
  }
};
vm.runInThisContext(fs.readFileSync(`${repo}/vendor/peerjs-1.5.5.min.js`, 'utf8'));
vm.runInThisContext(fs.readFileSync(`${repo}/vendor/mqtt-5.16.1.min.js`, 'utf8'));
if (!window.mqtt) throw new Error('mqtt bundle did not define window.mqtt');
const RealPeer = window.Peer;
let blockDirect = false;
let noPeerBroker = false;
window.Peer = class extends RealPeer {
  constructor(id, opts) {
    if (typeof id === 'object') { opts = id; id = undefined; }
    const o = { ...(opts || {}), host: '127.0.0.1', port: noPeerBroker ? 9 : 9000, path: '/', secure: false };
    if (noPeerBroker) o.pingInterval = 1000;
    // Simulate a network where devices can't reach each other: the phone gathers no candidates.
    if (!id && blockDirect) o.config = { ...(o.config || {}), __block: true };
    super(id, o);
  }
};

let n = 0;
const fresh = () => import(`${repo}/js/net.js?i=${n++}`);
const fail = (why) => { log('FAIL:', why); process.exit(1); };
const pass = (why) => { log('PASS:', why); process.exit(0); };
setTimeout(() => fail('scenario timed out'), 60000);

function startHost(net, mode = 'auto', room = 'ROOMA') {
  const hs = { statuses: [], notices: [], msgs: [], leaves: [] };
  hs.net = net.createHost(room, mode, {
    onReady: () => {},
    onMessage: (id, m) => {
      hs.msgs.push([id, m]);
      log('TV got', id.slice(0, 12), JSON.stringify(m));
      if (m.t === 'join') hs.net.send(id, { t: 'joined', seat: 0 });
      if (m.t === 'ping') hs.net.send(id, { t: 'pong' });
    },
    onLeave: (id) => { hs.leaves.push(id); log('TV leave', id.slice(0, 12)); },
    onStatus: (text, ok) => { hs.statuses.push([text, ok]); log('TV status', ok ? 'OK ' : 'BAD', text); },
    onNotice: (text) => { hs.notices.push(text); log('TV notice', text); },
  });
  return hs;
}

function startPhone(net, mode = 'auto', room = 'ROOMA') {
  const ps = { steps: [], got: [] };
  ps.done = new Promise((resolve) => {
    ps.c = net.createClient(room, mode, {
      onOpen: (how) => { ps.how = how; log('phone open via', how); ps.c.send({ t: 'join', clientId: 'c1', name: 'Ana' }); },
      onStatus: (t) => { ps.steps.push(t); log('phone step', t); },
      onMessage: (m) => { ps.got.push(m); log('phone got', JSON.stringify(m)); if (m.t === 'joined') resolve('joined'); },
      onClose: (r) => { ps.closed = r; log('phone closed:', r); resolve('closed'); },
    });
  });
  return ps;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await wait(100); } return false; };

const net = await fresh();
if (scenario === 'direct') {
  const tv = startHost(net);
  await until(() => tv.statuses.some(([t]) => t === 'Online: phones can join'));
  const ph = startPhone(net);
  const r = await ph.done;
  if (r !== 'joined' || ph.how !== 'direct') fail(`expected direct join, got ${r} via ${ph.how}`);
  pass(`joined directly in ${ph.steps.length} steps`);
} else if (scenario === 'fallback') {
  const tv = startHost(net);
  await until(() => tv.statuses.some(([t]) => t === 'Online: phones can join'));
  blockDirect = true;
  const ph = startPhone(net);
  const r = await ph.done;
  if (r !== 'joined' || ph.how !== 'relay') fail(`expected relay join, got ${r} via ${ph.how}: ${ph.closed}`);
  ph.c.send({ t: 'ping' });
  if (!(await until(() => ph.got.some((m) => m.t === 'pong'), 5000))) fail('no pong over relay');
  if (!tv.notices.some((t) => /can't open a direct link/.test(t))) fail('TV never said the direct link failed');
  // Reconnect skips the direct attempt now.
  ph.c.close();
  if (!(await until(() => tv.leaves.length > 0, 5000))) fail('TV did not see the phone leave');
  const ph2 = startPhone(net);
  const r2 = await ph2.done;
  if (r2 !== 'joined' || ph2.how !== 'relay' || ph2.steps.some((s) => /matchmaking/.test(s))) fail('reconnect did not go straight to relay');
  pass('blocked direct link fell back to relay; reconnect went straight to relay');
} else if (scenario === 'no-tv') {
  const ph = startPhone(net, 'auto', 'NOSUCH');
  const r = await ph.done;
  if (r !== 'closed') fail('expected failure');
  if (!/didn't answer in room NOSUCH/.test(ph.closed)) fail(`unexpected reason: ${ph.closed}`);
  pass(`clear error: ${ph.closed}`);
} else if (scenario === 'relay-only-tv') {
  // Matchmaking server unreachable for everyone: TV still comes online through the relay.
  noPeerBroker = true;
  const tv = startHost(net);
  await until(() => tv.statuses.some(([t, ok]) => ok && /through the relay/.test(t)), 20000) || fail('TV not online via relay');
  const ph = startPhone(net);
  const r = await ph.done;
  if (r !== 'joined' || ph.how !== 'relay') fail(`expected relay join, got ${r} via ${ph.how}`);
  pass('phone joined through relay with the matchmaking server down');
} else if (scenario === 'tv-reload') {
  let tv = startHost(net, 'relay');
  await until(() => tv.statuses.some(([, ok]) => ok));
  const ph = startPhone(net, 'relay');
  if ((await ph.done) !== 'joined') fail('first join failed');
  tv.net.close(); // TV page goes away: phones hear "gone"
  if (!(await until(() => ph.closed === 'The TV went offline.', 5000))) fail(`phone did not notice the TV leaving (${ph.closed})`);
  tv = startHost(net, 'relay');
  await until(() => tv.statuses.some(([, ok]) => ok));
  const ph2 = startPhone(net, 'relay');
  if ((await ph2.done) !== 'joined') fail('rejoin after TV restart failed');
  pass('phone saw the TV go offline and rejoined after it came back');
} else {
  fail(`unknown scenario ${scenario}`);
}
