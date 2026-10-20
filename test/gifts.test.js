'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { giftTier, giftAttack, GiftStreakTracker } = require('../server/gifts');
const { createEvent } = require('../server/events');
const { loadTestConfig, fakeClock } = require('./helpers');

const cfg = loadTestConfig().gifts;
const ana = { id: 'u1', name: 'Ana', avatar: null };

test('tramos según monedas (1–9, 10–99, 100+)', () => {
  assert.equal(giftTier(0, cfg), null);
  assert.equal(giftTier(1, cfg), 'big');
  assert.equal(giftTier(9, cfg), 'big');
  assert.equal(giftTier(10, cfg), 'chili');
  assert.equal(giftTier(99, cfg), 'chili');
  assert.equal(giftTier(100, cfg), 'pot');
  assert.equal(giftTier(44999, cfg), 'pot');
});

test('el total del regalo es valor × cantidad', () => {
  const evt = createEvent({ type: 'gift', user: ana, data: { giftName: 'Rosa', coins: 1, repeat: 15 } });
  assert.equal(evt.data.totalCoins, 15);
  assert.equal(giftTier(evt.data.totalCoins, cfg), 'chili');
});

test('el daño crece con las monedas dentro del tramo y tiene tope', () => {
  assert.deepEqual(giftAttack(1, cfg), { tier: 'big', multiplier: 1, damage: cfg.bigDamage });
  assert.equal(giftAttack(3, cfg).damage, cfg.bigDamage * 3);
  assert.equal(giftAttack(9, cfg).damage, cfg.bigDamage * cfg.maxMultiplier);
  assert.equal(giftAttack(10, cfg).damage, cfg.chiliDamage);
  assert.equal(giftAttack(100000, cfg).damage, cfg.potDamage * cfg.maxMultiplier);
  assert.equal(giftAttack(0, cfg), null);
});

test('racha: solo cuenta al terminar, con la cantidad final', () => {
  const t = new GiftStreakTracker({ now: fakeClock() });
  const base = { user: ana, giftId: '5655', giftName: 'Rosa', coins: 1, streakable: true, groupId: 'g1' };
  for (let i = 1; i <= 4; i++) {
    assert.equal(t.push({ ...base, msgId: `m${i}`, repeatCount: i, repeatEnd: false }), null);
  }
  const final = t.push({ ...base, msgId: 'm5', repeatCount: 5, repeatEnd: true });
  assert.equal(final.repeat, 5);
  assert.equal(final.coins, 1);
  assert.equal(t.pendingCount, 0);
});

test('racha: el mensaje final repetido no se cuenta dos veces', () => {
  const t = new GiftStreakTracker({ now: fakeClock() });
  const base = { user: ana, giftId: '5655', coins: 1, streakable: true, groupId: 'g1' };
  t.push({ ...base, msgId: 'a', repeatCount: 1, repeatEnd: false });
  assert.ok(t.push({ ...base, msgId: 'b', repeatCount: 3, repeatEnd: true }));
  assert.equal(t.push({ ...base, msgId: 'b', repeatCount: 3, repeatEnd: true }), null, 'mismo msgId');
  assert.equal(t.push({ ...base, msgId: 'c', repeatCount: 3, repeatEnd: true }), null, 'mismo groupId, otro msgId');
});

test('regalo de racha enviado una sola vez (llega con repeatEnd false y luego true)', () => {
  const t = new GiftStreakTracker({ now: fakeClock() });
  const base = { user: ana, giftId: '5655', coins: 1, streakable: true, groupId: 'g9' };
  assert.equal(t.push({ ...base, msgId: 'x1', repeatCount: 1, repeatEnd: false }), null);
  assert.equal(t.push({ ...base, msgId: 'x2', repeatCount: 1, repeatEnd: true }).repeat, 1);
});

test('regalos que no son de racha se cuentan al instante y sin duplicados', () => {
  const t = new GiftStreakTracker({ now: fakeClock() });
  const g = { user: ana, giftId: '6064', giftName: 'Corona', coins: 199, streakable: false, msgId: 'z1', repeatCount: 1, repeatEnd: false };
  assert.equal(t.push(g).repeat, 1);
  assert.equal(t.push(g), null);
});

test('dos rachas a la vez del mismo usuario no se mezclan', () => {
  const t = new GiftStreakTracker({ now: fakeClock() });
  const rosa = { user: ana, giftId: 'rosa', coins: 1, streakable: true, groupId: 'g1' };
  const gg = { user: ana, giftId: 'gg', coins: 1, streakable: true, groupId: 'g2' };
  t.push({ ...rosa, msgId: '1', repeatCount: 2, repeatEnd: false });
  t.push({ ...gg, msgId: '2', repeatCount: 7, repeatEnd: false });
  assert.equal(t.push({ ...rosa, msgId: '3', repeatCount: 3, repeatEnd: true }).repeat, 3);
  assert.equal(t.push({ ...gg, msgId: '4', repeatCount: 8, repeatEnd: true }).repeat, 8);
});

test('racha sin mensaje final: se cierra sola tras el tiempo de espera y el final tardío se ignora', () => {
  const now = fakeClock();
  const t = new GiftStreakTracker({ now, timeoutMs: 15000 });
  const base = { user: ana, giftId: 'rosa', coins: 1, streakable: true, groupId: 'g7' };
  t.push({ ...base, msgId: '1', repeatCount: 6, repeatEnd: false });
  now.advance(14000);
  assert.deepEqual(t.sweep(), []);
  now.advance(2000);
  const swept = t.sweep();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].repeat, 6);
  assert.equal(swept[0].stale, true);
  assert.equal(t.push({ ...base, msgId: '2', repeatCount: 6, repeatEnd: true }), null);
});

test('si llegan desordenados se queda con la cantidad mayor', () => {
  const t = new GiftStreakTracker({ now: fakeClock() });
  const base = { user: ana, giftId: 'rosa', coins: 1, streakable: true, groupId: 'g3' };
  t.push({ ...base, msgId: '1', repeatCount: 9, repeatEnd: false });
  assert.equal(t.push({ ...base, msgId: '2', repeatCount: 8, repeatEnd: true }).repeat, 9);
});
