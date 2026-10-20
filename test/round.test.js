'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GameState, FLIGHT_MS } = require('../server/game-state');
const { createEvent } = require('../server/events');
const { emptyStats } = require('../server/storage');
const { loadTestConfig, fakeClock, seededRandom } = require('./helpers');

function setup(overrides = {}) {
  const config = loadTestConfig(overrides);
  const now = fakeClock();
  const stats = emptyStats();
  let saves = 0;
  const game = new GameState({ config, stats, now, random: seededRandom(7), onStatsChange: () => { saves += 1; } });
  const send = (type, userId, data = {}) => game.handleEvent(createEvent({ type, user: { id: userId, name: userId }, data }));
  const join = (userId, code) => send('comment', userId, { text: code });
  const run = (ms, step = 50) => {
    for (let t = 0; t < ms; t += step) { now.advance(step); game.tick(); }
  };
  const team = (code) => game.teams.get(code);
  return { game, config, now, stats, send, join, run, team, saves: () => saves };
}

test('comentar el país une al equipo y se puede cambiar respetando la espera', () => {
  const { game, join, run } = setup();
  game.startRound();
  join('ana', 'Perú');
  assert.equal(game.players.get('ana').team, 'pe');
  join('ana', 'mx');
  assert.equal(game.players.get('ana').team, 'pe', 'antes de la espera no cambia');
  run(16000);
  join('ana', '!mx');
  assert.equal(game.players.get('ana').team, 'mx');
});

test('cada X likes sale un proyectil chico y el resto se acumula', () => {
  const { game, join, send, config } = setup();
  game.startRound();
  join('ana', 'pe');
  send('like', 'ana', { count: 45 });
  const launches = game.drainFx().filter((f) => f.kind === 'launch');
  assert.equal(launches.length, Math.floor(45 / config.likes.likesPerProjectile));
  assert.equal(launches[0].attack, 'small');
  assert.notEqual(launches[0].targets[0], 'pe', 'nunca se ataca a sí mismo');
  assert.equal(game.players.get('ana').likeBuffer, 45 % config.likes.likesPerProjectile);
});

test('likes de alguien sin equipo no hacen nada', () => {
  const { game, send } = setup();
  game.startRound();
  send('like', 'nadie', { count: 500 });
  assert.equal(game.drainFx().filter((f) => f.kind === 'launch').length, 0);
});

test('límite por usuario: el spam de likes no pasa del tope de proyectiles', () => {
  const { game, join, send, config } = setup();
  game.startRound();
  join('spam', 'pe');
  send('like', 'spam', { count: 10000 });
  const launches = game.drainFx().filter((f) => f.kind === 'launch').length;
  assert.ok(launches <= config.likes.maxProjectilesPerSec * 2, `salieron ${launches}`);
});

test('el daño se aplica cuando llega el proyectil, no antes', () => {
  const { game, join, send, run, team, config } = setup();
  game.startRound();
  join('ana', 'pe');
  send('like', 'ana', { count: config.likes.likesPerProjectile });
  const [launch] = game.drainFx().filter((f) => f.kind === 'launch');
  const target = team(launch.targets[0]);
  run(FLIGHT_MS.small - 100);
  assert.equal(target.hp, config.round.maxHp);
  run(200);
  assert.equal(target.hp, config.round.maxHp - config.likes.damage);
  assert.equal(game.players.get('ana').roundDamage, config.likes.damage);
});

test('fin de ronda por tiempo: gana el que tiene más vida, con contador y reinicio automático', () => {
  const { game, join, send, run, config, stats } = setup({ round: { durationSec: 60, winnerScreenSec: 10 } });
  game.startRound();
  join('ana', 'pe');
  send('gift', 'ana', { giftName: 'Rosa', coins: 1, repeat: 1 });
  run(5000);
  assert.equal(game.phase, 'running');
  assert.ok(game.snapshot().remainingMs <= 55000);

  run(56000);
  assert.equal(game.phase, 'ended');
  const snap = game.snapshot();
  assert.equal(snap.winner.team, 'pe', 'Perú no recibió daño y otro sí');
  assert.equal(snap.winner.reason, 'time');
  assert.equal(snap.winner.mvp.id, 'ana');
  assert.equal(stats.countryWins.pe, 1);
  assert.equal(stats.players.ana.mvps, 1);

  run(config.round.winnerScreenSec * 1000 + 100);
  assert.equal(game.phase, 'running');
  assert.equal(game.round.number, 2);
  assert.ok(game.snapshot().teams.every((t) => t.hp === config.round.maxHp && t.alive));
});

test('fin de ronda: el último plato en pie gana al instante', () => {
  const { game, join, send, run, team } = setup({ round: { maxHp: 100 }, gifts: { potDamage: 100 } });
  game.startRound();
  join('rey', 'mx');
  send('gift', 'rey', { giftName: 'Corona', coins: 199, repeat: 1 });
  run(FLIGHT_MS.pot + 100);
  assert.equal(game.phase, 'ended');
  assert.equal(game.snapshot().winner.team, 'mx');
  assert.equal(game.snapshot().winner.reason, 'last');
  for (const t of game.teams.values()) if (t.code !== 'mx') assert.equal(team(t.code).alive, false);
});

test('empate total al acabar el tiempo: no hay ganador', () => {
  const { game, run, stats } = setup({ round: { durationSec: 30 } });
  game.startRound();
  run(31000);
  assert.equal(game.phase, 'ended');
  assert.equal(game.snapshot().winner.team, null);
  assert.deepEqual(stats.countryWins, {});
});

test('empate de vida al acabar el tiempo: gana el que hizo más daño', () => {
  const { game, run, team } = setup({ round: { durationSec: 30 } });
  game.startRound();
  team('pe').damageDealt = 50;
  team('co').damageDealt = 20;
  run(31000);
  assert.equal(game.snapshot().winner.team, 'pe');
});

test('pausa congela el contador y los proyectiles en vuelo', () => {
  const { game, join, send, run, config } = setup({ round: { durationSec: 60 } });
  game.startRound();
  join('ana', 'pe');
  send('like', 'ana', { count: config.likes.likesPerProjectile });
  const [launch] = game.drainFx().filter((f) => f.kind === 'launch');
  run(500);
  game.pauseRound();
  const remaining = game.snapshot().remainingMs;
  run(120000);
  assert.equal(game.phase, 'paused');
  assert.equal(game.snapshot().remainingMs, remaining);
  assert.equal(game.teams.get(launch.targets[0]).hp, config.round.maxHp);
  game.resumeRound();
  run(600);
  assert.equal(game.teams.get(launch.targets[0]).hp, config.round.maxHp - config.likes.damage);
});

test('regalos entre rondas se guardan y se aplican al empezar la siguiente', () => {
  const { game, join, send, run } = setup({ round: { durationSec: 30, winnerScreenSec: 10 } });
  game.startRound();
  join('ana', 'pe');
  run(31000);
  assert.equal(game.phase, 'ended');
  send('gift', 'ana', { giftName: 'Perfume', coins: 20, repeat: 1 });
  game.drainFx();
  run(10100);
  assert.equal(game.phase, 'running');
  const launches = game.drainFx().filter((f) => f.kind === 'launch');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].attack, 'chili');
});

test('regalo de alguien sin equipo: se le asigna el país con menos jugadores', () => {
  const { game, join, send } = setup();
  game.startRound();
  for (const [i, code] of ['pe', 'mx', 'co', 'ar', 'cl', 've', 'ec', 'bo'].entries()) join(`p${i}`, code);
  send('gift', 'nuevo', { giftName: 'Rosa', coins: 1, repeat: 1 });
  assert.equal(game.players.get('nuevo').team, 'br');
});

test('follow da escudo y share cura a su equipo', () => {
  const { game, join, send, team, config } = setup();
  game.startRound();
  join('ana', 'pe');
  team('pe').hp = 500;
  send('follow', 'ana');
  assert.ok(team('pe').shieldUntil > game.now());
  send('share', 'ana');
  assert.equal(team('pe').hp, 500 + Math.round(config.round.maxHp * config.social.healPct / 100));
});

test('el escudo bloquea el daño', () => {
  const { game, join, send, run, team } = setup({ round: { maxHp: 100 }, gifts: { potDamage: 100 } });
  game.startRound();
  join('ana', 'pe');
  join('rey', 'mx');
  send('follow', 'ana');
  send('gift', 'rey', { giftName: 'Corona', coins: 199, repeat: 1 });
  run(FLIGHT_MS.pot + 100);
  assert.equal(team('pe').hp, 100);
  assert.equal(team('pe').alive, true);
  assert.equal(game.snapshot().winner, null, 'quedan 2 vivos: la ronda sigue');
});

test('reiniciar ranking borra rondas ganadas y jugadores', () => {
  const { game, stats, run } = setup({ round: { durationSec: 30 } });
  stats.countryWins.pe = 3;
  stats.players.x = { name: 'x', damage: 10, coins: 0, mvps: 0 };
  game.startRound();
  run(1000);
  game.resetRanking();
  assert.deepEqual(stats.countryWins, {});
  assert.deepEqual(stats.players, {});
});
