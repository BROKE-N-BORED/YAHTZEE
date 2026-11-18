// Local test harness for the Yahtzee room server. No Cloudflare account,
// no wrangler, no network: it runs the real src/index.js against fakes for
// the Workers runtime — a real SQLite database (node:sqlite) behind the
// Durable Object storage API, in-memory WebSocket pairs, and a fake
// Durable Object namespace that routes one object per room code.
//
// Run:  node test/harness.mjs
// Exit code 0 = every test passed.

import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------- fakes

// The worker uses `new Response(null, { status: 101, webSocket: client })`.
// Node's Response rejects status 101, so the harness supplies a minimal
// Response that accepts any status, keeps the webSocket, and answers
// .json() / .text() like the real one.
class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers ?? {});
    this.webSocket = init.webSocket ?? null;
  }
  async json() {
    return JSON.parse(this.body);
  }
  async text() {
    return this.body === null ? '' : String(this.body);
  }
}
globalThis.Response = FakeResponse;

// The worker extends the runtime-global DurableObject class.
globalThis.DurableObject = class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
};

// Pending handler promises (message + close handlers). flush() drains them,
// including promises created while handling.
const pending = [];
async function flush() {
  while (pending.length > 0) {
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch);
  }
}

class FakeSocket {
  constructor(kind) {
    this.kind = kind; // 'client' | 'server'
    this.readyState = 1; // 1 = OPEN, 3 = CLOSED
    this.closed = false;
    this.peer = null;
    this.attachment = null;
    this.received = []; // client side: frames the server sent
    this._deliverToDO = null; // server side: (fromClient, data) => Promise
    this._onClose = null; // server side: (code, reason) => Promise
  }
  send(data) {
    if (this.closed) throw new Error('socket closed');
    if (this.kind === 'server') {
      this.peer.received.push(typeof data === 'string' ? data : String(data));
      return undefined;
    }
    return this.peer._deliverToDO(this, data);
  }
  close(code = 1000, reason = '') {
    if (this.closed) return undefined;
    this.closed = true;
    this.readyState = 3;
    if (this.peer) {
      this.peer.closed = true;
      this.peer.readyState = 3;
    }
    const hook = this.kind === 'server' ? this._onClose : this.peer._onClose;
    return hook ? hook(code, reason) : undefined;
  }
  serializeAttachment(v) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment === null ? null : structuredClone(this.attachment);
  }
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const client = new FakeSocket('client');
    const server = new FakeSocket('server');
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
};

// Fake DurableObjectState: real SQLite for storage.sql, an alarm slot, and
// the hibernation socket registry.
class FakeCtx {
  constructor(db) {
    this.db = db;
    this.sockets = [];
    this.alarmAt = null;
    this.storage = {
      sql: {
        exec: (query, ...params) => {
          if (query.trim().toUpperCase().startsWith('SELECT')) {
            const rows = db.prepare(query).all(...params);
            return { toArray: () => rows };
          }
          db.prepare(query).run(...params);
          return { toArray: () => [] };
        },
      },
      setAlarm: async (ts) => {
        this.alarmAt = ts;
      },
      getAlarm: async () => this.alarmAt,
      deleteAlarm: async () => {
        this.alarmAt = null;
      },
      deleteAll: async () => {
        db.exec('DROP TABLE IF EXISTS room_state');
      },
    };
  }
  acceptWebSocket(ws) {
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets.filter((s) => !s.closed);
  }
}

// ------------------------------------------------------- wiring + import

const { default: worker, YahtzeeRoom } = await import(new URL('../src/index.js', import.meta.url));

// One Durable Object instance per room code, like the real namespace.
const rooms = new Map(); // code -> { db, ctx, do }
function entryFor(code) {
  let entry = rooms.get(code);
  if (!entry) {
    const db = new DatabaseSync(':memory:');
    const ctx = new FakeCtx(db);
    entry = { db, ctx, do: new YahtzeeRoom(ctx, {}) };
    rooms.set(code, entry);
  }
  return entry;
}
const env = {
  YAHTZEE_ROOM: {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (req) => entryFor(id).do.fetch(req),
    }),
  },
};

// Drop the object instance but keep its storage + sockets: this is what
// hibernation eviction looks like from the inside. The next event rebuilds
// the instance from SQLite.
function evict(code) {
  const entry = rooms.get(code);
  entry.do = new YahtzeeRoom(entry.ctx, {});
  return entry.do;
}

// ------------------------------------------------------------ test helpers

const BASE = 'https://rooms.test';

async function http(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await worker.fetch(new Request(BASE + path, init), env);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

async function connectWs(code, playerId) {
  const req = new Request(`${BASE}/rooms/${code}/ws?playerId=${playerId}`, {
    headers: { Upgrade: 'websocket' },
  });
  const res = await worker.fetch(req, env);
  if (res.status !== 101) {
    return { status: res.status, data: JSON.parse(await res.text()), client: null };
  }
  const client = res.webSocket;
  const server = client.peer;
  server._deliverToDO = (fromClient, data) => {
    const p = rooms.get(code).do.webSocketMessage(server, data);
    pending.push(p);
    return p;
  };
  server._onClose = (codeNum, reason) => {
    const p = rooms.get(code).do.webSocketClose(server, codeNum, reason, true);
    pending.push(p);
    return p;
  };
  return { status: 101, data: null, client };
}

async function send(client, obj) {
  client.send(JSON.stringify(obj));
  await flush();
}

async function closeClient(client) {
  client.close();
  await flush();
}

function msgs(client, type) {
  const all = client.received.map((s) => JSON.parse(s));
  return type === undefined ? all : all.filter((m) => m.t === type);
}

function last(client, type) {
  const found = msgs(client, type);
  return found[found.length - 1];
}

// --------------------------------------------------------------- assertions

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ------------------------------------------------------------------- tests

console.log('Yahtzee rooms — local harness\n');

console.log('1. Health + room create');
{
  const health = await http('GET', '/');
  check('GET / returns ok', health.status === 200 && health.data.status === 'ok');
  const created = await http('POST', '/rooms', { name: 'Ann' });
  check('POST /rooms returns 201', created.status === 201, `got ${created.status}`);
  check(
    'code is 4 letters, no I or O',
    /^[A-HJ-NP-Z]{4}$/.test(created.data.code),
    `got ${created.data.code}`,
  );
  check('host gets seat 0', created.data.seat === 0);
  check('host gets a playerId', typeof created.data.playerId === 'string');
  check('room starts in lobby', created.data.room.phase === 'lobby');
  const created2 = await http('POST', '/rooms', { name: 'Bob' });
  check('second room gets a different code', created2.data.code !== created.data.code);
  globalThis.__code = created.data.code;
  globalThis.__host = created.data;
}

console.log('2. Status + join (2-4 players, room full)');
{
  const code = globalThis.__code;
  const status = await http('GET', `/rooms/${code}`);
  check('status shows 1 player', status.status === 200 && status.data.playerCount === 1);
  check('status shows lobby', status.data.phase === 'lobby');
  const joins = [];
  for (const name of ['Ben', 'Cat', 'Dan']) {
    joins.push(await http('POST', `/rooms/${code}/join`, { name }));
  }
  check('3 joins succeed', joins.every((j) => j.status === 200));
  check(
    'seats are 1, 2, 3',
    joins.map((j) => j.data.seat).join(',') === '1,2,3',
  );
  const full = await http('POST', `/rooms/${code}/join`, { name: 'Eve' });
  check('5th player gets 409 room_full', full.status === 409 && full.data.error === 'room_full');
  const fresh = await http('POST', '/rooms', { name: 'Ann' });
  const badName = await http('POST', `/rooms/${fresh.data.code}/join`, { name: '   ' });
  check('empty name rejected with 400', badName.status === 400 && badName.data.error === 'bad_name');
  const unknown = await http('POST', '/rooms/ZZZZ/join', { name: 'Zed' });
  check('join unknown room gets 404', unknown.status === 404);
  const unknownStatus = await http('GET', '/rooms/ZZZZ');
  check('status unknown room gets 404', unknownStatus.status === 404);
  globalThis.__players = [globalThis.__host, ...joins.map((j) => j.data)];
}

console.log('3. WebSocket connect + hello (all 4 players)');
{
  const code = globalThis.__code;
  const clients = [];
  for (const p of globalThis.__players) {
    const { status, client } = await connectWs(code, p.playerId);
    check(`ws upgrade for seat ${p.seat}`, status === 101, `got ${status}`);
    clients.push(client);
    await send(client, { t: 'hello' });
  }
  for (let i = 0; i < 4; i += 1) {
    const w = last(clients[i], 'welcome');
    check(`seat ${i} welcome carries its seat`, w && w.seat === i);
    check(`seat ${i} welcome carries the room`, w && w.room.code === code);
  }
  const state = last(clients[0], 'state');
  check(
    'state broadcast shows 4 connected',
    state && state.room.players.every((p) => p.connected),
  );
  const badWs = await connectWs(code, 'no-such-player');
  check('ws with unknown playerId gets 403', badWs.status === 403);
  const noUpgrade = await http('GET', `/rooms/${code}/ws?playerId=${globalThis.__host.playerId}`);
  check('plain GET on /ws gets 426', noUpgrade.status === 426);
  globalThis.__clients = clients;
}

console.log('4. Start: host only, 2+ players');
{
  const clients = globalThis.__clients;
  await send(clients[1], { t: 'start', game: { n: 0 } });
  check('non-host start rejected', last(clients[1], 'error')?.code === 'not_host');
  await send(clients[0], { t: 'start', game: { n: 0 } });
  const state = last(clients[3], 'state');
  check('host start moves room to playing', state && state.room.phase === 'playing');
  check('turn starts on seat 0', state && state.room.turn.playerId === globalThis.__host.playerId);
  check('round starts at 1', state && state.room.turn.round === 1);
  const lateJoin = await http('POST', `/rooms/${globalThis.__code}/join`, { name: 'Late' });
  check('new player cannot join a started game', lateJoin.status === 409 && lateJoin.data.error === 'game_started');
}

console.log('5. Moves broadcast to all; turn order enforced');
{
  const clients = globalThis.__clients;
  const [host, p1] = globalThis.__players;
  await send(clients[0], { t: 'move', move: { type: 'roll', roll: 1, dice: [1, 2, 3, 4, 5] }, game: { n: 1 } });
  const moveCount = clients.map((c) => msgs(c, 'move').length);
  check('roll move reaches all 4 clients', moveCount.join(',') === '1,1,1,1', moveCount.join(','));
  const m = last(clients[2], 'move');
  check('move carries seq 1', m && m.seq === 1);
  check('move carries the snapshot', m && m.game && m.game.n === 1);
  check('move names the sender', m && m.playerId === host.playerId);
  await send(clients[1], { t: 'move', move: { type: 'roll', roll: 1 }, game: { n: 2 } });
  check('non-turn move rejected', last(clients[1], 'error')?.code === 'not_your_turn');
  check(
    'rejected move is not broadcast',
    clients.every((c) => msgs(c, 'move').length === 1),
  );
  await send(clients[0], { t: 'move', move: { type: 'score', category: 'chance', points: 15 }, game: { n: 2 } });
  const m2 = last(clients[3], 'move');
  check('score move is seq 2', m2 && m2.seq === 2);
  check('turn advances to seat 1 after score', m2 && m2.turn.playerId === p1.playerId);
  check('round stays 1', m2 && m2.turn.round === 1);
}

console.log('6. Disconnect + rejoin the same seat');
{
  const code = globalThis.__code;
  const clients = globalThis.__clients;
  const p2 = globalThis.__players[2];
  await closeClient(clients[2]);
  const state = last(clients[0], 'state');
  const gone = state.room.players.find((p) => p.id === p2.playerId);
  check('disconnect marks the player offline', gone && gone.connected === false);
  check('seat is kept while disconnected', gone && gone.seat === 2);
  const { status, client } = await connectWs(code, p2.playerId);
  check('reconnect upgrade works', status === 101);
  await send(client, { t: 'hello' });
  const w = last(client, 'welcome');
  check('rejoin keeps seat 2', w && w.seat === 2);
  check('rejoin restores the snapshot', w && w.room.game && w.room.game.n === 2);
  check('rejoin restores the turn', w && w.room.turn.playerId === globalThis.__players[1].playerId);
  check('rejoin includes recent moves', Array.isArray(w.recentMoves) && w.recentMoves.length === 2);
  check('rejoin marks the player online again', w && w.room.players.find((p) => p.id === p2.playerId).connected === true);
  // A second socket for the same player replaces the first.
  const { client: dup } = await connectWs(code, p2.playerId);
  await send(dup, { t: 'hello' });
  check('duplicate socket replaces the old one', client.closed === true);
  check('replacement socket gets a welcome', last(dup, 'welcome')?.seat === 2);
  globalThis.__clients[2] = dup;
}

console.log('7. Hibernation: evict the object, state survives in SQLite');
{
  const code = globalThis.__code;
  const before = rooms.get(code).do.room;
  const rebuilt = evict(code);
  check('state reloads after eviction', rebuilt.room !== null);
  check('phase survives', rebuilt.room.phase === 'playing');
  check('seq survives', rebuilt.room.seq === before.seq);
  check('turn survives', rebuilt.room.turn.playerId === before.turn.playerId);
  check('snapshot survives', rebuilt.room.game.n === 2);
  check('all 4 players survive', rebuilt.room.players.length === 4);
  // An existing socket still works through the rebuilt instance.
  const clients = globalThis.__clients;
  await send(clients[1], { t: 'move', move: { type: 'roll', roll: 1 }, game: { n: 3 } });
  check(
    'move works after eviction',
    last(clients[0], 'move')?.seq === 3 && last(clients[0], 'move')?.game.n === 3,
  );
}

console.log('8. Full game to finish, then rematch');
{
  const created = await http('POST', '/rooms', { name: 'Ann' });
  const code = created.data.code;
  const joined = await http('POST', `/rooms/${code}/join`, { name: 'Ben' });
  const c0 = (await connectWs(code, created.data.playerId)).client;
  const c1 = (await connectWs(code, joined.data.playerId)).client;
  await send(c0, { t: 'hello' });
  await send(c1, { t: 'hello' });
  await send(c0, { t: 'start', game: { n: 0 } });
  check('2-player game starts', last(c1, 'state')?.room.phase === 'playing');
  const clients = [c0, c1];
  const ids = [created.data.playerId, joined.data.playerId];
  // 13 rounds x 2 players = 26 scoring moves.
  for (let i = 0; i < 26; i += 1) {
    const turnId = rooms.get(code).do.room.turn.playerId;
    const idx = ids.indexOf(turnId);
    await send(clients[idx], {
      t: 'move',
      move: { type: 'score', category: 'chance', points: 10 },
      game: { n: i + 1 },
    });
  }
  const room = rooms.get(code).do.room;
  check('game finishes after 13 rounds', room.phase === 'finished');
  check('turn clears at finish', room.turn.playerId === null);
  check('26 moves sequenced', room.seq === 26);
  const fin = last(c1, 'move');
  check('final move broadcast says finished', fin && fin.phase === 'finished');
  await send(c0, { t: 'rematch', game: { n: 0 } });
  const again = rooms.get(code).do.room;
  check('rematch restarts the game', again.phase === 'playing');
  check('rematch resets the round', again.turn.round === 1);
  check('rematch resets the sequence', again.seq === 0);
  check('rematch turn returns to seat 0', again.turn.playerId === ids[0]);
  await closeClient(c0);
  await closeClient(c1);
}

console.log('9. Host close + alarm cleanup of empty rooms');
{
  // Host close: everyone hears it, the room is gone.
  const created = await http('POST', '/rooms', { name: 'Ann' });
  const code2 = created.data.code;
  const joined = await http('POST', `/rooms/${code2}/join`, { name: 'Ben' });
  const c0 = (await connectWs(code2, created.data.playerId)).client;
  const c1 = (await connectWs(code2, joined.data.playerId)).client;
  await send(c0, { t: 'hello' });
  await send(c1, { t: 'hello' });
  await send(c0, { t: 'close' });
  check('host close tells the other player', last(c1, 'closed')?.reason === 'host_closed');
  check('closed room status is 404', (await http('GET', `/rooms/${code2}`)).status === 404);

  // Alarm: a live room is NOT deleted, and the alarm re-arms.
  const live = await http('POST', '/rooms', { name: 'Ann' });
  const liveCode = live.data.code;
  const lc = (await connectWs(liveCode, live.data.playerId)).client;
  await send(lc, { t: 'hello' });
  const liveEntry = rooms.get(liveCode);
  liveEntry.do.room.lastActivityAt = Date.now() - 61 * 60 * 1000; // quiet for over an hour...
  liveEntry.do.saveRoom();
  await liveEntry.do.alarm();
  check('alarm keeps a room with a connected player', liveEntry.do.room !== null);
  check('alarm re-arms', liveEntry.ctx.alarmAt > Date.now());

  // Alarm: an empty room quiet for over an hour IS deleted.
  await closeClient(lc);
  liveEntry.do.room.lastActivityAt = Date.now() - 61 * 60 * 1000;
  liveEntry.do.saveRoom();
  await liveEntry.do.alarm();
  check('alarm deletes an abandoned room', liveEntry.do.room === null);
  check('deleted room status is 404', (await http('GET', `/rooms/${liveCode}`)).status === 404);
  check('deleted room join is 404', (await http('POST', `/rooms/${liveCode}/join`, { name: 'Zed' })).status === 404);
}

console.log('10. Leave frees the seat; host passes on');
{
  const created = await http('POST', '/rooms', { name: 'Ann' });
  const code = created.data.code;
  const j1 = await http('POST', `/rooms/${code}/join`, { name: 'Ben' });
  const j2 = await http('POST', `/rooms/${code}/join`, { name: 'Cat' });
  const c0 = (await connectWs(code, created.data.playerId)).client;
  const c1 = (await connectWs(code, j1.data.playerId)).client;
  const c2 = (await connectWs(code, j2.data.playerId)).client;
  await send(c0, { t: 'hello' });
  await send(c1, { t: 'hello' });
  await send(c2, { t: 'hello' });
  await send(c1, { t: 'leave' });
  const state = last(c0, 'state');
  check('leave removes the player', state && state.room.players.length === 2);
  const rej = await http('POST', `/rooms/${code}/join`, { name: 'Dan' });
  check('freed seat is reused (seat 1)', rej.data.seat === 1);
  await send(c0, { t: 'leave' });
  const state2 = last(c2, 'state');
  // Host passes to the lowest remaining seat: Dan took seat 1, Cat is seat 2.
  check('host passes to the lowest remaining seat', state2 && state2.room.hostId === rej.data.playerId);
  await closeClient(c2);
}

// ---------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('Failed tests:');
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log('All tests passed.');
