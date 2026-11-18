// Yahtzee online rooms — Cloudflare Worker + Durable Object (Workers Free).
//
// One Durable Object = one game room. The server sequences and broadcasts
// moves and holds the shared state; the scoring rules stay in the game
// client, which sends the resulting snapshot with each move.
//
// Design notes (all load-bearing, keep them true):
// - Hibernation: sockets are accepted with ctx.acceptWebSocket, so an idle
//   room costs ~0 duration. All room state lives in the object's SQLite
//   store (one JSON row) and is reloaded synchronously in the constructor,
//   because hibernation wipes in-memory state. Per-socket identity lives in
//   the socket attachment, which survives hibernation.
// - The server never rolls dice and never scores. It checks whose turn it
//   is, stamps each move with a sequence number, stores the snapshot the
//   acting client sent, and broadcasts. That is the whole authority.
// - No secrets, no external dependencies, no build step.
//
// Deploy: wrangler deploy   (see DEPLOY.md)
// Protocol: PROTOCOL.md

const MAX_PLAYERS = 4;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — easier to read aloud
const CODE_LENGTH = 4;
const MAX_NAME = 20;
const MAX_MESSAGE_BYTES = 64 * 1024; // one WebSocket frame
const MAX_SNAPSHOT_BYTES = 32 * 1024; // one game snapshot
const MOVE_LOG_CAP = 100; // moves kept server-side (audit only, not broadcast)
const RECENT_MOVES_SENT = 10; // moves included in a welcome, so a rejoining client can rebuild its log
const EMPTY_ROOM_TTL_MS = 60 * 60 * 1000; // nobody connected for an hour -> room is deleted
const ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000; // backstop: no room lives past a day
const ROUNDS = 13;
const VERSION = '1.0.0';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

function randomCode() {
  const buf = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  let code = '';
  for (const b of buf) code += CODE_LETTERS[b % CODE_LETTERS.length];
  return code;
}

function cleanCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{4,6}$/.test(code) ? code : null;
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  return name.length > 0 ? name : null;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------- Worker

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return json({ name: 'yahtzee-rooms', version: VERSION, status: 'ok' });
      }
      if (url.pathname === '/rooms' && request.method === 'POST') {
        return await createRoom(request, env);
      }
      const m = url.pathname.match(/^\/rooms\/([A-Za-z]{4,6})(?:\/(join|ws))?$/);
      if (m) {
        const code = m[1].toUpperCase();
        const stub = env.YAHTZEE_ROOM.get(env.YAHTZEE_ROOM.idFromName(code));
        if (!m[2] && request.method === 'GET') {
          return stub.fetch(new Request('https://room/status', request));
        }
        if (m[2] === 'join' && request.method === 'POST') {
          return stub.fetch(new Request('https://room/join', request));
        }
        if (m[2] === 'ws' && request.method === 'GET') {
          return stub.fetch(new Request('https://room/ws' + url.search, request));
        }
      }
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      return json({ error: 'server_error', message: String((err && err.message) || err) }, 500);
    }
  },
};

async function createRoom(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const name = cleanName(body.name) || 'Host';
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const stub = env.YAHTZEE_ROOM.get(env.YAHTZEE_ROOM.idFromName(code));
    const res = await stub.fetch(
      new Request('https://room/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name }),
      }),
    );
    if (res.status === 201) return json(await res.json(), 201);
    if (res.status !== 409) return json({ error: 'server_error' }, 500);
    // 409 = code collision (a room already lives there); try another code.
  }
  return json({ error: 'could_not_create_room' }, 500);
}

// ------------------------------------------------------- Durable Object
//
// DurableObject is a runtime global in Workers (the same class the
// cloudflare:workers module re-exports). The Node test harness defines the
// same global before importing this file.

export class YahtzeeRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY, json TEXT NOT NULL)',
    );
    this.room = this.loadRoom();
  }

  // -- persistence: the whole room is one JSON row, rewritten on every
  // mutation. Reads are synchronous (SQLite), so the constructor can load
  // state before the first event lands after hibernation.
  loadRoom() {
    const rows = this.sql.exec('SELECT json FROM room_state WHERE id = 1').toArray();
    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].json);
    } catch {
      return null;
    }
  }

  saveRoom() {
    this.room.updatedAt = Date.now();
    this.sql.exec(
      'INSERT OR REPLACE INTO room_state (id, json) VALUES (1, ?)',
      JSON.stringify(this.room),
    );
  }

  deleteRoom() {
    this.sql.exec('DELETE FROM room_state WHERE id = 1');
    this.room = null;
  }

  // -- HTTP entry points (called by the Worker, not directly by clients)
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/create' && request.method === 'POST') return this.create(request);
    if (url.pathname === '/status' && request.method === 'GET') return this.status();
    if (url.pathname === '/join' && request.method === 'POST') return this.join(request);
    if (url.pathname === '/ws' && request.method === 'GET') return this.upgrade(request);
    return json({ error: 'not_found' }, 404);
  }

  async create(request) {
    if (this.room) return json({ error: 'room_exists' }, 409);
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const code = cleanCode(body.code);
    if (!code) return json({ error: 'bad_code' }, 400);
    const hostId = crypto.randomUUID();
    const now = Date.now();
    this.room = {
      code,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      phase: 'lobby',
      hostId,
      players: [
        {
          id: hostId,
          name: cleanName(body.name) || 'Host',
          seat: 0,
          connected: false,
          joinedAt: now,
          lastSeenAt: now,
        },
      ],
      turn: { playerId: null, round: 1, roll: 0 },
      game: null,
      moves: [],
      seq: 0,
      version: 0,
    };
    this.saveRoom();
    // Backstop alarm: a room nobody ever joins still gets cleaned up.
    await this.ctx.storage.setAlarm(now + ROOM_MAX_AGE_MS);
    return json({ code, playerId: hostId, seat: 0, room: this.publicRoom() }, 201);
  }

  status() {
    if (!this.room) return json({ error: 'room_not_found' }, 404);
    return json({
      code: this.room.code,
      phase: this.room.phase,
      playerCount: this.room.players.length,
      maxPlayers: MAX_PLAYERS,
      players: this.room.players.map((p) => ({ name: p.name, seat: p.seat, connected: p.connected })),
    });
  }

  async join(request) {
    if (!this.room) return json({ error: 'room_not_found' }, 404);
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    // Rejoining with a known playerId is always allowed, even mid-game.
    if (typeof body.playerId === 'string') {
      const existing = this.room.players.find((p) => p.id === body.playerId);
      if (existing) {
        return json({ playerId: existing.id, seat: existing.seat, room: this.publicRoom() });
      }
    }
    if (this.room.phase !== 'lobby') {
      return json({ error: 'game_started', message: 'This game already started.' }, 409);
    }
    if (this.room.players.length >= MAX_PLAYERS) {
      return json({ error: 'room_full', message: 'This room is full.' }, 409);
    }
    const name = cleanName(body.name);
    if (!name) return json({ error: 'bad_name' }, 400);
    const taken = new Set(this.room.players.map((p) => p.seat));
    let seat = 0;
    while (taken.has(seat)) seat += 1;
    const player = {
      id: crypto.randomUUID(),
      name,
      seat,
      connected: false,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.room.players.push(player);
    this.room.version += 1;
    this.room.lastActivityAt = Date.now();
    this.saveRoom();
    this.broadcast({ t: 'state', room: this.publicRoom() });
    return json({ playerId: player.id, seat: player.seat, room: this.publicRoom() });
  }

  upgrade(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return json({ error: 'expected_websocket' }, 426);
    }
    if (!this.room) return json({ error: 'room_not_found' }, 404);
    const playerId = new URL(request.url).searchParams.get('playerId');
    const player = this.room.players.find((p) => p.id === playerId);
    if (!player) return json({ error: 'not_in_room' }, 403);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // acceptWebSocket (not server.accept) is what lets the object hibernate
    // while this connection stays open.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId });
    return new Response(null, { status: 101, webSocket: client });
  }

  // -- WebSocket handlers (Hibernation API: the runtime calls these, and
  // wakes the object from hibernation first when needed)

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    if (message.length > MAX_MESSAGE_BYTES) {
      return this.send(ws, { t: 'error', code: 'message_too_large' });
    }
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return this.send(ws, { t: 'error', code: 'bad_json' });
    }
    if (!isPlainObject(msg) || typeof msg.t !== 'string') {
      return this.send(ws, { t: 'error', code: 'bad_message' });
    }
    const playerId = (ws.deserializeAttachment() || {}).playerId;
    if (!this.room || !playerId) return this.send(ws, { t: 'error', code: 'not_in_room' });
    const player = this.room.players.find((p) => p.id === playerId);
    if (!player) return this.send(ws, { t: 'error', code: 'not_in_room' });

    switch (msg.t) {
      case 'hello':
        return this.onHello(ws, player);
      case 'ping':
        return this.send(ws, { t: 'pong', version: this.room.version });
      case 'start':
        return this.onStart(ws, player, msg);
      case 'move':
        return this.onMove(ws, player, msg);
      case 'rematch':
        return this.onRematch(ws, player, msg);
      case 'leave':
        return this.onLeave(ws, player);
      case 'close':
        return this.onClose(ws, player);
      default:
        return this.send(ws, { t: 'error', code: 'unknown_message' });
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const playerId = (ws.deserializeAttachment() || {}).playerId;
    if (!this.room || !playerId) return;
    const player = this.room.players.find((p) => p.id === playerId);
    if (!player || !player.connected) return;
    // A player with another live socket (second tab) stays connected.
    const stillOpen = this.ctx
      .getWebSockets()
      .some((s) => s !== ws && (s.deserializeAttachment() || {}).playerId === playerId);
    if (stillOpen) return;
    player.connected = false;
    player.lastSeenAt = Date.now();
    this.room.lastActivityAt = Date.now();
    this.saveRoom();
    this.broadcast({ t: 'state', room: this.publicRoom() });
    if (!this.room.players.some((p) => p.connected)) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    }
  }

  async webSocketError(ws, error) {
    // Treat an errored socket exactly like a closed one.
    return this.webSocketClose(ws, 1011, 'error', false);
  }

  // -- message handlers

  onHello(ws, player) {
    // A reconnect replaces any older socket for the same player.
    for (const s of this.ctx.getWebSockets()) {
      if (s !== ws && (s.deserializeAttachment() || {}).playerId === player.id) {
        try {
          s.close(1000, 'replaced');
        } catch {
          /* already gone */
        }
      }
    }
    player.connected = true;
    player.lastSeenAt = Date.now();
    this.room.lastActivityAt = Date.now();
    this.saveRoom();
    this.send(ws, {
      t: 'welcome',
      playerId: player.id,
      seat: player.seat,
      room: this.publicRoom(),
      recentMoves: this.room.moves.slice(-RECENT_MOVES_SENT),
    });
    this.broadcast({ t: 'state', room: this.publicRoom() }, ws);
  }

  onStart(ws, player, msg) {
    if (player.id !== this.room.hostId) {
      return this.send(ws, { t: 'error', code: 'not_host' });
    }
    if (this.room.phase !== 'lobby') {
      return this.send(ws, { t: 'error', code: 'wrong_phase' });
    }
    if (this.room.players.length < 2) {
      return this.send(ws, { t: 'error', code: 'need_players' });
    }
    const snapshot = this.validSnapshot(msg.game);
    if (!snapshot) return this.send(ws, { t: 'error', code: 'bad_snapshot' });
    const first = [...this.room.players].sort((a, b) => a.seat - b.seat)[0];
    this.room.phase = 'playing';
    this.room.turn = { playerId: first.id, round: 1, roll: 0 };
    this.room.game = snapshot;
    this.room.moves = [];
    this.room.seq = 0;
    this.room.version += 1;
    this.room.lastActivityAt = Date.now();
    this.saveRoom();
    this.broadcast({ t: 'state', room: this.publicRoom() });
  }

  onMove(ws, player, msg) {
    if (this.room.phase !== 'playing') {
      return this.send(ws, { t: 'error', code: 'wrong_phase' });
    }
    if (!isPlainObject(msg.move) || typeof msg.move.type !== 'string') {
      return this.send(ws, { t: 'error', code: 'bad_move' });
    }
    const type = msg.move.type;
    if (!['roll', 'hold', 'score', 'skip'].includes(type)) {
      return this.send(ws, { t: 'error', code: 'bad_move' });
    }
    if (type === 'skip') {
      if (player.id !== this.room.hostId) {
        return this.send(ws, { t: 'error', code: 'not_host' });
      }
    } else if (player.id !== this.room.turn.playerId) {
      return this.send(ws, { t: 'error', code: 'not_your_turn' });
    }
    // roll / hold / score carry the resulting snapshot; skip may omit it.
    let snapshot = null;
    if (msg.game !== undefined) {
      snapshot = this.validSnapshot(msg.game);
      if (!snapshot) return this.send(ws, { t: 'error', code: 'bad_snapshot' });
    } else if (type !== 'skip') {
      return this.send(ws, { t: 'error', code: 'bad_snapshot' });
    }
    this.room.seq += 1;
    this.room.version += 1;
    this.room.moves.push({
      seq: this.room.seq,
      playerId: player.id,
      type,
      payload: msg.move,
      at: Date.now(),
    });
    if (this.room.moves.length > MOVE_LOG_CAP) {
      this.room.moves.splice(0, this.room.moves.length - MOVE_LOG_CAP);
    }
    if (snapshot) this.room.game = snapshot;
    if (type === 'roll' || type === 'hold') {
      const roll = Number.isFinite(msg.move.roll) ? Math.max(0, Math.min(3, msg.move.roll)) : this.room.turn.roll;
      this.room.turn.roll = roll;
    }
    if (type === 'score' || type === 'skip') this.advanceTurn();
    this.room.lastActivityAt = Date.now();
    this.saveRoom();
    this.broadcast({
      t: 'move',
      seq: this.room.seq,
      playerId: player.id,
      move: msg.move,
      phase: this.room.phase,
      turn: this.room.turn,
      version: this.room.version,
      game: this.room.game,
    });
  }

  onRematch(ws, player, msg) {
    if (player.id !== this.room.hostId) {
      return this.send(ws, { t: 'error', code: 'not_host' });
    }
    if (this.room.phase !== 'finished') {
      return this.send(ws, { t: 'error', code: 'wrong_phase' });
    }
    const snapshot = this.validSnapshot(msg.game);
    if (!snapshot) return this.send(ws, { t: 'error', code: 'bad_snapshot' });
    const first = [...this.room.players].sort((a, b) => a.seat - b.seat)[0];
    this.room.phase = 'playing';
    this.room.turn = { playerId: first.id, round: 1, roll: 0 };
    this.room.game = snapshot;
    this.room.moves = [];
    this.room.seq = 0;
    this.room.version += 1;
    this.room.lastActivityAt = Date.now();
    this.saveRoom();
    this.broadcast({ t: 'state', room: this.publicRoom() });
  }

  onLeave(ws, player) {
    // If the leaver held the turn, advance it first (while they are still
    // in the seat order, so the turn lands on the next player).
    if (this.room.phase === 'playing' && this.room.turn.playerId === player.id) {
      this.advanceTurn();
    }
    this.room.players = this.room.players.filter((p) => p.id !== player.id);
    if (player.id === this.room.hostId) {
      const next = [...this.room.players].sort((a, b) => a.seat - b.seat)[0];
      this.room.hostId = next ? next.id : null;
    }
    this.room.version += 1;
    this.room.lastActivityAt = Date.now();
    if (this.room.players.length === 0) {
      this.broadcast({ t: 'closed', reason: 'room_empty' });
      this.closeAllSockets();
      this.deleteRoom();
      return;
    }
    this.saveRoom();
    this.broadcast({ t: 'state', room: this.publicRoom() });
    try {
      ws.close(1000, 'left');
    } catch {
      /* already gone */
    }
  }

  onClose(ws, player) {
    if (player.id !== this.room.hostId) {
      return this.send(ws, { t: 'error', code: 'not_host' });
    }
    this.broadcast({ t: 'closed', reason: 'host_closed' });
    this.closeAllSockets();
    this.deleteRoom();
  }

  // -- turn order: seats in ascending order; the round ticks when the turn
  // wraps back to the lowest seat. After round 13 the game is finished.
  advanceTurn() {
    const players = [...this.room.players].sort((a, b) => a.seat - b.seat);
    if (!players.length) {
      this.room.turn = { playerId: null, round: 1, roll: 0 };
      return;
    }
    const idx = players.findIndex((p) => p.id === this.room.turn.playerId);
    const nextIdx = idx < 0 ? 0 : (idx + 1) % players.length;
    let round = this.room.turn.round;
    if (idx >= 0 && nextIdx === 0) round += 1;
    if (round > ROUNDS) {
      this.room.phase = 'finished';
      this.room.turn = { playerId: null, round: ROUNDS, roll: 0 };
      return;
    }
    this.room.turn = { playerId: players[nextIdx].id, round, roll: 0 };
  }

  // -- cleanup: one alarm slot. Armed for +24h at creation, re-armed for
  // +1h when the last player disconnects. On firing, an empty room that has
  // been quiet for an hour (or any room past a day) is deleted; a live room
  // re-arms for whichever deadline comes first.
  async alarm() {
    if (!this.room) return;
    const now = Date.now();
    // Idle time keys on lastActivityAt only: updatedAt is refreshed by
    // every save (including the save that records a disconnect), so it
    // would always read as "just now" and the room would never expire.
    // createdAt is only a fallback for a room that somehow has no
    // lastActivityAt — never max()ed in, or a young room could never
    // count as idle.
    const lastActive = this.room.lastActivityAt || this.room.createdAt;
    const anyoneConnected = this.room.players.some((p) => p.connected);
    const expired = now - this.room.createdAt > ROOM_MAX_AGE_MS;
    const abandoned = !anyoneConnected && now - lastActive > EMPTY_ROOM_TTL_MS;
    if (this.room.players.length === 0 || expired || abandoned) {
      this.broadcast({ t: 'closed', reason: 'room_expired' });
      this.closeAllSockets();
      this.deleteRoom();
      return;
    }
    const next = Math.min(
      this.room.createdAt + ROOM_MAX_AGE_MS,
      lastActive + EMPTY_ROOM_TTL_MS,
    );
    await this.ctx.storage.setAlarm(Math.max(next, now + 60 * 1000));
  }

  // -- helpers

  validSnapshot(game) {
    if (!isPlainObject(game)) return null;
    const text = JSON.stringify(game);
    if (text.length > MAX_SNAPSHOT_BYTES) return null;
    return game;
  }

  // The state clients see. The move log stays server-side (audit only);
  // a rejoining client gets the snapshot, which is the whole truth.
  publicRoom() {
    return {
      code: this.room.code,
      phase: this.room.phase,
      hostId: this.room.hostId,
      players: this.room.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        connected: p.connected,
        joinedAt: p.joinedAt,
        lastSeenAt: p.lastSeenAt,
      })),
      turn: { ...this.room.turn },
      game: this.room.game,
      seq: this.room.seq,
      version: this.room.version,
      createdAt: this.room.createdAt,
      updatedAt: this.room.updatedAt,
    };
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket died; the close handler cleans up */
    }
  }

  broadcast(msg, exceptWs = null) {
    const data = JSON.stringify(msg);
    for (const s of this.ctx.getWebSockets()) {
      if (exceptWs && s === exceptWs) continue;
      try {
        s.send(data);
      } catch {
        /* socket died; the close handler cleans up */
      }
    }
  }

  closeAllSockets() {
    for (const s of this.ctx.getWebSockets()) {
      try {
        s.close(1000, 'room_closed');
      } catch {
        /* already gone */
      }
    }
  }
}
