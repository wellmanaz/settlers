// Hexfront rules engine.
// Pure game logic with no DOM access, so the TV host, the phone controller
// and the Node tests all share it. The whole game state is plain JSON.

export const RESOURCES = ['ice', 'carbon', 'metal', 'crystal', 'biomass'];

export const RESOURCE_INFO = {
  ice: { name: 'Ice', color: '#7fd3f7', ink: '#0b2a3a' },
  carbon: { name: 'Carbon', color: '#4b4f5c', ink: '#f2f2f2', light: '#aab1c2' },
  metal: { name: 'Metal', color: '#c9803f', ink: '#2b1606' },
  crystal: { name: 'Crystal', color: '#b48af2', ink: '#24104a' },
  biomass: { name: 'Biomass', color: '#62c46e', ink: '#0c2b10' },
  void: { name: 'Dust cloud', color: '#2b2140', ink: '#d8d0ea' },
};

export const COSTS = {
  conduit: { carbon: 1, metal: 1 },
  outpost: { ice: 1, carbon: 1, crystal: 1, biomass: 1 },
  colony: { metal: 2, crystal: 2, ice: 1 },
};

export const ITEM_NAMES = { conduit: 'Conduit', outpost: 'Outpost', colony: 'Colony' };
export const LIMITS = { conduit: 15, outpost: 5, colony: 4 };
export const WIN_POINTS = 10;
export const LONGEST_MIN = 5;
export const DISCARD_OVER = 7;
export const PLAYER_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24'];
export const PLAYER_COLOR_NAMES = ['Cyan', 'Magenta', 'Lime', 'Amber'];

// Board shape: an oval of 4-5-6-5-4 tiles (24 tiles), pointy-top hexes in axial coords.
const ROWS = [
  { r: -2, q0: 0, len: 4 },
  { r: -1, q0: -1, len: 5 },
  { r: 0, q0: -2, len: 6 },
  { r: 1, q0: -2, len: 5 },
  { r: 2, q0: -2, len: 4 },
];
const TILE_SET = [
  ...Array(5).fill('ice'),
  ...Array(5).fill('carbon'),
  ...Array(4).fill('metal'),
  ...Array(4).fill('crystal'),
  ...Array(5).fill('biomass'),
  'void',
];
const NUMBER_SET = [2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 12];
const BEACON_SET = ['any', 'any', 'ice', 'carbon', 'metal', 'crystal', 'biomass'];
const SQ3 = Math.sqrt(3);

// ---------- random numbers (seeded, stored in state so saves replay the same) ----------

export function random(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle(state, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// ---------- board ----------

export function generateBoard(state) {
  const hexes = [];
  for (const row of ROWS) {
    for (let i = 0; i < row.len; i++) {
      const q = row.q0 + i;
      hexes.push({ id: hexes.length, q, r: row.r, x: round3(SQ3 * (q + row.r / 2)), y: round3(1.5 * row.r) });
    }
  }
  const byAxial = new Map(hexes.map((h) => [`${h.q},${h.r}`, h]));
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
  for (const h of hexes) {
    h.neighbors = dirs.map(([dq, dr]) => byAxial.get(`${h.q + dq},${h.r + dr}`)).filter(Boolean).map((n) => n.id);
  }

  // Resources.
  const tiles = shuffle(state, TILE_SET);
  hexes.forEach((h, i) => { h.res = tiles[i]; h.num = null; });

  // Numbers: no two 6/8 tiles side by side.
  const producing = hexes.filter((h) => h.res !== 'void');
  for (let attempt = 0; attempt < 2000; attempt++) {
    const nums = shuffle(state, NUMBER_SET);
    producing.forEach((h, i) => { h.num = nums[i]; });
    const hot = (h) => h.num === 6 || h.num === 8;
    const clash = producing.some((h) => hot(h) && h.neighbors.some((n) => hot(hexes[n])));
    if (!clash) break;
  }

  // Vertices and edges, found by deduplicating hex corners.
  const vertices = [];
  const vKey = new Map();
  const edges = [];
  const eKey = new Map();
  for (const h of hexes) {
    h.corners = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      const x = h.x + Math.cos(ang);
      const y = h.y + Math.sin(ang);
      const key = `${Math.round(x * 100)},${Math.round(y * 100)}`;
      let v = vKey.get(key);
      if (v === undefined) {
        v = vertices.length;
        vKey.set(key, v);
        vertices.push({ id: v, x: round3(x), y: round3(y), hexes: [], adj: [], edges: [] });
      }
      vertices[v].hexes.push(h.id);
      h.corners.push(v);
    }
    for (let i = 0; i < 6; i++) {
      const a = h.corners[i];
      const b = h.corners[(i + 1) % 6];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      let e = eKey.get(key);
      if (e === undefined) {
        e = edges.length;
        eKey.set(key, e);
        edges.push({ id: e, v: [a, b], hexes: [] });
        vertices[a].adj.push(b);
        vertices[b].adj.push(a);
        vertices[a].edges.push(e);
        vertices[b].edges.push(e);
      }
      edges[e].hexes.push(h.id);
    }
  }

  // Trade beacons on outer edges, spread evenly around the rim.
  const cx = hexes.reduce((s, h) => s + h.x, 0) / hexes.length;
  const cy = hexes.reduce((s, h) => s + h.y, 0) / hexes.length;
  const mid = (e) => {
    const [a, b] = e.v.map((id) => vertices[id]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const rim = edges
    .filter((e) => e.hexes.length === 1)
    .map((e) => ({ e, ang: Math.atan2(mid(e).y - cy, mid(e).x - cx) }))
    .sort((a, b) => a.ang - b.ang)
    .map((o) => o.e.id);
  const kinds = shuffle(state, BEACON_SET);
  const step = rim.length / kinds.length;
  const offset = Math.floor(random(state) * step);
  const beacons = kinds.map((kind, i) => ({
    edge: rim[Math.floor(offset + i * step) % rim.length],
    res: kind === 'any' ? null : kind,
    rate: kind === 'any' ? 3 : 2,
  }));

  return { hexes, vertices, edges, beacons };
}

// ---------- helpers ----------

export const emptyHand = () => Object.fromEntries(RESOURCES.map((r) => [r, 0]));
export const handTotal = (hand) => RESOURCES.reduce((s, r) => s + (hand?.[r] || 0), 0);

export function canAfford(hand, cost) {
  return Object.entries(cost).every(([r, n]) => (hand?.[r] || 0) >= n);
}

function isResourceBag(bag) {
  return bag && typeof bag === 'object' && Object.entries(bag).every(
    ([r, n]) => RESOURCES.includes(r) && Number.isInteger(n) && n >= 0,
  );
}

function pay(hand, cost) {
  for (const [r, n] of Object.entries(cost)) hand[r] -= n;
}
function gain(hand, bag) {
  for (const [r, n] of Object.entries(bag)) hand[r] += n;
}

export function countPieces(state, pid) {
  const c = { conduit: 0, outpost: 0, colony: 0 };
  for (const b of Object.values(state.buildings)) if (b.owner === pid) c[b.kind]++;
  for (const o of Object.values(state.conduits)) if (o === pid) c.conduit++;
  return c;
}

export function victoryPoints(state, pid) {
  const c = countPieces(state, pid);
  return c.outpost + 2 * c.colony + (state.longest.holder === pid ? 2 : 0);
}

export function tradeRate(state, pid, res) {
  let rate = 4;
  for (const b of state.board.beacons) {
    const owns = state.board.edges[b.edge].v.some((v) => state.buildings[v]?.owner === pid);
    if (!owns) continue;
    if (b.res === null) rate = Math.min(rate, b.rate);
    else if (b.res === res) rate = Math.min(rate, b.rate);
  }
  return rate;
}

// ---------- placement rules ----------

export function canPlaceOutpost(state, pid, v, { setup = false } = {}) {
  const vert = state.board.vertices[v];
  if (!vert || state.buildings[v]) return false;
  if (vert.adj.some((a) => state.buildings[a])) return false;
  if (setup) return true;
  return vert.edges.some((e) => state.conduits[e] === pid);
}

export function canPlaceConduit(state, pid, e, { fromVertex = null } = {}) {
  const edge = state.board.edges[e];
  if (!edge || state.conduits[e] !== undefined) return false;
  if (fromVertex !== null) return edge.v.includes(fromVertex);
  return edge.v.some((w) => {
    const b = state.buildings[w];
    if (b && b.owner === pid) return true;
    if (b && b.owner !== pid) return false;
    return state.board.vertices[w].edges.some((o) => o !== e && state.conduits[o] === pid);
  });
}

export function canUpgradeColony(state, pid, v) {
  const b = state.buildings[v];
  return !!b && b.owner === pid && b.kind === 'outpost';
}

function inSetup(state) {
  return state.phase === 'setup';
}

export function legalSpots(state, pid, item) {
  const { vertices, edges } = state.board;
  if (inSetup(state)) {
    if (state.current !== pid) return [];
    if (item === 'outpost' && state.setup.step === 'outpost') {
      return vertices.filter((v) => canPlaceOutpost(state, pid, v.id, { setup: true })).map((v) => v.id);
    }
    if (item === 'conduit' && state.setup.step === 'conduit') {
      return edges.filter((e) => canPlaceConduit(state, pid, e.id, { fromVertex: state.setup.lastVertex })).map((e) => e.id);
    }
    return [];
  }
  if (item === 'outpost') return vertices.filter((v) => canPlaceOutpost(state, pid, v.id)).map((v) => v.id);
  if (item === 'conduit') return edges.filter((e) => canPlaceConduit(state, pid, e.id)).map((e) => e.id);
  if (item === 'colony') return vertices.filter((v) => canUpgradeColony(state, pid, v.id)).map((v) => v.id);
  return [];
}

export function legalRaiderHexes(state) {
  return state.board.hexes.filter((h) => h.id !== state.raider).map((h) => h.id);
}

// Why a build is not possible right now, or null if it is.
export function buildBlocker(state, pid, item) {
  if (state.phase !== 'main' || state.current !== pid) return 'Not now';
  if (!canAfford(state.players[pid].hand, COSTS[item])) return 'Need resources';
  const c = countPieces(state, pid);
  if (c[item] >= LIMITS[item]) return 'None left';
  if (legalSpots(state, pid, item).length === 0) return 'No space';
  return null;
}

// ---------- longest network ----------

export function longestConduit(state, pid) {
  const { vertices, edges } = state.board;
  const used = new Set();
  let best = 0;
  const blocked = (v) => state.buildings[v] && state.buildings[v].owner !== pid;
  const walk = (v, len) => {
    if (len > best) best = len;
    if (len > 0 && blocked(v)) return;
    for (const e of vertices[v].edges) {
      if (state.conduits[e] !== pid || used.has(e)) continue;
      used.add(e);
      const [a, b] = edges[e].v;
      walk(a === v ? b : a, len + 1);
      used.delete(e);
    }
  };
  const starts = new Set();
  for (const [e, o] of Object.entries(state.conduits)) if (o === pid) edges[e].v.forEach((v) => starts.add(v));
  for (const v of starts) walk(v, 0);
  return best;
}

function updateLongest(state) {
  const lengths = state.players.map((p) => longestConduit(state, p.id));
  const holder = state.longest.holder;
  const max = Math.max(...lengths);
  let next = null;
  if (holder !== null && lengths[holder] >= LONGEST_MIN && lengths[holder] === max) {
    next = holder;
  } else if (max >= LONGEST_MIN && lengths.filter((l) => l === max).length === 1) {
    next = lengths.indexOf(max);
  }
  if (next !== holder) {
    log(state, next === null ? 'Longest network is unclaimed' : `${state.players[next].name} takes Longest network (+2)`);
  }
  state.longest = { holder: next, length: next === null ? 0 : lengths[next] };
}

// ---------- game creation ----------

export function createGame({ players, seed = Date.now() }) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error('Hexfront needs 2 to 4 players');
  }
  const state = {
    schema: 1,
    version: 0,
    rng: seed >>> 0,
    seq: 0,
    turn: 0,
    log: [],
  };
  state.board = generateBoard(state);
  state.players = players.map((p, i) => ({
    id: i,
    name: String(p.name || `Player ${i + 1}`).slice(0, 16),
    color: p.color || PLAYER_COLORS[i],
    hand: emptyHand(),
  }));
  const n = players.length;
  const first = Math.floor(random(state) * n);
  const round = Array.from({ length: n }, (_, i) => (first + i) % n);
  state.first = first;
  state.buildings = {};
  state.conduits = {};
  state.raider = state.board.hexes.find((h) => h.res === 'void').id;
  state.phase = 'setup';
  state.setup = { order: [...round, ...round.slice().reverse()], index: 0, step: 'outpost', lastVertex: null };
  state.current = first;
  state.dice = null;
  state.production = null;
  state.discards = {};
  state.stealFrom = [];
  state.trade = null;
  state.longest = { holder: null, length: 0 };
  state.winner = null;
  log(state, `${state.players[first].name} places first`);
  return state;
}

function log(state, text) {
  state.log.push({ seq: ++state.seq, text });
  if (state.log.length > 60) state.log.shift();
}

// ---------- actions ----------

const fail = (error) => ({ ok: false, error });
const ok = () => ({ ok: true });

export function applyAction(state, pid, action) {
  if (!action || typeof action.type !== 'string') return fail('Bad action');
  if (!state.players[pid]) return fail('Unknown player');
  if (state.phase === 'gameover') return fail('The game is over');
  const handler = HANDLERS[action.type];
  if (!handler) return fail(`Unknown action ${action.type}`);
  const result = handler(state, pid, action);
  if (result.ok) state.version++;
  return result;
}

const HANDLERS = {
  build(state, pid, { item, at }) {
    if (!COSTS[item]) return fail('Unknown item');
    if (state.current !== pid) return fail('Not your turn');
    if (!Number.isInteger(at)) return fail('Pick a spot');
    const name = state.players[pid].name;

    if (state.phase === 'setup') {
      const s = state.setup;
      if (item !== s.step) return fail(`Place a ${ITEM_NAMES[s.step].toLowerCase()} now`);
      if (item === 'outpost') {
        if (!canPlaceOutpost(state, pid, at, { setup: true })) return fail('Too close to another building');
        state.buildings[at] = { owner: pid, kind: 'outpost' };
        s.lastVertex = at;
        s.step = 'conduit';
        if (s.index >= state.players.length) {
          const got = emptyHand();
          for (const h of state.board.vertices[at].hexes) {
            const res = state.board.hexes[h].res;
            if (res !== 'void') got[res]++;
          }
          gain(state.players[pid].hand, got);
        }
        log(state, `${name} placed an outpost`);
        return ok();
      }
      if (!canPlaceConduit(state, pid, at, { fromVertex: s.lastVertex })) return fail('Conduit must touch your new outpost');
      state.conduits[at] = pid;
      s.index++;
      if (s.index >= s.order.length) {
        state.setup = null;
        state.phase = 'roll';
        state.current = state.first;
        state.turn = 1;
        log(state, `Setup done. ${state.players[state.first].name} rolls first`);
      } else {
        s.step = 'outpost';
        s.lastVertex = null;
        state.current = s.order[s.index];
      }
      updateLongest(state);
      return ok();
    }

    if (state.phase !== 'main') return fail('Roll first');
    const blocker = buildBlocker(state, pid, item);
    if (blocker) return fail(blocker);
    if (item === 'outpost' && !canPlaceOutpost(state, pid, at)) return fail('Outpost must sit on your conduit, 2 steps from any building');
    if (item === 'conduit' && !canPlaceConduit(state, pid, at)) return fail('Conduit must connect to your network');
    if (item === 'colony' && !canUpgradeColony(state, pid, at)) return fail('Pick one of your outposts');
    pay(state.players[pid].hand, COSTS[item]);
    if (item === 'conduit') state.conduits[at] = pid;
    else state.buildings[at] = { owner: pid, kind: item };
    log(state, `${name} built a ${ITEM_NAMES[item].toLowerCase()}`);
    updateLongest(state);
    checkWin(state, pid);
    return ok();
  },

  roll(state, pid) {
    if (state.phase !== 'roll') return fail('Not time to roll');
    if (state.current !== pid) return fail('Not your turn');
    const d = [1 + Math.floor(random(state) * 6), 1 + Math.floor(random(state) * 6)];
    const sum = d[0] + d[1];
    state.dice = d;
    state.production = { roll: sum, gains: {} };
    log(state, `${state.players[pid].name} rolled ${sum}`);
    if (sum === 7) {
      state.discards = {};
      for (const p of state.players) {
        const t = handTotal(p.hand);
        if (t > DISCARD_OVER) state.discards[p.id] = Math.floor(t / 2);
      }
      log(state, 'Raid! Raiders strike the belt');
      state.phase = Object.keys(state.discards).length ? 'discard' : 'moveRaider';
      return ok();
    }
    for (const h of state.board.hexes) {
      if (h.num !== sum || h.id === state.raider) continue;
      for (const v of h.corners) {
        const b = state.buildings[v];
        if (!b) continue;
        const n = b.kind === 'colony' ? 2 : 1;
        state.players[b.owner].hand[h.res] += n;
        const g = (state.production.gains[b.owner] ||= {});
        g[h.res] = (g[h.res] || 0) + n;
      }
    }
    state.phase = 'main';
    return ok();
  },

  discard(state, pid, { cards }) {
    if (state.phase !== 'discard') return fail('No discard needed');
    const need = state.discards[pid];
    if (!need) return fail('You keep your cards');
    if (!isResourceBag(cards)) return fail('Bad cards');
    if (handTotal(cards) !== need) return fail(`Discard exactly ${need}`);
    if (!canAfford(state.players[pid].hand, cards)) return fail('You do not have those');
    pay(state.players[pid].hand, cards);
    delete state.discards[pid];
    log(state, `${state.players[pid].name} dumped ${need} cards`);
    if (Object.keys(state.discards).length === 0) state.phase = 'moveRaider';
    return ok();
  },

  moveRaider(state, pid, { hex }) {
    if (state.phase !== 'moveRaider') return fail('Not now');
    if (state.current !== pid) return fail('Not your turn');
    if (!state.board.hexes[hex] || hex === state.raider) return fail('Pick a different tile');
    state.raider = hex;
    const victims = new Set();
    for (const v of state.board.hexes[hex].corners) {
      const b = state.buildings[v];
      if (b && b.owner !== pid && handTotal(state.players[b.owner].hand) > 0) victims.add(b.owner);
    }
    log(state, `${state.players[pid].name} moved the raiders`);
    const list = [...victims];
    if (list.length === 0) {
      state.phase = 'main';
    } else if (list.length === 1) {
      stealFrom(state, pid, list[0]);
      state.phase = 'main';
    } else {
      state.stealFrom = list;
      state.phase = 'steal';
    }
    return ok();
  },

  steal(state, pid, { victim }) {
    if (state.phase !== 'steal') return fail('Not now');
    if (state.current !== pid) return fail('Not your turn');
    if (!state.stealFrom.includes(victim)) return fail('Pick a player next to the raiders');
    stealFrom(state, pid, victim);
    state.stealFrom = [];
    state.phase = 'main';
    return ok();
  },

  bankTrade(state, pid, { give, get }) {
    if (state.phase !== 'main' || state.current !== pid) return fail('Trade on your turn after rolling');
    if (!RESOURCES.includes(give) || !RESOURCES.includes(get) || give === get) return fail('Pick two different resources');
    const rate = tradeRate(state, pid, give);
    const hand = state.players[pid].hand;
    if (hand[give] < rate) return fail(`Need ${rate} ${RESOURCE_INFO[give].name}`);
    hand[give] -= rate;
    hand[get] += 1;
    log(state, `${state.players[pid].name} traded ${rate} ${RESOURCE_INFO[give].name} for 1 ${RESOURCE_INFO[get].name}`);
    return ok();
  },

  offerTrade(state, pid, { give, want }) {
    if (state.phase !== 'main' || state.current !== pid) return fail('Offer trades on your turn after rolling');
    if (!isResourceBag(give) || !isResourceBag(want)) return fail('Bad offer');
    if (handTotal(give) === 0 || handTotal(want) === 0) return fail('Offer and ask for at least 1 card');
    if (RESOURCES.some((r) => give[r] > 0 && want[r] > 0)) return fail('Do not offer and ask for the same resource');
    if (!canAfford(state.players[pid].hand, give)) return fail('You do not have those cards');
    state.trade = { id: state.seq + 1, from: pid, give: { ...give }, want: { ...want }, declined: [] };
    log(state, `${state.players[pid].name} offered a trade`);
    return ok();
  },

  acceptTrade(state, pid, { tradeId }) {
    const t = state.trade;
    if (!t || t.id !== tradeId) return fail('That offer is gone');
    if (t.from === pid) return fail('You made this offer');
    const me = state.players[pid].hand;
    const them = state.players[t.from].hand;
    if (!canAfford(me, t.want)) return fail('You do not have what they want');
    if (!canAfford(them, t.give)) return fail('They no longer have those cards');
    pay(them, t.give); gain(me, t.give);
    pay(me, t.want); gain(them, t.want);
    state.trade = null;
    log(state, `${state.players[pid].name} traded with ${state.players[t.from].name}`);
    return ok();
  },

  declineTrade(state, pid, { tradeId }) {
    const t = state.trade;
    if (!t || t.id !== tradeId || t.from === pid) return fail('That offer is gone');
    if (!t.declined.includes(pid)) t.declined.push(pid);
    return ok();
  },

  cancelTrade(state, pid) {
    if (!state.trade || state.trade.from !== pid) return fail('No offer to cancel');
    state.trade = null;
    return ok();
  },

  endTurn(state, pid) {
    if (state.phase !== 'main' || state.current !== pid) return fail('Not now');
    state.trade = null;
    state.current = (state.current + 1) % state.players.length;
    state.phase = 'roll';
    state.dice = null;
    state.production = null;
    state.turn++;
    log(state, `${state.players[state.current].name}'s turn`);
    return ok();
  },
};

function stealFrom(state, pid, victim) {
  const hand = state.players[victim].hand;
  const pool = RESOURCES.flatMap((r) => Array(hand[r]).fill(r));
  if (pool.length === 0) return;
  const res = pool[Math.floor(random(state) * pool.length)];
  hand[res]--;
  state.players[pid].hand[res]++;
  log(state, `${state.players[pid].name} raided ${state.players[victim].name}`);
}

function checkWin(state, pid) {
  if (victoryPoints(state, pid) >= WIN_POINTS) {
    state.winner = pid;
    state.phase = 'gameover';
    log(state, `${state.players[pid].name} wins with ${victoryPoints(state, pid)} points!`);
  }
}

// What a phone may see: everything public, its own hand, other hands as counts only.
export function publicView(state, pid) {
  const view = JSON.parse(JSON.stringify(state));
  delete view.rng;
  view.you = pid;
  for (const p of view.players) {
    p.cards = handTotal(p.hand);
    p.points = victoryPoints(state, p.id);
    if (p.id !== pid) delete p.hand;
  }
  return view;
}
