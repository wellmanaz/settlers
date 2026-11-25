// Realtime link between the TV (host) and the phones (clients).
//
// mode "peer"  : WebRTC data channels. Signalling goes through the free public
//                PeerJS broker (0.peerjs.com); game traffic then flows directly
//                between the devices (via PeerJS's public TURN relay if needed).
//                Works from static hosting such as GitHub Pages.
// mode "local" : BroadcastChannel between tabs of one browser. For testing
//                on a single computer: open the TV page and several phone tabs.

const ID_PREFIX = 'hexfront-v1-';
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

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
  return p === 'local' ? 'local' : 'peer';
}

const hostId = (room) => ID_PREFIX + room;

// ---------- host ----------

// handlers: onReady(), onMessage(connId, msg), onLeave(connId), onStatus(text, ok)
export function createHost(room, mode, handlers) {
  return mode === 'local' ? localHost(room, handlers) : peerHost(room, handlers);
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

function peerHost(room, h) {
  const conns = new Map();
  let peer = null;
  let closed = false;
  let retries = 0;

  const start = () => {
    if (!window.Peer) { h.onStatus?.('PeerJS failed to load', false); return; }
    peer = new window.Peer(hostId(room), { debug: 1 });
    peer.on('open', () => {
      retries = 0;
      h.onStatus?.('Online: phones can join', true);
      h.onReady?.();
    });
    peer.on('connection', (conn) => {
      const id = `${conn.peer}:${conn.connectionId}`;
      conn.on('open', () => conns.set(id, conn));
      conn.on('data', (msg) => { conns.set(id, conn); h.onMessage(id, msg); });
      const gone = () => { if (conns.delete(id)) h.onLeave(id); };
      conn.on('close', gone);
      conn.on('error', gone);
    });
    peer.on('disconnected', () => {
      if (closed) return;
      h.onStatus?.('Lost the matchmaking server, retrying…', false);
      setTimeout(() => { if (!closed && peer && !peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on('error', (err) => {
      if (closed) return;
      if (err.type === 'unavailable-id' && retries < 10) {
        // A refreshed TV page can find its old room id still held for a few seconds.
        retries++;
        h.onStatus?.('Reclaiming the room code…', false);
        peer.destroy();
        setTimeout(start, 3000);
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        h.onStatus?.('Network trouble, retrying…', false);
        return;
      }
      h.onStatus?.(`Connection error: ${err.type || err.message}`, false);
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

// ---------- client (phone) ----------

// handlers: onOpen(), onMessage(msg), onClose(reason), onStatus(text, ok)
export function createClient(room, mode, handlers) {
  return mode === 'local' ? localClient(room, handlers) : peerClient(room, handlers);
}

function localClient(room, h) {
  const me = `local-${Math.random().toString(36).slice(2, 10)}`;
  const ch = new BroadcastChannel(hostId(room));
  ch.onmessage = ({ data }) => {
    if (data && (data.to === me || data.to === '*') && data.kind === 'msg') h.onMessage(data.msg);
  };
  const bye = () => ch.postMessage({ to: 'host', from: me, kind: 'bye' });
  window.addEventListener('pagehide', bye);
  setTimeout(() => h.onOpen?.(), 0);
  return {
    send(msg) { ch.postMessage({ to: 'host', from: me, kind: 'msg', msg }); },
    close() { bye(); ch.close(); window.removeEventListener('pagehide', bye); },
    get open() { return true; },
  };
}

function peerClient(room, h) {
  let conn = null;
  let done = false;
  if (!window.Peer) {
    setTimeout(() => h.onClose?.('PeerJS failed to load'), 0);
    return { send() {}, close() {}, get open() { return false; } };
  }
  const peer = new window.Peer({ debug: 1 });
  const finish = (reason) => {
    if (done) return;
    done = true;
    try { peer.destroy(); } catch { /* ignore */ }
    h.onClose?.(reason);
  };
  peer.on('open', () => {
    h.onStatus?.('Finding the TV…', false);
    conn = peer.connect(hostId(room), { reliable: true, serialization: 'json' });
    conn.on('open', () => h.onOpen?.());
    conn.on('data', (msg) => h.onMessage(msg));
    conn.on('close', () => finish('closed'));
    conn.on('error', () => finish('error'));
  });
  peer.on('error', (err) => {
    finish(err.type === 'peer-unavailable' ? 'Room not found. Check the code on the TV.' : `Connection error: ${err.type}`);
  });
  peer.on('disconnected', () => {
    // Losing the broker is fine once the data channel is up.
    if (!conn || !conn.open) finish('Lost the matchmaking server');
  });
  return {
    send(msg) { if (conn && conn.open) conn.send(msg); },
    close() { finish('left'); },
    get open() { return !!conn && conn.open; },
  };
}
