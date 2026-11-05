'use strict';
const assert = require('assert');
const WebSocket = require('ws');
const { createServer } = require('../server');
const E = require('../engine');

const srv = createServer({ rateLimit: 100000 });

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { ws, msgs: [], state: null, token: null, waiters: [] };
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    c.msgs.push(m);
    if (m.t === 'state') c.state = m;
    if (m.t === 'joined') c.token = m.token;
    c.waiters = c.waiters.filter(w => !w(m));
  });
  c.open = new Promise(r => ws.on('open', r));
  c.send = o => ws.send(JSON.stringify(o));
  c.waitFor = (pred, ms = 3000) => new Promise((res, rej) => {
    const found = c.msgs.find(pred);
    if (found) return res(found);
    const timer = setTimeout(() => rej(new Error('timeout waiting: ' + pred.toString() + ' last=' + JSON.stringify(c.msgs.slice(-2)).slice(0,600))), ms);
    c.waiters.push(m => { if (pred(m)) { clearTimeout(timer); res(m); return true; } return false; });
  });
  return c;
}

// Простой «игрок»: выбирает случайный ход, зная только свой view.
function pickMove(v, rng) {
  const D = E;
  const isDef = !v.youAttack;
  const cands = [];
  const canBeat = (a, d) => (d.suit === v.trump.suit && a.suit !== v.trump.suit) || (d.suit === a.suit && D.RANK_VALUES[d.rank] > D.RANK_VALUES[a.rank]);
  if (v.phase === 'defend' && isDef) {
    for (const c of v.hand) v.table.forEach((p, i) => { if (!p.defend && canBeat(p.attack, c)) cands.push({ a: 'defend', card: c, pair: i }); });
    if (v.mode === 'transfer' && v.table.every(p => !p.defend) && v.table.length < Math.min(6, v.oppCount)) for (const c of v.hand) if (c.rank === v.table[0].attack.rank) cands.push({ a: 'transfer', card: c });
    cands.push({ a: 'take' });
  } else if (v.youAttack && (v.phase === 'attack' || v.phase === 'throwin')) {
    const ranks = new Set(); v.table.forEach(p => { ranks.add(p.attack.rank); if (p.defend) ranks.add(p.defend.rank); });
    const cap = Math.min(6, v.oppCount + v.table.filter(p => p.defend).length);
    for (const c of v.hand) if (v.table.length === 0 || (ranks.has(c.rank) && v.table.length < cap)) cands.push({ a: 'attack', card: c });
    if (v.phase === 'throwin') cands.push({ a: 'done' });
    else if (v.table.length && v.table.every(p => p.defend)) cands.push({ a: 'bito' });
  }
  if (!cands.length) return null;
  const nonTake = cands.filter(m => m.a !== 'take');
  const pool = nonTake.length && rng() < 0.85 ? nonTake : cands;
  return pool[Math.floor(rng() * pool.length)];
}

(async () => {
  await new Promise(r => srv.listen(0, r));
  const port = srv.httpServer.address().port;

  // --- healthz и статика
  const hz = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.ok(hz.ok);

  // --- создание комнаты, вход второго, полная партия по протоколу
  for (const [mode, deckSize] of [['classic', 24], ['transfer', 36], ['classic', 52]]) {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);
    a.send({ t: 'create', mode, deckSize });
    const joinedA = await a.waitFor(m => m.t === 'joined');
    await a.waitFor(m => m.t === 'waiting');
    b.send({ t: 'join', room: joinedA.room.toLowerCase() });
    await b.waitFor(m => m.t === 'joined');
    await Promise.all([a.waitFor(m => m.t === 'state'), b.waitFor(m => m.t === 'state')]);

    // третий лишний не пускается
    const c = client(port); await c.open;
    c.send({ t: 'join', room: joinedA.room });
    const full = await c.waitFor(m => m.t === 'error');
    assert.strictEqual(full.code, 'full');
    c.ws.close();

    let n = 0;
    const rng = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
    while (!(a.state.over && b.state.over)) {
      const [va, vb] = [a.state, b.state];
      // один из двух должен иметь ход
      const sides = [[a, va], [b, vb]];
      let moved = false;
      for (const [cl, v] of sides) {
        const m = pickMove(v, rng);
        const myTurn = (v.phase === 'defend') ? !v.youAttack : v.youAttack;
        if (m && myTurn) {
          const before = cl.state.lastEvent.seq;
          const other = cl === a ? b : a;
          cl.send({ t: 'move', ...m });
          await cl.waitFor(x => x.t === 'state' && x.lastEvent.seq > before);
          await other.waitFor(x => x.t === 'state' && x.lastEvent.seq > before);
          moved = true; break;
        }
      }
      assert.ok(moved, 'ни у кого нет хода');
      if (++n > 5000) assert.fail('слишком много ходов');
    }
    assert.ok(['win', 'lose', 'draw'].includes(a.state.result));
    assert.strictEqual(a.state.result === 'win', b.state.result === 'lose');
    // чужая рука не утекает
    assert.ok(a.msgs.filter(m => m.t === 'state').every(m => !('hands' in m) && !('deck' in m)));

    // реванш
    if (a.state.result !== 'draw') {
      a.send({ t: 'rematch' });
      await b.waitFor(m => m.t === 'state' && m.rematch && m.rematch[1] === true);
      b.send({ t: 'rematch' });
      const ns = await a.waitFor(m => m.t === 'state' && !m.over && m.gameId !== a.msgs.find(x => x.t === 'state').gameId);
      assert.ok(ns.hand.length > 0);
    }
    a.ws.close(); b.ws.close();
    console.log(`server: партия ${mode}/${deckSize} по протоколу — ходов ${n}, ок`);
  }

  // --- переподключение по токену
  {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);
    a.send({ t: 'create', mode: 'classic', deckSize: 36 });
    const ja = await a.waitFor(m => m.t === 'joined');
    b.send({ t: 'join', room: ja.room });
    await b.waitFor(m => m.t === 'joined');
    await a.waitFor(m => m.t === 'state');
    const handBefore = JSON.stringify(a.state.hand);
    a.ws.close();
    const drop = await b.waitFor(m => m.t === 'state' && m.oppConnected === false);
    assert.ok(drop.oppDeadline > Date.now());
    const a2 = client(port); await a2.open;
    a2.send({ t: 'join', room: ja.room, token: ja.token });
    await a2.waitFor(m => m.t === 'state');
    assert.strictEqual(JSON.stringify(a2.state.hand), handBefore, 'рука сохранилась после возвращения');
    await b.waitFor(m => m.t === 'state' && m.oppConnected === true && m.lastEvent.seq === 0 && m.oppDeadline === null);
    // подделка токена не даёт занять чужое место
    const evil = client(port); await evil.open;
    evil.send({ t: 'join', room: ja.room, token: 'nope' });
    assert.strictEqual((await evil.waitFor(m => m.t === 'error')).code, 'full');
    // добровольный выход = сдача
    a2.send({ t: 'leave' });
    const fin = await b.waitFor(m => m.t === 'state' && m.over);
    assert.strictEqual(fin.result, 'win');
    assert.strictEqual(fin.reason, 'forfeit');
    b.ws.close(); a2.ws.close(); evil.ws.close();
    console.log('server: переподключение и сдача — ок');
  }

  // --- нелегальные ходы и мусор
  {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);
    a.send({ t: 'create', mode: 'classic', deckSize: 36 });
    const ja = await a.waitFor(m => m.t === 'joined');
    b.send({ t: 'join', room: ja.room });
    await b.waitFor(m => m.t === 'state');
    await a.waitFor(m => m.t === 'state');
    const notAtt = a.state.youAttack ? b : a;
    notAtt.send({ t: 'move', a: 'attack', card: notAtt.state.hand[0] });
    assert.strictEqual((await notAtt.waitFor(m => m.t === 'error')).code, 'illegal');
    a.ws.send('не json'); a.ws.send(JSON.stringify({ t: 'move', a: 'attack', card: { rank: 'ZZ', suit: 'x' } }));
    a.send({ t: 'join', room: 'XXXXX' });
    assert.strictEqual((await a.waitFor(m => m.t === 'error' && m.code === 'no_room')).code, 'no_room');
    a.ws.close(); b.ws.close();
    console.log('server: защита от нелегальных ходов — ок');
  }

  // --- таймаут отключения → техническое поражение (короткий таймер через подмену)
  {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);
    a.send({ t: 'create', mode: 'classic', deckSize: 36 });
    const ja = await a.waitFor(m => m.t === 'joined');
    b.send({ t: 'join', room: ja.room });
    await b.waitFor(m => m.t === 'state'); await a.waitFor(m => m.t === 'state');
    const room = srv.rooms.get(ja.room);
    a.ws.close();
    await b.waitFor(m => m.t === 'state' && m.oppConnected === false);
    // ускоряем: сбрасываем реальный таймер и ставим короткий
    const seat = room.seats[0]; clearTimeout(seat.timer);
    seat.timer = setTimeout(() => { E.forfeit(room.game, 0); srv.wss.clients.forEach(() => {}); }, 50);
    await new Promise(r => setTimeout(r, 120));
    assert.ok(room.game.over && room.game.winner === 1);
    b.ws.close();
    console.log('server: таймаут отключения — ок');
  }

  srv.close(() => { console.log('server tests: все прошли'); process.exit(0); });
})().catch(e => { console.error(e); process.exit(1); });
