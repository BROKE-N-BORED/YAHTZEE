# Deploying the Yahtzee room server

Target: Joshua's Cloudflare account (Workers Free, $0, no card on file).
What gets created: one Worker named `yahtzee-rooms` and one Durable Object
class `YahtzeeRoom` (SQLite-backed). No secrets, no environment variables,
no custom domain — the Worker answers on its `workers.dev` address.

Two paths. **A (wrangler) is recommended**: `wrangler.toml` in this
directory is authoritative for the Durable Object migration, so it cannot
come out wrong. **B (dashboard)** works too, with one thing to check.

## Path A — wrangler (recommended)

Run on any machine with Node 16.17+ (Joshua's Linux Mint PC works, or
this VM). The code lives in `~/workspace/yahtzee-rooms/`.

1. Install wrangler (once):
   ```sh
   npm install -g wrangler
   ```
2. Sign in to Joshua's Cloudflare account (once; it opens a browser tab
   for him to approve — he must be the one to approve it):
   ```sh
   wrangler login
   ```
3. Deploy from this directory:
   ```sh
   cd ~/workspace/yahtzee-rooms
   wrangler deploy
   ```
   Wrangler creates the Worker and runs the `v1` migration, which creates
   the `YahtzeeRoom` class with SQLite storage. The output prints the
   URL, like:
   ```
   https://yahtzee-rooms.<subdomain>.workers.dev
   ```
   Write that URL down — it is the address the game client connects to.
4. Verify (replace the URL with the real one):
   ```sh
   curl https://yahtzee-rooms.<subdomain>.workers.dev/
   # {"name":"yahtzee-rooms","version":"1.0.0","status":"ok"}

   curl -X POST https://yahtzee-rooms.<subdomain>.workers.dev/rooms \
     -H 'content-type: application/json' -d '{"name":"Ann"}'
   # {"code":"KQZT","playerId":"…","seat":0,"room":{…}}

   curl https://yahtzee-rooms.<subdomain>.workers.dev/rooms/KQZT
   # {"code":"KQZT","phase":"lobby","playerCount":1,"maxPlayers":4,"players":[…]}
   ```
   A room code back from `POST /rooms` proves the Durable Object class,
   the SQLite store, and the routing all work.

## Path B — dashboard (no CLI)

1. Open https://dash.cloudflare.com/ → **Workers & Pages** → **Create** →
   **Worker** → name it `yahtzee-rooms` → **Deploy**. (This creates a
   hello-world Worker first; the code is replaced next.)
2. On the Worker page, **Edit code**. Delete the starter code, paste the
   entire contents of `src/index.js`, then **Save and deploy**.
3. Bind the Durable Object: **Settings** → **Bindings** → **Add binding**
   → **Durable Object**. Binding name `YAHTZEE_ROOM`, class name
   `YahtzeeRoom`. Save, then deploy again if the dashboard asks.
4. Check the class came out SQLite-backed: on the Worker page, open
   **Settings** → **Bindings** and confirm the Durable Object binding
   shows class `YahtzeeRoom`. Then run the same three `curl` checks as
   Path A step 4. If `POST /rooms` fails with a storage error, the class
   did not get SQLite storage — use Path A instead; `wrangler.toml`
   creates the class correctly.
5. The Worker URL is shown on the Worker page
   (`https://yahtzee-rooms.<subdomain>.workers.dev`).

## After deploy

- Give the Worker URL to the game-client wiring task: the game opens
  `wss://<worker-host>/rooms/<code>/ws?playerId=<id>` and calls the HTTP
  endpoints in `PROTOCOL.md`.
- Nothing else to configure. No DNS, no TLS (Cloudflare terminates it),
  no keep-alive (Workers never sleep).

## Updating later

Edit `src/index.js`, then `wrangler deploy` again from this directory.
The migration tag stays `v1` — no new migration is needed unless the
Durable Object class itself changes (rename, delete, new class). Rooms
live in their own Durable Objects, so a redeploy does not wipe them;
in-flight games reconnect on their next message (the object reloads its
state from SQLite).

## If something goes wrong

- `wrangler login` needs a browser: run it where Joshua can approve the
  tab, or use `wrangler login` on his PC.
- "workers.dev subdomain not enabled": the account's workers.dev
  subdomain is created on first Worker deploy; if the dashboard shows
  it disabled, enable it under **Workers & Pages** → **Settings** (or
  just deploy — wrangler creates it).
- "Class already exists" on deploy: the migration already ran. Deploy
  again; it is safe to repeat.
- The Worker answers but `POST /rooms` returns 500: check the Worker's
  **Logs** tab in the dashboard (Workers & Pages → yahtzee-rooms →
  Logs) for the error. Most likely cause is the Durable Object binding
  missing or misnamed — it must be `YAHTZEE_ROOM` exactly.

## Cost

Workers Free: $0, no card. Overage is a hard stop, never a bill. A few
friends playing Yahtzee will not come near the free limits (100,000
requests/day, 13,000 GB-s/day, 5 GB SQLite storage; WebSocket messages
bill 20:1; hibernation stops the duration meter while a room is quiet).
