(() => {
  "use strict";

  const resources = ["wood", "brick", "sheep", "wheat", "ore"];
  const terrainLabels = {
    forest: "WOOD",
    hills: "BRICK",
    pasture: "SHEEP",
    fields: "WHEAT",
    mountains: "ORE",
    desert: "DESERT"
  };
  const terrainCounts = [
    ["forest", 4], ["hills", 3], ["pasture", 4],
    ["fields", 4], ["mountains", 3], ["desert", 1]
  ];
  const numberTokens = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  const costs = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { wheat: 2, ore: 3 }
  };
  const playerColors = ["#39795b", "#bf654d", "#d0a33d", "#667d9a"];
  const playerNames = ["Moss", "Clay", "Sun", "Tide"];
  const board = document.querySelector("#board");
  const state = {
    tiles: [],
    nodes: new Map(),
    edges: new Map(),
    players: [],
    current: 0,
    mode: null,
    rolled: false,
    robberPending: false,
    over: false,
    dieOne: "–",
    dieTwo: "–",
    lastRoll: "–",
    logs: []
  };

  const shuffle = (items) => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };
  const makeKey = (x, y) => `${Math.round(x * 10)},${Math.round(y * 10)}`;
  const currentPlayer = () => state.players[state.current];
  const playerById = (id) => state.players.find((player) => player.id === id);
  const totalCards = (player) => resources.reduce((sum, resource) => sum + player.cards[resource], 0);

  function makeBoard() {
    state.tiles = [];
    state.nodes = new Map();
    state.edges = new Map();
    const coordinates = [];
    for (let q = -2; q <= 2; q++) {
      for (let r = -2; r <= 2; r++) {
        if (Math.abs(q + r) <= 2) coordinates.push({ q, r });
      }
    }

    const terrains = shuffle(terrainCounts.flatMap(([terrain, count]) => Array(count).fill(terrain)));
    const tokens = shuffle(numberTokens);
    const radius = 52;
    coordinates.forEach(({ q, r }, index) => {
      const x = 320 + radius * 1.5 * q;
      const y = 300 + radius * Math.sqrt(3) * (r + q / 2);
      const tile = {
        id: index, q, r, x, y, terrain: terrains[index],
        number: null, nodes: [], robber: terrains[index] === "desert"
      };
      if (tile.terrain !== "desert") tile.number = tokens.pop();
      for (let corner = 0; corner < 6; corner++) {
        const angle = Math.PI / 3 * corner;
        const point = { x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle) };
        const key = makeKey(point.x, point.y);
        if (!state.nodes.has(key)) state.nodes.set(key, { key, x: point.x, y: point.y, edges: [], building: null });
        tile.nodes.push(key);
      }
      tile.nodes.forEach((start, corner) => {
        const end = tile.nodes[(corner + 1) % 6];
        const key = [start, end].sort().join("|");
        if (!state.edges.has(key)) state.edges.set(key, { key, nodes: [start, end], owner: null });
        const edge = state.edges.get(key);
        if (!state.nodes.get(start).edges.includes(key)) state.nodes.get(start).edges.push(key);
        if (!state.nodes.get(end).edges.includes(key)) state.nodes.get(end).edges.push(key);
        edge.tileId = edge.tileId ?? index;
      });
      state.tiles.push(tile);
    });
  }

  function connectedNodes(from, distance) {
    const seen = new Set([from]);
    let frontier = [from];
    for (let step = 0; step < distance; step++) {
      const next = [];
      frontier.forEach((key) => {
        state.nodes.get(key).edges.forEach((edgeKey) => {
          const other = state.edges.get(edgeKey).nodes.find((nodeKey) => nodeKey !== key);
          if (!seen.has(other)) {
            seen.add(other);
            next.push(other);
          }
        });
      });
      frontier = next;
    }
    return seen;
  }

  function placeStartingPieces() {
    const candidates = shuffle([...state.nodes.values()].filter((node) => node.edges.length >= 2));
    const selected = [];
    state.players.forEach((player) => {
      const node = candidates.find((candidate) =>
        !candidate.building &&
        selected.every((placed) => !connectedNodes(placed.key, 3).has(candidate.key))
      );
      if (!node) return;
      node.building = { owner: player.id, type: "settlement" };
      player.points = 1;
      selected.push(node);
      const roadKey = shuffle(node.edges).find((key) => !state.edges.get(key).owner);
      if (roadKey) {
        state.edges.get(roadKey).owner = player.id;
        player.roads++;
      }
      const adjacentTiles = state.tiles.filter((tile) => tile.nodes.includes(node.key));
      adjacentTiles.forEach((tile) => {
        if (tile.terrain !== "desert") player.cards[tile.terrain === "forest" ? "wood" :
          tile.terrain === "hills" ? "brick" : tile.terrain === "pasture" ? "sheep" :
            tile.terrain === "fields" ? "wheat" : "ore"]++;
      });
    });
  }

  function setupPlayers(count) {
    state.players = Array.from({ length: count }, (_, id) => ({
      id,
      name: playerNames[id],
      color: playerColors[id],
      cards: Object.fromEntries(resources.map((resource) => [resource, 0])),
      points: 0,
      roads: 0
    }));
    placeStartingPieces();
  }

  function terrainFor(tile) {
    return tile.terrain === "desert" ? "desert" : tile.terrain;
  }

  function renderBoard() {
    const polygons = state.tiles.map((tile) => {
      const points = tile.nodes.map((key) => {
        const node = state.nodes.get(key);
        return `${node.x},${node.y}`;
      }).join(" ");
      const label = terrainLabels[terrainFor(tile)];
      const number = tile.number === null ? "" : `
        <circle class="tile-number" cx="${tile.x}" cy="${tile.y}" r="15"></circle>
        <text class="number-label ${tile.number === 6 || tile.number === 8 ? "number-hot" : ""}" x="${tile.x}" y="${tile.y}">${tile.number}</text>`;
      const robber = tile.robber ? `<text class="robber" x="${tile.x}" y="${tile.y - 27}">♟</text>` : "";
      return `<g>
        <polygon class="hex terrain-${tile.terrain}" points="${points}"></polygon>
        <text class="tile-resource" x="${tile.x}" y="${tile.y + 32}">${label}</text>
        ${number}${robber}
        <polygon class="tile-hit" data-tile="${tile.id}" points="${points}" aria-label="${label} tile${tile.number ? `, number ${tile.number}` : ""}"></polygon>
      </g>`;
    }).join("");
    const roads = [...state.edges.values()].map((edge) => {
      const first = state.nodes.get(edge.nodes[0]);
      const second = state.nodes.get(edge.nodes[1]);
      const color = edge.owner === null ? "" : ` style="--player-color:${playerById(edge.owner).color}"`;
      return `<g${color}>
        <line class="road-hit" data-edge="${edge.key}" x1="${first.x}" y1="${first.y}" x2="${second.x}" y2="${second.y}" aria-label="Road location"></line>
        <line class="road-line${edge.owner === null ? "" : " owned"}" x1="${first.x}" y1="${first.y}" x2="${second.x}" y2="${second.y}"></line>
      </g>`;
    }).join("");
    const nodes = [...state.nodes.values()].map((node) => {
      const building = node.building;
      const color = building ? playerById(building.owner).color : "";
      const mark = building?.type === "city" ? "⌂" : "";
      return `<g${color ? ` style="--player-color:${color}"` : ""}>
        <circle class="node-hit${building ? " owned" : ""}${building?.type === "city" ? " city" : ""}" data-node="${node.key}" cx="${node.x}" cy="${node.y}" r="${building ? (building.type === "city" ? 8 : 6) : 4}" aria-label="${building ? `${playerById(building.owner).name} ${building.type}` : "Settlement location"}"></circle>
        ${mark ? `<text x="${node.x}" y="${node.y + 3}" fill="white" font-size="9" text-anchor="middle" pointer-events="none">${mark}</text>` : ""}
      </g>`;
    }).join("");
    board.innerHTML = `${polygons}${roads}${nodes}`;
  }

  function renderPlayers() {
    const container = document.querySelector("#players");
    container.innerHTML = state.players.map((player, index) => `
      <div class="player-card${index === state.current ? " active" : ""}" style="--player-color:${player.color}">
        <span class="player-swatch"></span>
        <span class="player-name">${player.name}${index === state.current ? " · playing" : ""}</span>
        <span class="player-score">${player.roads} roads</span>
        <span class="player-vp">${player.points}<small>VP</small></span>
      </div>`).join("");
    const player = currentPlayer();
    document.querySelector("#resources").innerHTML = resources.map((resource) => `
      <div class="resource-card">
        <span class="resource-dot ${resource}"></span>
        <strong>${player.cards[resource]}</strong>
        <small>${resource.toUpperCase()}</small>
      </div>`).join("");
    document.querySelector("#card-count").textContent = `${totalCards(player)} CARDS`;
    document.querySelector("#turn-label").textContent = `${player.name}'s turn`;
  }

  function renderControls() {
    const canAct = state.rolled && !state.robberPending && !state.over;
    document.querySelector("#roll-button").disabled = state.rolled || state.over;
    document.querySelector("#end-turn").disabled = !state.rolled || state.robberPending || state.over;
    document.querySelector("#die-one").textContent = state.dieOne;
    document.querySelector("#die-two").textContent = state.dieTwo;
    document.querySelector("#roll-total").textContent = state.lastRoll;
    document.querySelector("#phase-label").textContent = state.over ? "FINISHED" : state.robberPending ? "ROBBER" : state.rolled ? "BUILD" : "READY";
    document.querySelectorAll(".build-option").forEach((button) => {
      button.disabled = !canAct;
      button.classList.toggle("selected", button.dataset.build === state.mode);
    });
    document.querySelector("#trade-button").disabled = !canAct;
    const hint = document.querySelector("#board-hint");
    if (state.over) hint.textContent = `${currentPlayer().name} wins! Start a new game to play again.`;
    else if (state.robberPending) hint.textContent = "The robber is blocking production. Choose a tile to move it.";
    else if (!state.rolled) hint.textContent = "Roll the dice to begin your turn.";
    else if (state.mode) hint.textContent = `Choose a ${state.mode} location on the island.`;
    else hint.textContent = "Build, trade, or end your turn.";
  }

  function render() {
    renderBoard();
    renderPlayers();
    renderControls();
  }

  function log(message) {
    state.logs.unshift(message);
    state.logs = state.logs.slice(0, 7);
    const gameLog = document.querySelector("#game-log");
    gameLog.replaceChildren(...state.logs.map((entry) => {
      const item = document.createElement("li");
      item.textContent = entry;
      return item;
    }));
  }

  function ownsCost(player, cost) {
    return Object.entries(cost).every(([resource, amount]) => player.cards[resource] >= amount);
  }

  function pay(player, cost) {
    Object.entries(cost).forEach(([resource, amount]) => { player.cards[resource] -= amount; });
  }

  function adjacentOwner(node, owner) {
    return node.edges.some((edgeKey) => state.edges.get(edgeKey).owner === owner);
  }

  function canBuildSettlement(node, player) {
    if (node.building || !adjacentOwner(node, player.id)) return false;
    return node.edges.every((edgeKey) => {
      const otherKey = state.edges.get(edgeKey).nodes.find((key) => key !== node.key);
      return !state.nodes.get(otherKey).building;
    });
  }

  function canBuildRoad(edge, player) {
    if (edge.owner !== null) return false;
    return edge.nodes.some((nodeKey) => {
      const node = state.nodes.get(nodeKey);
      return node.building
        ? node.building.owner === player.id
        : adjacentOwner(node, player.id);
    });
  }

  function tryBuild(type, key) {
    const player = currentPlayer();
    const cost = costs[type];
    if (!ownsCost(player, cost)) {
      document.querySelector("#action-message").textContent = `Not enough resources for a ${type}.`;
      return;
    }
    if (type === "road") {
      const edge = state.edges.get(key);
      if (!edge || !canBuildRoad(edge, player)) {
        document.querySelector("#action-message").textContent = "Build roads connected to your own network.";
        return;
      }
      pay(player, cost);
      edge.owner = player.id;
      player.roads++;
    } else {
      const node = state.nodes.get(key);
      if (!node) return;
      if (type === "settlement") {
        if (!canBuildSettlement(node, player)) {
          document.querySelector("#action-message").textContent = "Choose an open site connected to your road, with room between settlements.";
          return;
        }
        pay(player, cost);
        node.building = { owner: player.id, type: "settlement" };
        player.points++;
      } else {
        if (node.building?.owner !== player.id || node.building.type !== "settlement") {
          document.querySelector("#action-message").textContent = "Choose one of your settlements to upgrade.";
          return;
        }
        pay(player, cost);
        node.building.type = "city";
        player.points++;
      }
    }
    state.mode = null;
    document.querySelector("#action-message").textContent = "";
    log(`${player.name} built a ${type}.`);
    if (player.points >= 10) {
      state.over = true;
      log(`${player.name} wins the island!`);
    }
    render();
  }

  function rollDice() {
    if (state.rolled || state.over) return;
    const dieOne = Math.floor(Math.random() * 6) + 1;
    const dieTwo = Math.floor(Math.random() * 6) + 1;
    const total = dieOne + dieTwo;
    state.dieOne = dieOne;
    state.dieTwo = dieTwo;
    state.lastRoll = total;
    state.rolled = true;
    state.mode = null;
    const player = currentPlayer();
    if (total === 7) {
      state.players.forEach((settler) => {
        if (totalCards(settler) > 7) {
          const discard = Math.floor(totalCards(settler) / 2);
          for (let i = 0; i < discard; i++) {
            const available = resources.filter((resource) => settler.cards[resource] > 0);
            const resource = available[Math.floor(Math.random() * available.length)];
            settler.cards[resource]--;
          }
          if (discard) log(`${settler.name} discarded ${discard} cards.`);
        }
      });
      state.robberPending = true;
      log(`${player.name} rolled 7. Move the robber.`);
    } else {
      const produced = {};
      state.tiles.forEach((tile) => {
        if (tile.number !== total || tile.robber) return;
        const resource = terrainToResource(tile.terrain);
        tile.nodes.forEach((nodeKey) => {
          const building = state.nodes.get(nodeKey).building;
          if (!building) return;
          const amount = building.type === "city" ? 2 : 1;
          playerById(building.owner).cards[resource] += amount;
          produced[resource] = (produced[resource] || 0) + amount;
        });
      });
      const summary = Object.entries(produced).map(([resource, amount]) => `${amount} ${resource}`).join(", ");
      log(summary ? `Rolled ${total}: island produced ${summary}.` : `Rolled ${total}: no resources produced.`);
    }
    document.querySelector("#action-message").textContent = "";
    render();
  }

  function terrainToResource(terrain) {
    return ({ forest: "wood", hills: "brick", pasture: "sheep", fields: "wheat", mountains: "ore" })[terrain];
  }

  function moveRobber(tileId) {
    const tile = state.tiles.find((candidate) => candidate.id === Number(tileId));
    if (!tile || tile.robber) return;
    state.tiles.forEach((candidate) => { candidate.robber = false; });
    tile.robber = true;
    state.robberPending = false;
    const player = currentPlayer();
    const possibleVictims = new Set();
    tile.nodes.forEach((nodeKey) => {
      const building = state.nodes.get(nodeKey).building;
      if (building && building.owner !== player.id && totalCards(playerById(building.owner)) > 0) possibleVictims.add(building.owner);
    });
    const victims = [...possibleVictims];
    if (victims.length) {
      const victim = playerById(victims[Math.floor(Math.random() * victims.length)]);
      const stolenResource = resources.find((resource) => victim.cards[resource] > 0 && Math.random() < 0.3) ||
        resources.find((resource) => victim.cards[resource] > 0);
      if (stolenResource) {
        victim.cards[stolenResource]--;
        player.cards[stolenResource]++;
        log(`${player.name} moved the robber and stole 1 ${stolenResource} from ${victim.name}.`);
      }
    } else log(`${player.name} moved the robber.`);
    render();
  }

  function makeTrade() {
    if (!state.rolled || state.robberPending || state.over) return;
    const give = document.querySelector("#trade-give").value;
    const get = document.querySelector("#trade-get").value;
    const player = currentPlayer();
    if (give === get) {
      document.querySelector("#action-message").textContent = "Choose two different resources.";
      return;
    }
    if (player.cards[give] < 4) {
      document.querySelector("#action-message").textContent = `You need 4 ${give} cards to trade.`;
      return;
    }
    player.cards[give] -= 4;
    player.cards[get]++;
    document.querySelector("#action-message").textContent = "";
    log(`${player.name} traded 4 ${give} for 1 ${get}.`);
    render();
  }

  function endTurn() {
    if (!state.rolled || state.robberPending || state.over) return;
    state.current = (state.current + 1) % state.players.length;
    state.rolled = false;
    state.mode = null;
    document.querySelector("#action-message").textContent = "";
    log(`${currentPlayer().name}'s turn.`);
    render();
  }

  function newGame() {
    state.current = 0;
    state.mode = null;
    state.rolled = false;
    state.robberPending = false;
    state.over = false;
    state.dieOne = "–";
    state.dieTwo = "–";
    state.lastRoll = "–";
    state.logs = [];
    makeBoard();
    setupPlayers(Number(document.querySelector("#player-count").value));
    document.querySelector("#action-message").textContent = "";
    log("A new island is ready. Roll to begin.");
    render();
  }

  board.addEventListener("click", (event) => {
    const tile = event.target.closest("[data-tile]");
    if (state.robberPending && tile) {
      moveRobber(tile.dataset.tile);
      return;
    }
    if (!state.mode || state.robberPending) return;
    const node = event.target.closest("[data-node]");
    const edge = event.target.closest("[data-edge]");
    if (state.mode === "road" && edge) tryBuild("road", edge.dataset.edge);
    else if (state.mode !== "road" && node) tryBuild(state.mode, node.dataset.node);
  });
  document.querySelectorAll(".build-option").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.rolled || state.robberPending || state.over) return;
      state.mode = state.mode === button.dataset.build ? null : button.dataset.build;
      document.querySelector("#action-message").textContent = "";
      renderControls();
    });
  });
  document.querySelector("#roll-button").addEventListener("click", rollDice);
  document.querySelector("#end-turn").addEventListener("click", endTurn);
  document.querySelector("#trade-button").addEventListener("click", makeTrade);
  document.querySelector("#new-game").addEventListener("click", newGame);
  ["#trade-give", "#trade-get"].forEach((selector) => {
    const select = document.querySelector(selector);
    select.innerHTML = resources.map((resource) => `<option value="${resource}">${resource}</option>`).join("");
  });
  document.querySelector("#trade-get").value = "brick";
  newGame();
})();
