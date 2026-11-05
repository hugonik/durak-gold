'use strict';
// Сервер онлайн-дурака: раздаёт игру (public/index.html) и держит комнаты по ссылке
// через WebSocket. Вся игровая логика — в engine.js, клиентам доверия нет.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const engine = require('./engine');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без O/0/I/1
const ROOM_CODE_LEN = 5;
const RECONNECT_GRACE_MS = 60 * 1000;      // сколько ждём вернувшегося игрока
const EMPTY_ROOM_TTL_MS = 15 * 60 * 1000;  // комната без живых игроков
const MAX_ROOMS = 2000;
const MAX_MSG_BYTES = 2048;
const MSG_RATE_LIMIT = 20;                 // сообщений за 5 секунд на сокет

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'
};

function createServer(opts = {}) {
  const rooms = new Map();
  const stats = { connections: 0, gamesStarted: 0, gamesFinished: 0 };

  // ---------- HTTP: статика и healthcheck ----------
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, ...stats }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  // ---------- Комнаты ----------
  function newCode() {
    for (let i = 0; i < 50; i++) {
      let c = '';
      for (let k = 0; k < ROOM_CODE_LEN; k++) c += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }
  const newToken = () => crypto.randomBytes(16).toString('hex');
  const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function startGame(room, firstAttacker) {
    room.game = engine.createGame({ mode: room.mode, deckSize: room.deckSize, firstAttacker });
    room.rematch = [false, false];
    room.finishedCounted = false;
    stats.gamesStarted++;
  }

  function sendState(room, seatIdx) {
    const seat = room.seats[seatIdx];
    if (!seat || !seat.ws) return;
    const opp = room.seats[1 - seatIdx];
    if (!room.game) {
      send(seat.ws, { t: 'waiting', room: room.code, mode: room.mode, deckSize: room.deckSize });
      return;
    }
    send(seat.ws, {
      t: 'state',
      room: room.code,
      ...engine.viewFor(room.game, seatIdx),
      oppConnected: !!(opp && opp.connected),
      oppDeadline: opp && !opp.connected ? opp.deadline : null,
      rematch: [room.rematch[seatIdx], room.rematch[1 - seatIdx]]
    });
  }
  function broadcast(room) {
    sendState(room, 0);
    sendState(room, 1);
    if (room.game && room.game.over && !room.finishedCounted) { room.finishedCounted = true; stats.gamesFinished++; }
  }

  function destroyRoomIfEmpty(room) {
    if (!room.seats[0] && !room.seats[1]) rooms.delete(room.code);
  }

  function clearDeadline(seat) {
    if (seat && seat.timer) { clearTimeout(seat.timer); seat.timer = null; }
    if (seat) seat.deadline = null;
  }

  function detach(ws, voluntary) {
    const ctx = ws.ctx;
    if (!ctx) return;
    ws.ctx = null;
    const room = rooms.get(ctx.code);
    if (!room) return;
    const seat = room.seats[ctx.seat];
    if (!seat || seat.ws !== ws) return; // сокет уже заменён переподключением

    room.lastActive = Date.now();
    const running = room.game && !room.game.over && room.seats[1 - ctx.seat];

    if (voluntary) {
      clearDeadline(seat);
      if (running) { engine.forfeit(room.game, ctx.seat); }
      room.seats[ctx.seat] = null;
      destroyRoomIfEmpty(room);
      if (rooms.has(room.code)) {
        // Если выходят до начала (ждали соперника) — комнату можно просто закрыть.
        if (!room.game) { /* сидящий остаётся, комната живёт */ }
        broadcast(room);
        if (room.game && room.game.over) { /* соперник увидит победу/сдачу */ }
      }
      return;
    }

    // Обрыв соединения: ждём возвращения.
    seat.ws = null;
    seat.connected = false;
    if (running) {
      seat.deadline = Date.now() + RECONNECT_GRACE_MS;
      seat.timer = setTimeout(() => {
        seat.timer = null;
        if (room.game && !room.game.over && !seat.connected) {
          engine.forfeit(room.game, ctx.seat);
          broadcast(room);
        }
      }, RECONNECT_GRACE_MS);
    }
    broadcast(room);
  }

  function attach(room, seatIdx, ws) {
    const seat = room.seats[seatIdx];
    if (seat.ws && seat.ws !== ws) { const old = seat.ws; seat.ws = null; old.ctx = null; try { old.close(4000, 'replaced'); } catch (e) {} }
    seat.ws = ws;
    seat.connected = true;
    clearDeadline(seat);
    ws.ctx = { code: room.code, seat: seatIdx };
    room.lastActive = Date.now();
    send(ws, { t: 'joined', room: room.code, token: seat.token, seat: seatIdx, mode: room.mode, deckSize: room.deckSize });
  }

  // ---------- Обработка сообщений ----------
  function handle(ws, msg) {
    switch (msg.t) {
      case 'ping': send(ws, { t: 'pong' }); return;

      case 'create': {
        if (ws.ctx) detach(ws, true);
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'busy', msg: 'Сервер перегружен, попробуйте позже' });
        const code = newCode();
        if (!code) return send(ws, { t: 'error', code: 'busy', msg: 'Не удалось создать комнату' });
        const room = {
          code,
          mode: msg.mode === 'transfer' ? 'transfer' : 'classic',
          deckSize: [24, 36, 52].includes(msg.deckSize) ? msg.deckSize : 36,
          seats: [null, null], game: null, rematch: [false, false],
          createdAt: Date.now(), lastActive: Date.now(), finishedCounted: false
        };
        room.seats[0] = { token: newToken(), ws: null, connected: false, timer: null, deadline: null };
        rooms.set(code, room);
        attach(room, 0, ws);
        broadcast(room); // отправит 'waiting'
        return;
      }

      case 'join': {
        const code = String(msg.room || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return send(ws, { t: 'error', code: 'no_room', msg: 'Комната не найдена или уже закрыта' });
        if (ws.ctx && !(ws.ctx.code === code)) detach(ws, true);

        // возвращение по токену
        let seatIdx = -1;
        if (typeof msg.token === 'string') seatIdx = room.seats.findIndex(s => s && s.token === msg.token);
        if (seatIdx < 0) {
          seatIdx = room.seats.findIndex(s => !s);
          if (seatIdx < 0) return send(ws, { t: 'error', code: 'full', msg: 'В комнате уже два игрока' });
          room.seats[seatIdx] = { token: newToken(), ws: null, connected: false, timer: null, deadline: null };
        }
        attach(room, seatIdx, ws);
        if (!room.game && room.seats[0] && room.seats[1]) startGame(room);
        broadcast(room);
        return;
      }

      case 'move': {
        const ctx = ws.ctx;
        const room = ctx && rooms.get(ctx.code);
        if (!room || !room.game) return send(ws, { t: 'error', code: 'no_game', msg: 'Игра ещё не началась' });
        const r = engine.applyMove(room.game, ctx.seat, msg);
        room.lastActive = Date.now();
        if (!r.ok) {
          send(ws, { t: 'error', code: 'illegal', msg: r.error });
          sendState(room, ctx.seat); // на случай рассинхрона — пришлём актуальное
          return;
        }
        broadcast(room);
        return;
      }

      case 'rematch': {
        const ctx = ws.ctx;
        const room = ctx && rooms.get(ctx.code);
        if (!room || !room.game || !room.game.over) return;
        if (!room.seats[0] || !room.seats[1] || room.game.reason === 'forfeit') {
          return send(ws, { t: 'error', code: 'no_rematch', msg: 'Соперник вышел — реванш недоступен' });
        }
        room.rematch[ctx.seat] = true;
        if (room.rematch[0] && room.rematch[1]) {
          const loser = room.game.loser;
          startGame(room, loser === 0 || loser === 1 ? loser : undefined); // проигравший ходит первым
        }
        broadcast(room);
        return;
      }

      case 'leave':
        detach(ws, true);
        send(ws, { t: 'left' });
        return;

      default:
        send(ws, { t: 'error', code: 'bad_msg', msg: 'Неизвестная команда' });
    }
  }

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MSG_BYTES });
  wss.on('connection', ws => {
    stats.connections++;
    ws.isAlive = true;
    ws.ctx = null;
    ws.winStart = Date.now();
    ws.winCount = 0;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      const now = Date.now();
      if (now - ws.winStart > 5000) { ws.winStart = now; ws.winCount = 0; }
      if (++ws.winCount > (opts.rateLimit || MSG_RATE_LIMIT)) { try { ws.close(1008, 'rate limit'); } catch (e) {} return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      try { handle(ws, msg); } catch (e) { console.error('handler error', e); send(ws, { t: 'error', code: 'server', msg: 'Ошибка сервера' }); }
    });
    ws.on('close', () => detach(ws, false));
    ws.on('error', () => {});
  });

  // keep-alive (прокси вроде Render/Fly рвут «молчащие» соединения) + уборка комнат
  const hb = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, 25000);
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const live = room.seats.some(s => s && s.connected);
      if (!live && now - room.lastActive > EMPTY_ROOM_TTL_MS) {
        room.seats.forEach(clearDeadline);
        rooms.delete(code);
      }
    }
  }, 60 * 1000);
  hb.unref(); sweep.unref();

  return {
    httpServer, wss, rooms, stats,
    listen(port, cb) { return httpServer.listen(port, cb); },
    close(cb) {
      clearInterval(hb); clearInterval(sweep);
      for (const room of rooms.values()) room.seats.forEach(clearDeadline);
      wss.clients.forEach(c => c.terminate());
      wss.close(() => httpServer.close(cb));
    }
  };
}

module.exports = { createServer, RECONNECT_GRACE_MS };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const srv = createServer();
  srv.listen(port, () => console.log(`Durak online server on :${port}`));
  const stop = () => srv.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
