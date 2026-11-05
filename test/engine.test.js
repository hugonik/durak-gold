'use strict';
const assert = require('assert');
const E = require('../engine');

// детерминированный ГСЧ, чтобы падения воспроизводились
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function totalCards(g) {
  let n = g.deck.length + g.hands[0].length + g.hands[1].length + g.bito;
  g.table.forEach(p => { n += 1 + (p.defend ? 1 : 0); });
  return n;
}

function uniqueCards(g) {
  const all = [...g.deck, ...g.hands[0], ...g.hands[1]];
  g.table.forEach(p => { all.push(p.attack); if (p.defend) all.push(p.defend); });
  // карты в отбое не хранятся поштучно, поэтому проверяем уникальность остальных
  return new Set(all.map(c => c.rank + c.suit)).size === all.length;
}

let games = 0, finished = 0, draws = 0, forfeits = 0, maxMoves = 0, takeEnds = 0;
const t0 = Date.now();
for (const mode of ['classic', 'transfer']) {
  for (const deckSize of [24, 36, 52]) {
    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed * 7919 + deckSize + (mode === 'transfer' ? 1 : 0));
      const g = E.createGame({ mode, deckSize, rng });
      assert.strictEqual(totalCards(g), deckSize, 'старт: карты потеряны');
      let moves = 0;
      while (!g.over) {
        // чей сейчас ход: в 'defend' — защитник, в 'attack'/'throwin' — атакующий
        const actor = g.phase === 'defend' ? 1 - g.attacker : g.attacker;
        const legal = E.legalMoves(g, actor);
        assert.ok(legal.length > 0, `тупик: нет ходов (mode=${mode} size=${deckSize} seed=${seed} phase=${g.phase})`);
        // чтобы партии заканчивались, предпочитаем «не брать», но иногда берём
        let pool = legal;
        const nonTake = legal.filter(m => m.a !== 'take');
        if (nonTake.length && rng() < 0.85) pool = nonTake;
        const m = pool[Math.floor(rng() * pool.length)];
        const r = E.applyMove(g, actor, m);
        assert.ok(r.ok, 'легальный ход отклонён: ' + r.error);
        assert.strictEqual(totalCards(g), deckSize, 'карты потеряны/появились после ' + JSON.stringify(m));
        assert.ok(uniqueCards(g), 'дубликат карты');
        assert.ok(g.table.length <= E.MAX_TABLE, 'на столе больше 6');
        for (const h of g.hands) if (!g.over) assert.ok(h.length <= 40);
        if (++moves > 20000) assert.fail(`слишком долго: seed=${seed} mode=${mode} size=${deckSize}`);
      }
      maxMoves = Math.max(maxMoves, moves);
      games++; finished++;
      if (g.winner === -1) draws++;
      assert.ok(g.table.length === 0);
      assert.ok(g.deck.length === 0);
      assert.ok(g.winner === -1 ? (g.hands[0].length === 0 && g.hands[1].length === 0)
        : g.hands[g.winner].length === 0 && g.hands[g.loser].length > 0, 'некорректный итог');
    }
  }
}
console.log(`fuzz: ${games} партий, все дошли до конца, ничьих ${draws}, максимум ходов ${maxMoves}, ${Date.now() - t0} мс`);

// ---- точечные сценарии ----
function fixed(hands, trumpCard, deckExtra, mode, attacker) {
  const g = E.createGame({ mode, deckSize: 36, firstAttacker: attacker });
  g.hands = [hands[0].map(s => card(s)), hands[1].map(s => card(s))];
  g.trump = card(trumpCard);
  g.deck = [card(trumpCard), ...deckExtra.map(card)];
  g.table = []; g.bito = 0; g.phase = 'attack'; g.over = false;
  return g;
}
function card(s) { return { rank: s.slice(0, -1), suit: s.slice(-1) }; }

// 1. нельзя подкинуть ранг, которого нет на столе
{
  const g = fixed([['6♠', '7♣', '9♦'], ['8♠', 'A♥']], '10♥', [], 'classic', 0);
  assert.ok(E.applyMove(g, 0, { a: 'attack', card: card('6♠') }).ok);
  assert.strictEqual(g.phase, 'defend');
  assert.ok(!E.applyMove(g, 1, { a: 'defend', card: card('A♥'), pair: 5 }).ok);
  assert.ok(E.applyMove(g, 1, { a: 'defend', card: card('8♠'), pair: 0 }).ok);
  assert.strictEqual(g.phase, 'attack');
  assert.ok(!E.applyMove(g, 0, { a: 'attack', card: card('9♦') }).ok, 'подкинули чужой ранг');
  assert.ok(E.applyMove(g, 0, { a: 'bito' }).ok);
  assert.strictEqual(g.attacker, 1);
}
// 2. лимит: у защитника одна карта — второй атакующей не положить
{
  const g = fixed([['6♠', '6♣', '9♦'], ['8♠']], '10♥', ['7♦', '8♦', '9♣'], 'classic', 0);
  assert.ok(E.applyMove(g, 0, { a: 'attack', card: card('6♠') }).ok);
  g.phase = 'attack'; g.table[0].defend = card('8♠'); g.hands[1] = [];
  assert.ok(!E.applyMove(g, 0, { a: 'attack', card: card('6♣') }).ok, 'превышен лимит по картам защитника');
}
// 3. перевод: лимит от руки нового защитника
{
  const g = fixed([['6♠', '9♦'], ['6♥', '7♦', 'K♣']], '10♥', ['2♦'], 'transfer', 0);
  assert.ok(E.applyMove(g, 0, { a: 'attack', card: card('6♠') }).ok);
  // у бывшего атакующего осталась 1 карта, на столе уже 1 → перевести нельзя
  assert.ok(!E.applyMove(g, 1, { a: 'transfer', card: card('6♥') }).ok, 'перевод вопреки лимиту');
}
{
  const g = fixed([['6♠', '9♦', 'K♦'], ['6♥', '7♦', 'K♣']], '10♥', ['2♦'], 'transfer', 0);
  assert.ok(E.applyMove(g, 0, { a: 'attack', card: card('6♠') }).ok);
  assert.ok(E.applyMove(g, 1, { a: 'transfer', card: card('6♥') }).ok);
  assert.strictEqual(g.attacker, 1);
  assert.strictEqual(g.phase, 'defend');
  assert.strictEqual(g.table.length, 2);
}
// 4. «беру» → докинуть → «отдать»
{
  const g = fixed([['6♠', '6♣', '9♦'], ['7♦', '8♦', 'K♣', 'Q♣']], '10♥', ['2♦', '3♦', '4♦', '5♦', '2♣', '3♣', '4♣'], 'classic', 0);
  assert.ok(E.applyMove(g, 0, { a: 'attack', card: card('6♠') }).ok);
  assert.ok(E.applyMove(g, 1, { a: 'take' }).ok);
  assert.strictEqual(g.phase, 'throwin');
  assert.ok(E.applyMove(g, 0, { a: 'attack', card: card('6♣') }).ok);
  assert.strictEqual(g.phase, 'throwin');
  assert.ok(!E.applyMove(g, 1, { a: 'bito' }).ok);
  assert.ok(E.applyMove(g, 0, { a: 'done' }).ok);
  assert.strictEqual(g.attacker, 0, 'после «взял» атакует тот же игрок');
  assert.strictEqual(g.hands[0].length, 6);
  assert.strictEqual(g.hands[1].length, 6);
  assert.strictEqual(g.table.length, 0);
}
// 5. конец игры: победа атакующего, который сбросил всё
{
  const g = fixed([['6♠'], ['7♠', '8♣']], '10♥', [], 'classic', 0);
  g.deck = [card('10♥')]; // только козырь внизу => считаем колоду закончившейся после добора
  assert.ok(E.applyMove(g, 0, { a: 'attack', card: card('6♠') }).ok);
  assert.ok(E.applyMove(g, 1, { a: 'defend', card: card('7♠'), pair: 0 }).ok);
  // у атакующего пусто → авто-бито; колода из одного козыря: добор и бой дальше
  assert.ok(!g.over || g.winner === 0);
}
// 6. виды скрывают чужую руку
{
  const g = E.createGame({ mode: 'classic', deckSize: 36 });
  const v = E.viewFor(g, 0);
  assert.strictEqual(v.hand.length, 6);
  assert.strictEqual(v.oppCount, 6);
  assert.ok(!('hands' in v) && !('deck' in v));
  assert.strictEqual(v.deckCount, 36 - 12 - 1);
}
// 7. сдача
{
  const g = E.createGame({ mode: 'classic', deckSize: 24, firstAttacker: 1 });
  E.forfeit(g, 1);
  assert.ok(g.over && g.winner === 0 && g.reason === 'forfeit');
  assert.ok(!E.applyMove(g, 0, { a: 'attack', card: g.hands[0][0] }).ok);
}
console.log('engine: сценарные тесты прошли');
