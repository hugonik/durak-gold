'use strict';
// Авторитетная логика игры «Дурак» (подкидной и переводной, 2 игрока).
// Чистый модуль без сети и таймеров — его же можно гонять в тестах и (позже)
// использовать для ботов на сервере. Клиент ничего не решает сам: он шлёт
// «хочу сходить так», а валидирует и применяет ход только этот файл.

const SUITS = ['♠', '♣', '♥', '♦'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const DECK_CONFIGS = {
  24: ['9','10','J','Q','K','A'],
  36: ['6','7','8','9','10','J','Q','K','A'],
  52: ['2','3','4','5','6','7','8','9','10','J','Q','K','A']
};
const MAX_TABLE = 6;
const HAND_SIZE = 6;

let gameCounter = 0;

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// opts: { mode: 'classic'|'transfer', deckSize: 24|36|52, rng?, firstAttacker?: 0|1 }
function createGame(opts = {}) {
  const mode = opts.mode === 'transfer' ? 'transfer' : 'classic';
  const deckSize = DECK_CONFIGS[opts.deckSize] ? opts.deckSize : 36;
  const rng = opts.rng || Math.random;

  const deck = [];
  for (const suit of SUITS) for (const rank of DECK_CONFIGS[deckSize]) deck.push({ rank, suit });
  shuffle(deck, rng);

  // Козырь — нижняя карта колоды (индекс 0), берётся самой последней.
  const trump = { rank: deck[0].rank, suit: deck[0].suit };
  const hands = [[], []];
  for (let i = 0; i < HAND_SIZE; i++) {
    hands[0].push(deck.pop());
    hands[1].push(deck.pop());
  }

  // Первым ходит тот, у кого младший козырь; если козырей ни у кого нет — жребий.
  // При реванше можно задать firstAttacker (проигравший ходит первым).
  let attacker;
  if (opts.firstAttacker === 0 || opts.firstAttacker === 1) {
    attacker = opts.firstAttacker;
  } else {
    const lowest = hands.map(h => {
      const t = h.filter(c => c.suit === trump.suit).map(c => RANK_VALUES[c.rank]);
      return t.length ? Math.min(...t) : Infinity;
    });
    if (lowest[0] === lowest[1]) attacker = rng() < 0.5 ? 0 : 1;
    else attacker = lowest[0] < lowest[1] ? 0 : 1;
  }

  return {
    id: ++gameCounter,
    mode, deckSize, trump,
    deck, hands,
    table: [],            // [{attack, defend|null}]
    bito: 0,              // сколько карт ушло в отбой
    attacker,
    // 'attack'  — атакующий выкладывает карту / подкидывает / говорит «бито»
    // 'defend'  — на столе есть неотбитые карты, ход защитника
    // 'throwin' — защитник сказал «беру», атакующий может докинуть
    phase: 'attack',
    over: false,
    winner: null,         // 0 | 1 | -1 (ничья)
    loser: null,
    reason: null,         // 'normal' | 'forfeit'
    seq: 0,
    lastTable: [],        // стол в момент закрытия раунда (клиенту для анимации)
    lastEvent: { type: 'start', by: attacker, seq: 0 }
  };
}

const sameCard = (a, b) => a && b && a.rank === b.rank && a.suit === b.suit;
const indexOfCard = (hand, c) => hand.findIndex(x => sameCard(x, c));

function validCard(c) {
  return c && typeof c === 'object' && typeof c.rank === 'string' && typeof c.suit === 'string'
    && RANK_VALUES[c.rank] !== undefined && SUITS.includes(c.suit);
}

function canBeat(g, attack, defend) {
  if (defend.suit === g.trump.suit && attack.suit !== g.trump.suit) return true;
  return defend.suit === attack.suit && RANK_VALUES[defend.rank] > RANK_VALUES[attack.rank];
}

function ranksOnTable(g) {
  const r = new Set();
  g.table.forEach(p => { r.add(p.attack.rank); if (p.defend) r.add(p.defend.rank); });
  return r;
}

// Сколько всего карт может лежать в атаке против защитника: не больше 6 и не больше,
// чем у него было карт в начале раунда (рука сейчас + уже отбитые им).
function attackCap(g, defenderIdx) {
  const defended = g.table.filter(p => p.defend).length;
  return Math.min(MAX_TABLE, g.hands[defenderIdx].length + defended);
}

// null — ход допустим, иначе строка с причиной.
function validate(g, p, m) {
  if (g.over) return 'Игра окончена';
  if (p !== 0 && p !== 1) return 'Нет такого игрока';
  if (!m || typeof m.a !== 'string') return 'Непонятный ход';
  const att = g.attacker, def = 1 - att;
  const isAtt = p === att;
  const hand = g.hands[p];

  switch (m.a) {
    case 'attack': {
      if (!isAtt) return 'Сейчас не ваша атака';
      if (g.phase === 'defend') return 'Подождите, соперник отбивается';
      if (!validCard(m.card)) return 'Неверная карта';
      if (indexOfCard(hand, m.card) < 0) return 'У вас нет этой карты';
      if (g.table.length === 0) return null;
      if (!ranksOnTable(g).has(m.card.rank)) return 'Можно подкидывать только по рангу карт на столе';
      if (g.table.length >= attackCap(g, def)) return 'Больше подкидывать нельзя';
      return null;
    }
    case 'defend': {
      if (isAtt) return 'Вы атакуете';
      if (g.phase !== 'defend') return 'Сейчас нечего отбивать';
      if (!validCard(m.card)) return 'Неверная карта';
      if (indexOfCard(hand, m.card) < 0) return 'У вас нет этой карты';
      const pair = g.table[m.pair];
      if (!pair || pair.defend) return 'Эту карту уже отбили';
      if (!canBeat(g, pair.attack, m.card)) return 'Эта карта не бьёт';
      return null;
    }
    case 'transfer': {
      if (g.mode !== 'transfer') return 'Перевод недоступен в этом режиме';
      if (isAtt) return 'Вы атакуете';
      if (g.phase !== 'defend') return 'Сейчас нельзя перевести';
      if (!validCard(m.card)) return 'Неверная карта';
      if (indexOfCard(hand, m.card) < 0) return 'У вас нет этой карты';
      if (g.table.length === 0 || g.table.some(x => x.defend)) return 'Переводить можно, только пока ничего не отбито';
      if (g.table[0].attack.rank !== m.card.rank) return 'Для перевода нужен тот же ранг';
      // Новому защитнику (сейчас атакующий) должно хватить карт отбить всё.
      if (g.table.length >= Math.min(MAX_TABLE, g.hands[att].length)) return 'Сопернику не хватит карт — перевести нельзя';
      return null;
    }
    case 'take': {
      if (isAtt) return 'Вы атакуете';
      if (g.phase !== 'defend') return 'Нечего брать';
      return null;
    }
    case 'done': {
      if (!isAtt) return 'Вы отбиваетесь';
      if (g.phase !== 'throwin') return 'Соперник ещё не взял';
      return null;
    }
    case 'bito': {
      if (!isAtt) return 'Бито говорит атакующий';
      if (g.phase !== 'attack') return 'Ещё не всё отбито';
      if (g.table.length === 0) return 'Стол пуст';
      if (g.table.some(x => !x.defend)) return 'Не всё отбито';
      return null;
    }
    default:
      return 'Неизвестное действие';
  }
}

function event(g, type, by) {
  g.seq += 1;
  g.lastEvent = { type, by, seq: g.seq };
}

function drawUpTo(g, idx) {
  while (g.hands[idx].length < HAND_SIZE && g.deck.length > 0) g.hands[idx].push(g.deck.pop());
}

// Добор: сначала тот, кто атаковал в этом раунде, потом защищавшийся.
function refill(g) {
  drawUpTo(g, g.attacker);
  drawUpTo(g, 1 - g.attacker);
}

function checkEnd(g) {
  if (g.table.length > 0 || g.deck.length > 0) return;
  const e0 = g.hands[0].length === 0, e1 = g.hands[1].length === 0;
  if (!e0 && !e1) return;
  g.over = true;
  g.reason = 'normal';
  if (e0 && e1) { g.winner = -1; g.loser = -1; }
  else if (e0) { g.winner = 0; g.loser = 1; }
  else { g.winner = 1; g.loser = 0; }
}

function snapshotTable(g) {
  return g.table.map(x => ({
    attack: { rank: x.attack.rank, suit: x.attack.suit },
    defend: x.defend ? { rank: x.defend.rank, suit: x.defend.suit } : null
  }));
}

function endRoundBito(g) {
  g.lastTable = snapshotTable(g);
  g.bito += g.table.reduce((n, p) => n + 1 + (p.defend ? 1 : 0), 0);
  g.table = [];
  refill(g);
  g.attacker = 1 - g.attacker;
  g.phase = 'attack';
  event(g, 'bito', 1 - g.attacker);
  checkEnd(g);
}

function endRoundTake(g) {
  const def = 1 - g.attacker;
  g.lastTable = snapshotTable(g);
  g.table.forEach(p => { g.hands[def].push(p.attack); if (p.defend) g.hands[def].push(p.defend); });
  g.table = [];
  refill(g);
  // атакующий остаётся тем же — защитник, взявший карты, пропускает ход
  g.phase = 'attack';
  event(g, 'take', def);
  checkEnd(g);
}

// Возвращает { ok:true } или { ok:false, error }.
function applyMove(g, p, m) {
  const err = validate(g, p, m);
  if (err) return { ok: false, error: err };

  const att = g.attacker, def = 1 - att;
  const hand = g.hands[p];

  switch (m.a) {
    case 'attack': {
      const [card] = hand.splice(indexOfCard(hand, m.card), 1);
      g.table.push({ attack: card, defend: null });
      if (g.phase !== 'throwin') g.phase = 'defend';
      event(g, 'attack', p);
      // В фазе «беру» ждём, пока атакующий скажет «хватит» (done) — но если докидывать
      // уже нечем физически, закрываем раунд сами.
      if (g.phase === 'throwin' && (g.hands[att].length === 0 || g.table.length >= attackCap(g, def))) endRoundTake(g);
      break;
    }
    case 'defend': {
      const [card] = hand.splice(indexOfCard(hand, m.card), 1);
      g.table[m.pair].defend = card;
      event(g, 'defend', p);
      if (!g.table.some(x => !x.defend)) {
        g.phase = 'attack';
        // Подкидывать уже нечем (у кого-то пустая рука) — бито автоматически.
        if (g.hands[att].length === 0 || g.hands[def].length === 0) endRoundBito(g);
      }
      break;
    }
    case 'transfer': {
      const [card] = hand.splice(indexOfCard(hand, m.card), 1);
      g.table.push({ attack: card, defend: null });
      g.attacker = def;      // роли поменялись: бывший атакующий теперь отбивается
      g.phase = 'defend';
      event(g, 'transfer', p);
      break;
    }
    case 'take': {
      g.phase = 'throwin';
      event(g, 'takeStart', p);
      if (g.hands[att].length === 0 || g.table.length >= attackCap(g, def)) endRoundTake(g);
      break;
    }
    case 'done':
      endRoundTake(g);
      break;
    case 'bito':
      endRoundBito(g);
      break;
  }
  return { ok: true };
}

// Все допустимые сейчас ходы игрока (для тестов и будущих серверных ботов).
function legalMoves(g, p) {
  if (g.over) return [];
  const moves = [];
  const seen = new Set();
  const hand = g.hands[p];
  const tryMove = m => { if (!validate(g, p, m)) moves.push(m); };
  for (const card of hand) {
    const key = card.rank + card.suit;
    if (seen.has(key)) continue;
    seen.add(key);
    tryMove({ a: 'attack', card });
    tryMove({ a: 'transfer', card });
    g.table.forEach((_, i) => tryMove({ a: 'defend', card, pair: i }));
  }
  tryMove({ a: 'take' });
  tryMove({ a: 'done' });
  tryMove({ a: 'bito' });
  return moves;
}

// Закончить игру досрочно: игрок leaver вышел/пропал.
function forfeit(g, leaver) {
  if (g.over) return;
  g.over = true;
  g.reason = 'forfeit';
  g.loser = leaver;
  g.winner = 1 - leaver;
  event(g, 'forfeit', leaver);
}

// То, что видит игрок p: своя рука целиком, у соперника — только количество карт.
function viewFor(g, p) {
  let result = null;
  if (g.over) result = g.winner === -1 ? 'draw' : (g.winner === p ? 'win' : 'lose');
  return {
    gameId: g.id,
    mode: g.mode,
    deckSize: g.deckSize,
    you: p,
    hand: g.hands[p].map(c => ({ rank: c.rank, suit: c.suit })),
    oppCount: g.hands[1 - p].length,
    deckCount: Math.max(0, g.deck.length - 1),   // без козыря, он показывается отдельно
    trump: g.trump,
    trumpTaken: g.deck.length === 0,
    bito: g.bito,
    table: g.table.map(x => ({
      attack: { rank: x.attack.rank, suit: x.attack.suit },
      defend: x.defend ? { rank: x.defend.rank, suit: x.defend.suit } : null
    })),
    youAttack: g.attacker === p,
    phase: g.phase,
    over: g.over,
    result,
    reason: g.reason,
    lastEvent: g.lastEvent,
    lastTable: (g.lastEvent.type === 'take' || g.lastEvent.type === 'bito') ? g.lastTable : []
  };
}

module.exports = {
  SUITS, RANK_VALUES, DECK_CONFIGS, MAX_TABLE, HAND_SIZE,
  createGame, validate, applyMove, legalMoves, forfeit, viewFor
};
