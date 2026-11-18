# Yahtzee rooms — client↔server protocol

Version 1.0.0. Matches `src/index.js` exactly; if this file and the code
disagree, the code wins and this file needs a fix.

Base URL after deploy: `https://yahtzee-rooms.<subdomain>.workers.dev`
(the deploy output prints the real one). HTTP endpoints answer JSON and
allow any origin (CORS `*`), so the game page can call them from anywhere,
including a `file://` open. WebSockets need no CORS.

## What the server does — and does not do

The server sequences moves, enforces turn order, and holds the shared
state. It never rolls dice and never scores: the acting client applies
the move locally (the game already knows its own rules) and sends the
resulting snapshot with the move. The server checks that it is that
player's turn, stamps the move with a sequence number, stores the
snapshot, and broadcasts both. Every other client applies the broadcast
snapshot. That is the whole authority model.

## HTTP endpoints

### `GET /`

Health check. `200 {"name":"yahtzee-rooms","version":"1.0.0","status":"ok"}`

### `POST /rooms`

Create a room. The caller becomes the host (seat 0).

Request body: `{"name": "Ann"}` (name optional, defaults to `"Host"`).

Response `201`:
```json
{"code": "KQZT", "playerId": "…uuid…", "seat": 0, "room": {…}}
```
`code` is 4 letters (A–Z except I and O, so it reads clearly aloud).
`playerId` is the caller's seat claim: store it (localStorage) — it is
what gets the same seat back after a disconnect. `room` is the full room
state (shape below).

Errors: `500 {"error": "could_not_create_room"}` (could not find a free
code in 5 tries — vanishingly unlikely) or `500 {"error": "server_error"}`.

### `GET /rooms/:code`

Public status. No game state, just enough to show a room card.

Response `200`:
```json
{
  "code": "KQZT", "phase": "lobby", "playerCount": 3, "maxPlayers": 4,
  "players": [
    {"name": "Ann", "seat": 0, "connected": true},
    {"name": "Ben", "seat": 1, "connected": true},
    {"name": "Cat", "seat": 2, "connected": false}
  ]
}
```
Errors: `404 {"error": "room_not_found"}`.

### `POST /rooms/:code/join`

Reserve a seat. Call this before opening the WebSocket.

Request body: `{"name": "Ben"}`. To re-reserve a seat you already hold
(after a page reload, before reconnecting), send your stored playerId
too: `{"playerId": "…", "name": "Ben"}` — the server returns the same
seat instead of taking a new one.

Response `200`: `{"playerId": "…", "seat": 1, "room": {…}}`.

Errors:
- `404 {"error": "room_not_found"}` — no room with that code.
- `409 {"error": "room_full"}` — 4 players already.
- `409 {"error": "game_started"}` — the game is past the lobby; new
  players cannot join (a known playerId rejoining is still allowed).
- `400 {"error": "bad_name"}` — empty name.

### `GET /rooms/:code/ws?playerId=…`

WebSocket upgrade. The `playerId` must be one the server knows (from
create or join). On success the response is `101` and the socket is
open; send `hello` (below) as the first message.

Errors: `404 room_not_found`, `403 not_in_room`, `426 expected_websocket`
(not a WebSocket upgrade request).

## Room state (the `room` object)

```json
{
  "code": "KQZT",
  "phase": "lobby",
  "hostId": "…uuid…",
  "players": [
    {"id": "…uuid…", "name": "Ann", "seat": 0, "connected": true,
     "joinedAt": 1795000000000, "lastSeenAt": 1795000000000}
  ],
  "turn": {"playerId": "…uuid…", "round": 1, "roll": 0},
  "game": null,
  "seq": 0,
  "version": 0,
  "createdAt": 1795000000000,
  "updatedAt": 1795000000000
}
```

- `phase`: `lobby` → `playing` → `finished` (rematch returns to `playing`).
- `turn.playerId` is whose move it is (`null` in the lobby and after the
  game finishes). `turn.round` is 1–13; `turn.roll` is 0–3.
- `game` is the latest snapshot the clients agreed on (`null` until the
  game starts). The server treats it as opaque JSON.
- `seq` counts moves (resets on start/rematch); `version` counts every
  room change (joins, leaves, moves). Clients can compare `version`
  after a reconnect to tell whether they missed anything.
- The server keeps a move log (last 100 moves) for its own record. It is
  not sent in state broadcasts; a rejoining client gets the snapshot,
  which is the whole truth, plus the last 10 moves in its welcome (below)
  so it can rebuild its visible game log.

## WebSocket: client → server

All messages are JSON text in one frame, max 64 KB.

| Message | Who / when | Server does |
|---|---|---|
| `{"t":"hello"}` | First message after the socket opens. | Marks you connected, sends `welcome`, broadcasts `state`. A second socket for the same player replaces the first. |
| `{"t":"ping"}` | Heartbeat, about every 30 s. | Replies `{"t":"pong","version":n}`. (Browser clients cannot send protocol ping frames, so the JSON heartbeat is the keep-alive. Native clients' protocol pings are answered by the runtime without waking the room.) |
| `{"t":"start","game":{…}}` | Host only, lobby, 2+ players. | Starts the game: turn goes to seat 0, round 1, snapshot stored, broadcasts `state`. |
| `{"t":"move","move":{…},"game":{…}}` | During play (see move types). | Validates, sequences, stores the snapshot, broadcasts the move. |
| `{"t":"rematch","game":{…}}` | Host only, after the game finishes. | Fresh game in the same room: round 1, turn to seat 0, sequence reset, broadcasts `state`. |
| `{"t":"leave"}` | Any player. | Removes you, frees your seat. If you held the turn, it passes to the next player first. If you were host, the host passes to the lowest remaining seat. If you were the last player, the room is deleted. |
| `{"t":"close"}` | Host only. | Closes the room for everyone (`closed` broadcast, then the room is deleted). |

### Move types (`move.type`)

- `roll` — the turn player rolled. Payload carries whatever the client
  wants the others to show, e.g. `{"type":"roll","roll":1,"dice":[1,2,3,4,5]}`.
  `roll` (0–3) updates the turn's roll count. Turn stays with the player.
- `hold` — the turn player changed which dice are held, e.g.
  `{"type":"hold","held":[false,true,true,false,false]}`. Turn stays.
- `score` — the turn player scored a box, e.g.
  `{"type":"score","category":"chance","points":15}`. The turn advances
  to the next seat; the round ticks when it wraps back to the lowest
  seat. Scoring the last box of round 13 finishes the game.
- `skip` — host only. Passes the turn without scoring, for when the turn
  player's connection died mid-turn. No snapshot needed.

`roll`, `hold` and `score` must come from the turn player and must carry
`game`, the snapshot after the move. `skip` must come from the host.

## WebSocket: server → client

| Message | Meaning |
|---|---|
| `{"t":"welcome","playerId":"…","seat":2,"room":{…},"recentMoves":[…]}` | Sent to you on `hello`. Full state plus the last 10 moves. |
| `{"t":"state","room":{…}}` | Full state, after a join, leave, start, rematch, connect, or disconnect. |
| `{"t":"move","seq":7,"playerId":"…","move":{…},"phase":"playing","turn":{…},"version":12,"game":{…}}` | A sequenced move, to every connected player including the sender. Apply `game` as the new shared state; `turn` and `phase` are the new values (so the final move also tells you the game finished). |
| `{"t":"pong","version":12}` | Heartbeat reply. |
| `{"t":"closed","reason":"…"}` | The room is gone. `host_closed` (host closed it), `room_empty` (last player left), `room_expired` (cleaned up). Close the socket and return to the menu. |
| `{"t":"error","code":"…","message":"…"}` | Your last message was rejected; nothing changed. Codes: `bad_json`, `bad_message`, `message_too_large`, `not_in_room`, `not_host`, `not_your_turn`, `need_players`, `wrong_phase`, `bad_move`, `bad_snapshot`, `unknown_message`. |

## Room lifecycle (the client sequence)

1. **Host creates:** `POST /rooms {"name"}` → keep `code` + `playerId`,
   share the code with friends.
2. **Friends join:** `POST /rooms/:code/join {"name"}` → keep `playerId`
   + `seat`. Joining reserves the seat; the player is `connected: false`
   until the socket opens.
3. **Everyone connects:** open
   `wss://<worker>/rooms/:code/ws?playerId=<id>`, send `hello` on open.
   The `welcome` carries the full state; `state` broadcasts keep the
   lobby list live.
4. **Host starts:** send `start` with the initial snapshot (empty
   scorecards). Needs 2+ players in the room.
5. **Play:** the turn player acts locally, then sends one `move` with
   the resulting snapshot. Everyone applies the broadcast snapshot.
   `roll`/`hold` keep the turn; `score`/`skip` advance it. After round
   13 the game finishes (`phase: "finished"`, `turn.playerId: null`).
6. **Rematch or close:** host sends `rematch` with a fresh snapshot, or
   `close` to end the room. Anyone can `leave` at any time.
7. **Reconnect:** if the socket drops, open a new one with the same
   `playerId` and send `hello`. Same seat, full state, recent moves.
   The seat is held while disconnected; the game waits for the turn
   player (the host can `skip` them if they never come back).

## The snapshot (recommended shape)

The server only checks that the snapshot is a plain JSON object no
bigger than 32 KB. The client owns its shape. This shape matches the
game's state and is the recommended one for the wiring task:

```json
{
  "players": [
    {
      "seat": 0, "name": "Ann",
      "scores": {"aces": 3, "twos": null, "threes": null, "fours": null,
                 "fives": null, "sixes": null, "threeOfAKind": null,
                 "fourOfAKind": null, "fullHouse": null,
                 "smallStraight": null, "largeStraight": null,
                 "yahtzee": null, "chance": null},
      "upperBonus": 0, "yahtzeeBonus": 0, "total": 3
    }
  ],
  "dice": [1, 3, 3, 5, 6],
  "held": [false, true, true, false, false],
  "rollsUsed": 1
}
```

`scores` uses `null` for unscored boxes. The wiring task adapts the
category keys to the game's real ones; the server does not care.

## Limits

| Limit | Value |
|---|---|
| Players per room | 4 (2 to start) |
| Room code | 4 letters |
| WebSocket message | 64 KB |
| Snapshot | 32 KB, plain JSON object |
| Server move log | Last 100 moves |
| Empty room | Deleted 1 hour after the last player disconnects |
| Any room | Deleted after 24 hours, whatever its state |
| Rejoin window | As long as the room exists and the seat was never `leave`d |

## Free-tier notes

- The room hibernates between messages (Hibernation WebSocket API), so
  an idle room costs ~0 duration. A message wakes it, is handled, and
  the room sleeps again.
- WebSocket messages bill 20:1 as requests. A busy night (4 players,
  ~300 moves + heartbeats) is a few hundred billable requests against
  a 100,000/day free allowance.
- Each mutation rewrites one small SQLite row. Nothing here is close to
  the free storage or row-write limits.
- Overage on Workers Free is a hard stop, never a bill.
