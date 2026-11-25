import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOURCES, COSTS, LIMITS, WIN_POINTS, createGame, applyAction, legalSpots, legalRaiderHexes,
  victoryPoints, tradeRate, longestConduit, publicView, random, handTotal, emptyHand,
} from '../js/engine.js';

const three = () => createGame({ players: [{ name: 'Ana' }, { name: 'Ben' }, { name: 'Cy' }], seed: 1234 });

function act(state, pid, action) {
  const r = applyAction(state, pid, action);
  assert.equal(r.ok, true, `expected ${action.type} by ${pid} to work, got: ${r.error}`);
  return r;
}

// Finish setup by placing every piece on the first legal spot.
function playSetup(state) {
  while (state.phase === 'setup') {
    const pid = state.current;
    const item = state.setup.step;
    act(state, pid, { type: 'build', item, at: legalSpots(state, pid, item)[0] });
  }
}

// Make the next roll come out as `sum`.
function rigRoll(state, sum) {
  for (let s = 0; s < 1e6; s++) {
    const probe = { rng: s };
    const a = 1 + Math.floor(random(probe) * 6);
    const b = 1 + Math.floor(random(probe) * 6);
    if (a + b === sum) { state.rng = s; return; }
  }
  throw new Error('no seed found');
}

const rich = () => Object.fromEntries(RESOURCES.map((r) => [r, 50]));

test('board is a 24-tile oval with sane numbers and beacons', () => {
  const s = three();
  const { hexes, vertices, edges, beacons } = s.board;
  assert.equal(hexes.length, 24);
  const voids = hexes.filter((h) => h.res === 'void');
  assert.equal(voids.length, 1);
  assert.equal(voids[0].num, null);
  assert.equal(s.raider, voids[0].id);
  const nums = hexes.filter((h) => h.res !== 'void').map((h) => h.num).sort((a, b) => a - b);
  assert.deepEqual(nums, [2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 12]);
  const hot = (h) => h.num === 6 || h.num === 8;
  for (const h of hexes) {
    if (hot(h)) assert.ok(!h.neighbors.some((n) => hot(hexes[n])), 'two hot numbers touch');
  }
  for (const v of vertices) {
    assert.ok(v.hexes.length >= 1 && v.hexes.length <= 3);
    assert.ok(v.adj.length >= 2 && v.adj.length <= 3);
  }
  for (const e of edges) assert.ok(e.hexes.length === 1 || e.hexes.length === 2);
  assert.equal(beacons.length, 7);
  const seen = new Set();
  for (const b of beacons) {
    assert.equal(edges[b.edge].hexes.length, 1, 'beacon not on the rim');
    for (const v of edges[b.edge].v) {
      assert.ok(!seen.has(v), 'two beacons share a corner');
      seen.add(v);
    }
  }
});

test('same seed gives the same game', () => {
  assert.deepEqual(three(), three());
  const other = createGame({ players: [{ name: 'Ana' }, { name: 'Ben' }, { name: 'Cy' }], seed: 99 });
  assert.notDeepEqual(other.board.hexes.map((h) => h.res), three().board.hexes.map((h) => h.res));
});

test('rejects fewer than 2 or more than 4 players', () => {
  assert.throws(() => createGame({ players: [{ name: 'Solo' }] }));
  assert.throws(() => createGame({ players: Array(5).fill({ name: 'x' }) }));
});

test('setup runs in snake order and the second outpost pays out', () => {
  const s = three();
  const order = s.setup.order;
  const f = s.first;
  assert.deepEqual(order, [f, (f + 1) % 3, (f + 2) % 3, (f + 2) % 3, (f + 1) % 3, f]);
  const seen = [];
  while (s.phase === 'setup') {
    const pid = s.current;
    if (s.setup.step === 'outpost') {
      seen.push(pid);
      const second = s.setup.index >= 3;
      const at = legalSpots(s, pid, 'outpost')[0];
      const before = handTotal(s.players[pid].hand);
      act(s, pid, { type: 'build', item: 'outpost', at });
      const producing = s.board.vertices[at].hexes.filter((h) => s.board.hexes[h].res !== 'void').length;
      assert.equal(handTotal(s.players[pid].hand) - before, second ? producing : 0);
    } else {
      act(s, pid, { type: 'build', item: 'conduit', at: legalSpots(s, pid, 'conduit')[0] });
    }
  }
  assert.deepEqual(seen, order);
  assert.equal(s.phase, 'roll');
  assert.equal(s.current, f);
});

test('setup enforces distance rule and conduit next to the new outpost', () => {
  const s = three();
  const pid = s.current;
  const v = legalSpots(s, pid, 'outpost')[0];
  act(s, pid, { type: 'build', item: 'outpost', at: v });
  // A conduit not touching the new outpost is refused.
  const far = s.board.edges.find((e) => !e.v.includes(v)).id;
  assert.equal(applyAction(s, pid, { type: 'build', item: 'conduit', at: far }).ok, false);
  act(s, pid, { type: 'build', item: 'conduit', at: s.board.vertices[v].edges[0] });
  // Next player cannot build right next to it.
  const next = s.current;
  const neighbor = s.board.vertices[v].adj[0];
  assert.equal(applyAction(s, next, { type: 'build', item: 'outpost', at: neighbor }).ok, false);
  assert.ok(!legalSpots(s, next, 'outpost').includes(neighbor));
});

test('failed actions do not change the state', () => {
  const s = three();
  playSetup(s);
  const before = JSON.stringify(s);
  const other = (s.current + 1) % 3;
  assert.equal(applyAction(s, other, { type: 'roll' }).ok, false);
  assert.equal(applyAction(s, s.current, { type: 'build', item: 'conduit', at: 0 }).ok, false);
  assert.equal(applyAction(s, s.current, { type: 'endTurn' }).ok, false);
  assert.equal(applyAction(s, s.current, { type: 'nonsense' }).ok, false);
  assert.equal(JSON.stringify(s), before);
});

test('a roll pays every building touching a matching tile, except under the raiders', () => {
  const s = three();
  playSetup(s);
  // Pick a number that some building touches.
  const touched = s.board.hexes.filter((h) => h.num && h.corners.some((v) => s.buildings[v]));
  const target = touched[0];
  s.raider = s.board.hexes.find((h) => h.res === 'void').id;
  const before = s.players.map((p) => ({ ...p.hand }));
  rigRoll(s, target.num);
  act(s, s.current, { type: 'roll' });
  assert.equal(s.phase, 'main');
  const expected = s.players.map(() => emptyHand());
  for (const h of s.board.hexes) {
    if (h.num !== target.num || h.id === s.raider) continue;
    for (const v of h.corners) {
      const b = s.buildings[v];
      if (b) expected[b.owner][h.res] += b.kind === 'colony' ? 2 : 1;
    }
  }
  s.players.forEach((p, i) => {
    for (const r of RESOURCES) assert.equal(p.hand[r] - before[i][r], expected[i][r]);
  });

  // Same roll with the raiders on that tile pays nothing from it.
  act(s, s.current, { type: 'endTurn' });
  s.raider = target.id;
  const others = s.board.hexes.filter((h) => h.num === target.num && h.id !== target.id);
  const snapshot = s.players.map((p) => handTotal(p.hand));
  rigRoll(s, target.num);
  act(s, s.current, { type: 'roll' });
  let expectedGain = 0;
  for (const h of others) for (const v of h.corners) if (s.buildings[v]) expectedGain += s.buildings[v].kind === 'colony' ? 2 : 1;
  const gained = s.players.reduce((sum, p, i) => sum + handTotal(p.hand) - snapshot[i], 0);
  assert.equal(gained, expectedGain);
});

test('a 7 makes big hands discard half, then raiders move and steal', () => {
  const s = three();
  playSetup(s);
  const me = s.current;
  const victim = (me + 1) % 3;
  s.players.forEach((p) => { p.hand = emptyHand(); });
  s.players[victim].hand = { ice: 5, carbon: 4, metal: 0, crystal: 0, biomass: 0 }; // 9 cards -> discard 4
  s.players[me].hand = { ice: 3, carbon: 0, metal: 0, crystal: 0, biomass: 0 };
  rigRoll(s, 7);
  act(s, me, { type: 'roll' });
  assert.equal(s.phase, 'discard');
  assert.deepEqual(s.discards, { [victim]: 4 });
  assert.equal(applyAction(s, victim, { type: 'discard', cards: { ice: 3 } }).ok, false, 'wrong count');
  assert.equal(applyAction(s, victim, { type: 'discard', cards: { metal: 4 } }).ok, false, 'cards not held');
  assert.equal(applyAction(s, me, { type: 'moveRaider', hex: 0 }).ok, false, 'must wait for discards');
  act(s, victim, { type: 'discard', cards: { ice: 2, carbon: 2 } });
  assert.equal(handTotal(s.players[victim].hand), 5);
  assert.equal(s.phase, 'moveRaider');

  assert.equal(applyAction(s, me, { type: 'moveRaider', hex: s.raider }).ok, false, 'must move');
  const victimHex = s.board.hexes.find((h) => h.corners.some((v) => s.buildings[v]?.owner === victim)
    && !h.corners.some((v) => s.buildings[v] && s.buildings[v].owner !== victim));
  assert.ok(victimHex, 'test board needs a tile touching only the victim');
  if (victimHex.id === s.raider) s.raider = legalRaiderHexes(s).find((h) => h !== victimHex.id);
  act(s, me, { type: 'moveRaider', hex: victimHex.id });
  assert.equal(s.raider, victimHex.id);
  assert.equal(s.phase, 'main');
  assert.equal(handTotal(s.players[victim].hand), 4);
  assert.equal(handTotal(s.players[me].hand), 4);
});

test('steal asks the mover to pick when several players touch the tile', () => {
  const s = three();
  playSetup(s);
  const me = s.current;
  const a = (me + 1) % 3;
  const b = (me + 2) % 3;
  s.players.forEach((p) => { p.hand = { ...emptyHand(), metal: 2 }; });
  // Force a tile with buildings from both a and b.
  const hex = s.board.hexes.find((h) => h.id !== s.raider);
  for (const v of Object.keys(s.buildings)) delete s.buildings[v];
  s.buildings[hex.corners[0]] = { owner: a, kind: 'outpost' };
  s.buildings[hex.corners[3]] = { owner: b, kind: 'outpost' };
  s.phase = 'moveRaider';
  act(s, me, { type: 'moveRaider', hex: hex.id });
  assert.equal(s.phase, 'steal');
  assert.deepEqual([...s.stealFrom].sort(), [a, b].sort());
  assert.equal(applyAction(s, me, { type: 'steal', victim: me }).ok, false);
  act(s, me, { type: 'steal', victim: b });
  assert.equal(s.players[b].hand.metal, 1);
  assert.equal(s.players[me].hand.metal, 3);
  assert.equal(s.phase, 'main');
});

test('building costs resources and follows connection rules', () => {
  const s = three();
  playSetup(s);
  const me = s.current;
  rigRoll(s, 6);
  act(s, me, { type: 'roll' });
  s.players[me].hand = emptyHand();
  const spot = legalSpots(s, me, 'conduit')[0];
  assert.equal(applyAction(s, me, { type: 'build', item: 'conduit', at: spot }).ok, false, 'cannot afford');
  s.players[me].hand = { ...emptyHand(), ...COSTS.conduit };
  // An edge far from my network is refused.
  const mine = new Set(Object.keys(s.buildings).filter((v) => s.buildings[v].owner === me).map(Number));
  const far = s.board.edges.find((e) => !legalSpots(s, me, 'conduit').includes(e.id) && s.conduits[e.id] === undefined
    && !e.v.some((v) => mine.has(v)));
  assert.equal(applyAction(s, me, { type: 'build', item: 'conduit', at: far.id }).ok, false);
  act(s, me, { type: 'build', item: 'conduit', at: spot });
  assert.equal(s.conduits[spot], me);
  assert.equal(handTotal(s.players[me].hand), 0);

  // Colony upgrades only my own outpost and costs the colony price.
  s.players[me].hand = { ...emptyHand(), ...COSTS.colony };
  const myOutpost = [...mine][0];
  const theirOutpost = Number(Object.keys(s.buildings).find((v) => s.buildings[v].owner !== me));
  assert.equal(applyAction(s, me, { type: 'build', item: 'colony', at: theirOutpost }).ok, false);
  const vp = victoryPoints(s, me);
  act(s, me, { type: 'build', item: 'colony', at: myOutpost });
  assert.equal(s.buildings[myOutpost].kind, 'colony');
  assert.equal(victoryPoints(s, me), vp + 1);
});

test('piece limits are enforced', () => {
  const s = three();
  playSetup(s);
  const me = s.current;
  rigRoll(s, 6);
  act(s, me, { type: 'roll' });
  s.players[me].hand = rich();
  let built = Object.values(s.conduits).filter((o) => o === me).length;
  while (built < LIMITS.conduit) {
    act(s, me, { type: 'build', item: 'conduit', at: legalSpots(s, me, 'conduit')[0] });
    built++;
  }
  const r = applyAction(s, me, { type: 'build', item: 'conduit', at: legalSpots(s, me, 'conduit')[0] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'None left');
});

test('bank trades at 4:1, or better with a beacon', () => {
  const s = three();
  playSetup(s);
  const me = s.current;
  rigRoll(s, 6);
  act(s, me, { type: 'roll' });
  for (const v of Object.keys(s.buildings)) if (s.buildings[v].owner === me) delete s.buildings[v];
  s.players[me].hand = { ...emptyHand(), ice: 4 };
  assert.equal(tradeRate(s, me, 'ice'), 4);
  assert.equal(applyAction(s, me, { type: 'bankTrade', give: 'ice', get: 'ice' }).ok, false);
  act(s, me, { type: 'bankTrade', give: 'ice', get: 'metal' });
  assert.deepEqual(s.players[me].hand, { ...emptyHand(), metal: 1 });

  const any = s.board.beacons.find((b) => b.res === null);
  const special = s.board.beacons.find((b) => b.res !== null);
  s.buildings[s.board.edges[any.edge].v[0]] = { owner: me, kind: 'outpost' };
  assert.equal(tradeRate(s, me, 'crystal'), 3);
  s.buildings[s.board.edges[special.edge].v[1]] = { owner: me, kind: 'outpost' };
  assert.equal(tradeRate(s, me, special.res), 2);
  s.players[me].hand = { ...emptyHand(), [special.res]: 2 };
  const want = RESOURCES.find((r) => r !== special.res);
  act(s, me, { type: 'bankTrade', give: special.res, get: want });
  assert.equal(s.players[me].hand[want], 1);
  assert.equal(s.players[me].hand[special.res], 0);
});

test('player trades: offer, accept, decline and cancel', () => {
  const s = three();
  playSetup(s);
  const me = s.current;
  const them = (me + 1) % 3;
  rigRoll(s, 6);
  act(s, me, { type: 'roll' });
  s.players.forEach((p) => { p.hand = emptyHand(); });
  s.players[me].hand.ice = 2;
  s.players[them].hand.metal = 1;
  assert.equal(applyAction(s, me, { type: 'offerTrade', give: { ice: 3 }, want: { metal: 1 } }).ok, false);
  assert.equal(applyAction(s, me, { type: 'offerTrade', give: { ice: 1 }, want: { ice: 1 } }).ok, false);
  assert.equal(applyAction(s, them, { type: 'offerTrade', give: { metal: 1 }, want: { ice: 1 } }).ok, false, 'not their turn');
  act(s, me, { type: 'offerTrade', give: { ice: 2 }, want: { metal: 1 } });
  const id = s.trade.id;
  const third = (me + 2) % 3;
  assert.equal(applyAction(s, third, { type: 'acceptTrade', tradeId: id }).ok, false, 'third has no metal');
  act(s, third, { type: 'declineTrade', tradeId: id });
  assert.deepEqual(s.trade.declined, [third]);
  assert.equal(applyAction(s, me, { type: 'acceptTrade', tradeId: id }).ok, false, 'cannot accept own');
  act(s, them, { type: 'acceptTrade', tradeId: id });
  assert.equal(s.trade, null);
  assert.equal(s.players[me].hand.metal, 1);
  assert.equal(s.players[me].hand.ice, 0);
  assert.equal(s.players[them].hand.ice, 2);

  act(s, me, { type: 'offerTrade', give: { metal: 1 }, want: { ice: 1 } });
  act(s, me, { type: 'cancelTrade' });
  assert.equal(s.trade, null);

  act(s, me, { type: 'offerTrade', give: { metal: 1 }, want: { ice: 1 } });
  act(s, me, { type: 'endTurn' });
  assert.equal(s.trade, null, 'offers expire at end of turn');
});

test('longest network: 5 in a row scores 2 points, and a rival outpost can cut it', () => {
  const s = three();
  playSetup(s);
  // Clear the board and lay a fresh straight-ish path for player 0.
  s.buildings = {};
  s.conduits = {};
  s.longest = { holder: null, length: 0 };
  s.phase = 'main';
  s.current = 0;
  s.players[0].hand = rich();
  const { vertices, edges } = s.board;
  // Depth-first search for a simple path of 6 edges whose middle vertex has a free side edge.
  const findPath = (route) => {
    if (route.length === 7) return vertices[route[3]].adj.length === 3 ? route : null;
    const here = route[route.length - 1];
    for (const next of vertices[here].adj) {
      if (route.includes(next)) continue;
      const found = findPath([...route, next]);
      if (found) return found;
    }
    return null;
  };
  const path = findPath([vertices.find((v) => v.adj.length === 3).id]);
  assert.ok(path, 'no path found');
  const edgeBetween = (a, b) => vertices[a].edges.find((e) => edges[e].v.includes(b));
  const pathEdges = path.slice(1).map((v, i) => edgeBetween(path[i], v));
  s.buildings[path[0]] = { owner: 0, kind: 'outpost' };
  for (let i = 0; i < 4; i++) act(s, 0, { type: 'build', item: 'conduit', at: pathEdges[i] });
  assert.equal(longestConduit(s, 0), 4);
  assert.equal(s.longest.holder, null);
  act(s, 0, { type: 'build', item: 'conduit', at: pathEdges[4] });
  assert.equal(s.longest.holder, 0);
  assert.equal(victoryPoints(s, 0), 1 + 2);

  // Player 1 builds an outpost in the middle of the path, splitting it 3 + 2.
  const cut = path[3];
  const side = vertices[cut].edges.find((e) => !pathEdges.includes(e));
  s.conduits[side] = 1;
  s.current = 1;
  s.players[1].hand = rich();
  act(s, 1, { type: 'build', item: 'outpost', at: cut });
  assert.equal(longestConduit(s, 0), 3);
  assert.equal(s.longest.holder, null);
});

test('reaching 10 points on your turn ends the game', () => {
  const s = three();
  playSetup(s);
  const me = s.current;
  rigRoll(s, 6);
  act(s, me, { type: 'roll' });
  s.players[me].hand = Object.fromEntries(RESOURCES.map((r) => [r, 500]));
  for (let i = 0; i < 300 && s.phase !== 'gameover'; i++) {
    const colony = legalSpots(s, me, 'colony');
    const outpost = legalSpots(s, me, 'outpost');
    const counts = { outpost: 0, colony: 0 };
    for (const b of Object.values(s.buildings)) if (b.owner === me) counts[b.kind]++;
    if (colony.length && counts.colony < LIMITS.colony) act(s, me, { type: 'build', item: 'colony', at: colony[0] });
    else if (outpost.length && counts.outpost < LIMITS.outpost) act(s, me, { type: 'build', item: 'outpost', at: outpost[0] });
    else {
      // Extend the network outward toward open space.
      const options = legalSpots(s, me, 'conduit');
      const scored = options.map((e) => ({ e, open: s.board.edges[e].v.filter((v) => !s.buildings[v]).length }));
      scored.sort((a, b) => b.open - a.open);
      act(s, me, { type: 'build', item: 'conduit', at: scored[(i * 7) % scored.length].e });
    }
  }
  assert.equal(s.phase, 'gameover');
  assert.equal(s.winner, me);
  assert.ok(victoryPoints(s, me) >= WIN_POINTS);
  assert.equal(applyAction(s, me, { type: 'endTurn' }).ok, false);
});

test('public view hides other hands and the dice seed', () => {
  const s = three();
  playSetup(s);
  const v = publicView(s, 1);
  assert.equal(v.rng, undefined);
  assert.equal(v.you, 1);
  assert.ok(v.players[1].hand);
  assert.equal(v.players[0].hand, undefined);
  assert.equal(v.players[0].cards, handTotal(s.players[0].hand));
  assert.equal(typeof v.players[2].points, 'number');
  // Legal-spot helpers still work on the view, which is what the phone uses.
  assert.deepEqual(legalSpots(v, 1, 'conduit'), legalSpots(s, 1, 'conduit'));
});

test('a full random 4-player game runs to a winner without errors', () => {
  const s = createGame({ players: ['A', 'B', 'C', 'D'].map((name) => ({ name })), seed: 7 });
  playSetup(s);
  const pick = (arr) => arr[Math.floor(random(s) * arr.length)];
  let steps = 0;
  while (s.phase !== 'gameover' && steps < 20000) {
    steps++;
    const me = s.current;
    if (s.phase === 'roll') { act(s, me, { type: 'roll' }); continue; }
    if (s.phase === 'discard') {
      const pid = Number(Object.keys(s.discards)[0]);
      const hand = { ...s.players[pid].hand };
      const cards = emptyHand();
      let need = s.discards[pid];
      for (const r of RESOURCES) { const n = Math.min(hand[r], need); cards[r] = n; need -= n; }
      act(s, pid, { type: 'discard', cards });
      continue;
    }
    if (s.phase === 'moveRaider') { act(s, me, { type: 'moveRaider', hex: pick(legalRaiderHexes(s)) }); continue; }
    if (s.phase === 'steal') { act(s, me, { type: 'steal', victim: s.stealFrom[0] }); continue; }
    // main: build whatever is affordable, trade 4:1 when stuck, then end turn.
    let did = false;
    for (const item of ['colony', 'outpost', 'conduit']) {
      const r = applyAction(s, me, { type: 'build', item, at: pick(legalSpots(s, me, item).concat([-1])) });
      if (r.ok) { did = true; break; }
    }
    if (did) continue;
    const hand = s.players[me].hand;
    const give = RESOURCES.find((r) => hand[r] >= tradeRate(s, me, r) + 1);
    if (give) {
      const get = RESOURCES.filter((r) => r !== give).sort((a, b) => hand[a] - hand[b])[0];
      act(s, me, { type: 'bankTrade', give, get });
      continue;
    }
    act(s, me, { type: 'endTurn' });
  }
  assert.equal(s.phase, 'gameover', `no winner after ${steps} steps`);
  assert.ok(victoryPoints(s, s.winner) >= WIN_POINTS);
});
