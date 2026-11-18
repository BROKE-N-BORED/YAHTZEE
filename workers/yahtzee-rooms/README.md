# Yahtzee online rooms

The room server for Yahtzee PvP online play (task-list item 12). One
Cloudflare Worker + one Durable Object class. Workers Free, $0, no card.

- One Durable Object = one game room (2–4 players, join by 4-letter code).
- The server sequences moves, enforces turn order, and holds the shared
  state. Scoring and dice stay in the game client, which sends the
  resulting snapshot with each move.
- WebSocket Hibernation API: idle rooms cost ~0 duration. Room state
  lives in the object's SQLite store and survives hibernation.
- No secrets, no dependencies, no build step. One file of server code.

## Files

| File | What it is |
|---|---|
| `src/index.js` | The whole server: Worker routing + the `YahtzeeRoom` Durable Object (~640 lines with comments) |
| `wrangler.toml` | Worker name `yahtzee-rooms`, Durable Object binding, SQLite migration |
| `PROTOCOL.md` | The exact client↔server protocol: HTTP endpoints, WebSocket messages, room lifecycle, snapshot shape |
| `DEPLOY.md` | Deploy steps: wrangler path (recommended) and dashboard path |
| `test/harness.mjs` | Local test harness — runs the real server against a real SQLite database and in-memory WebSockets, no Cloudflare account needed |

## Tests

```sh
node test/harness.mjs
```

80 checks, all passing (2026-11-17): room create + codes, 2–4 player
joins + room full, WebSocket connect + hello, host-only start, move
broadcast + turn enforcement, disconnect + rejoin with the same seat,
hibernation (object evicted, state reloaded from SQLite), a full
13-round game to finish + rematch, host close, alarm cleanup of empty
rooms, leave + host handoff.

Wrangler is not installed in this VM, so the harness exercises the
Durable Object logic directly instead of `wrangler dev`. After deploy,
run the three `curl` checks in `DEPLOY.md` against the live Worker.

## Deploy

See `DEPLOY.md`. Short version: `wrangler login`, then
`wrangler deploy` from this directory. The game client then connects to
the printed `workers.dev` URL (wiring the game client to this server is
the next task, not this one).
