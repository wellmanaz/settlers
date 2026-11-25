# Hexfront

lets go

A couch board game for the living room: the **TV is the board** (any browser, built for the Xbox's Edge browser) and **each player's phone is their controller**. 2 to 4 players. Proof of concept, plain HTML and JavaScript, no build step and no server of its own.

Hexfront is an original game in the hex-tile trading genre: claim an asteroid belt, roll for resources, build conduits, outposts and colonies, trade, and race to 10 points.

## Play it

1. **Host the files** somewhere with HTTPS. The easiest is GitHub Pages: repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick the branch and `/ (root)`. The game is then at `https://<user>.github.io/settlers/`.
2. **On the Xbox**, open Microsoft Edge and go to that address. The TV shows a QR code and a 5-letter room code. Use **Full screen** for the cleanest view.
3. **On each phone**, scan the QR code (or open `…/play.html` and type the room code), enter a name and tap **Join**.
4. Anyone taps **Start game** once 2 to 4 players are in.

While a phone connects it shows each step and a running timer; if it can't reach the TV it says why instead of waiting forever. The TV shows whether it is online, and a line whenever a phone is linking.

Phones that lock or drop off reconnect on their own. If a phone loses its saved seat, join again with the same name to take it back. If the TV page reloads, it offers to **Resume** the saved game and the phones rejoin.

### Try it on one computer

Serve the folder (`npm run serve`, or any static server) and open:

- TV: `http://localhost:8080/?net=local`
- Phones: open `play.html?room=CODE&net=local` in 2 to 4 more tabs of the same browser (the TV's QR code holds this link).

`net=local` swaps the network for a same-browser channel so you can test without phones.

### Connection options

Add these to the TV's address; the QR code passes them on to the phones.

- `?net=relay` skips the direct link and always uses the relay. Try this if phones are slow to join on your network.
- `?net=peer` uses only direct links (no relay).
- `?relay=wss://your-broker/mqtt` uses one MQTT-over-WebSocket broker of your own instead of the public ones.

## Rules

| Piece | Cost | Points |
|---|---|---|
| Conduit | Carbon, Metal | Longest network of 5+ is worth 2 |
| Outpost | Ice, Carbon, Crystal, Biomass | 1 |
| Colony (upgrades an outpost) | 2 Metal, 2 Crystal, Ice | 2 |

- **Setup:** in snake order, each player places an outpost and a conduit touching it, twice. The second outpost pays one card from each tile it touches.
- **Your turn:** roll the dice. Every tile showing that number pays each outpost on its corners 1 card (colonies 2). Then build, trade, and end your turn.
- **Placement:** outposts need an empty corner with no building next to it and, after setup, one of your conduits leading there. Conduits extend your network and cannot pass through a rival's building.
- **Raid (a roll of 7):** anyone holding more than 7 cards dumps half. The roller moves the raiders to another tile (it stops producing) and steals a random card from a player next to it.
- **Trading:** with the bank at 4:1, at 3:1 or 2:1 if you have an outpost on a matching trade beacon, or offer a deal to the other players from your phone. The first player to accept gets it.
- **Winning:** the first player to reach 10 points on their own turn wins.

The board is a 24-tile oval laid out at random each game, with no two 6 or 8 tiles touching.

## How it works

```
index.html     TV page: owns the game state, draws the board, shows the QR code
play.html      phone controller: your hand, a mini map to tap spots, action buttons
js/engine.js   all rules, pure functions over a JSON state (shared by TV, phones and tests)
js/render.js   SVG board renderer (shared by TV and phones)
js/icons.js    resource icons as SVG paths (no emoji or symbol fonts needed)
js/net.js      transport: direct WebRTC link (PeerJS) with an MQTT relay fallback, or BroadcastChannel for local testing
js/host.js, js/phone.js   the two apps
vendor/        PeerJS 1.5.5, MQTT.js 5.16.1 and qrcode-generator 1.4.4 (all MIT), served locally
```

- The TV is the only source of truth. Phones send intents (`roll`, `build`, `bankTrade`…), the TV checks them with the engine and sends each phone a view that hides the other players' cards and the dice seed.
- **Networking, direct link:** the TV registers a peer ID made from the room code on the free public PeerJS broker (`0.peerjs.com`), which only handles the handshake. Game traffic then runs directly between the devices over WebRTC data channels. Google and Cloudflare STUN servers help the devices find each other, and PeerJS's free TURN server is listed too, but it has no uptime guarantee.
- **Networking, relay:** a direct link often can't open, for example when the router keeps wired and Wi-Fi devices apart or the phone is on mobile data. A phone that hasn't linked within 9 seconds switches to a relay: both sides connect out to a free public MQTT broker over secure WebSockets (HiveMQ, EMQX and Mosquitto test brokers; the TV listens on all three, the phone uses the first where the TV answers). The relay works on any network that allows HTTPS. Its catch: game messages, including player names, pass through a public test server that anyone could read if they guessed the room code, and these brokers have no uptime guarantee either.
- Nothing to deploy beyond static files.
- The TV saves the game to its own `localStorage` after every move.

## Tests

```
npm test             # rules engine, 17 tests, no install needed (Node 18+)
npm install
npm run test:ui        # whole-app smoke test, see below
npm run test:ui:relay  # the same, with the pages linked through a local MQTT broker
npm run test:net       # connection code against real WebRTC and local servers
```

`test:ui` runs the real TV page and three phone pages, each in its own worker thread with a simulated DOM (jsdom), connected by the local transport. It drives the phones only through their buttons and map taps, plays a full game to a winner, and covers a player trade, a phone dropping and retaking its seat, and the TV reloading and resuming. `test:ui:relay` runs the same game over the relay code, plus a phone with a wrong room code that must show an error.

`test:net` runs `js/net.js` with a real WebRTC stack (node-datachannel), a local PeerJS server and a local MQTT broker: a direct link, a blocked direct link that falls back to the relay, a wrong room, the matchmaking server down, and the TV going away and coming back.

## Not done yet

- Not tested on real Xbox hardware or real phones. The UI tests use a simulated DOM, and the network tests use local servers; the public PeerJS, TURN and MQTT servers can't be reached from the test machine.
- No development cards, no bank card limits, no spectator mode.
- Player trades go to the first player who accepts; the offerer cannot pick between takers.
