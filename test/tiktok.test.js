'use strict';

// Pruebas del adaptador de TikTok SIN red: se simulan mensajes con la forma del protobuf v3
// que entrega tiktok-live-connector 2.5.0 y se usan sus clases de error reales.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadTestConfig } = require('./helpers');
const { TikTokSource, normalizeUsername } = require('../server/tiktok');
const { createEvent } = require('../server/events');

let lib;
test.before(async () => {
  lib = await import('tiktok-live-connector');
});

function setup() {
  const events = [];
  const src = new TikTokSource({ onEvent: (p) => events.push(createEvent(p)), config: loadTestConfig() });
  src.wanted = true;
  const conn = new EventEmitter();
  src._attach(conn, src.generation, lib);
  return { src, conn, events };
}

const user = (id, nick) => ({
  id,
  nickname: nick,
  displayId: nick.toLowerCase(),
  avatarThumb: { urlList: ['https://p16-sign.tiktokcdn.com/avatar.webp'] },
});
const common = (msgId) => ({ msgId });

test('usuario: acepta @, URL completa y /live', () => {
  assert.equal(normalizeUsername('@pepito'), 'pepito');
  assert.equal(normalizeUsername('https://www.tiktok.com/@pepito/live'), 'pepito');
  assert.equal(normalizeUsername('  pepito.123 '), 'pepito.123');
});

test('chat → comment con nombre y foto', (t) => {
  const { src, conn, events } = setup();
  t.after(() => src.stop());
  conn.emit(lib.WebcastEvent.CHAT, { common: common('c1'), user: user('111', 'Ana'), content: 'Perú!!' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'comment');
  assert.equal(events[0].source, 'tiktok');
  assert.equal(events[0].user.id, '111');
  assert.equal(events[0].user.name, 'Ana');
  assert.equal(events[0].user.avatar, 'https://p16-sign.tiktokcdn.com/avatar.webp');
  assert.equal(events[0].data.text, 'Perú!!');
});

test('mensajes repetidos (mismo msgId) se ignoran', (t) => {
  const { src, conn, events } = setup();
  t.after(() => src.stop());
  const msg = { common: common('dup'), user: user('1', 'Ana'), content: 'pe' };
  conn.emit(lib.WebcastEvent.CHAT, msg);
  conn.emit(lib.WebcastEvent.CHAT, msg);
  assert.equal(events.length, 1);
});

test('likes: lee count (v3) y likeCount (README)', (t) => {
  const { src, conn, events } = setup();
  t.after(() => src.stop());
  conn.emit(lib.WebcastEvent.LIKE, { common: common('l1'), user: user('1', 'Ana'), count: 12 });
  conn.emit(lib.WebcastEvent.LIKE, { common: common('l2'), user: user('1', 'Ana'), likeCount: 7 });
  assert.deepEqual(events.map((e) => e.data.count), [12, 7]);
});

test('member, follow y share', (t) => {
  const { src, conn, events } = setup();
  t.after(() => src.stop());
  conn.emit(lib.WebcastEvent.MEMBER, { common: common('m1'), user: user('1', 'Ana') });
  conn.emit(lib.WebcastEvent.FOLLOW, { common: common('f1'), user: user('1', 'Ana') });
  conn.emit(lib.WebcastEvent.SHARE, { common: common('s1'), user: user('1', 'Ana') });
  assert.deepEqual(events.map((e) => e.type), ['join', 'follow', 'share']);
});

test('regalo en racha (giftType 1): un solo evento al terminar, valor × cantidad', (t) => {
  const { src, conn, events } = setup();
  t.after(() => src.stop());
  const base = { user: user('9', 'Rey'), giftId: '5655', groupId: '777', gift: { type: 1, diamondCount: 1, name: 'Rose' } };
  for (let i = 1; i <= 4; i++) conn.emit(lib.WebcastEvent.GIFT, { ...base, common: common(`g${i}`), repeatCount: i, repeatEnd: 0 });
  assert.equal(events.length, 0, 'durante la racha no se cuenta nada');
  conn.emit(lib.WebcastEvent.GIFT, { ...base, common: common('g5'), repeatCount: 5, repeatEnd: 1 });
  conn.emit(lib.WebcastEvent.GIFT, { ...base, common: common('g5'), repeatCount: 5, repeatEnd: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'gift');
  assert.equal(events[0].data.giftName, 'Rose');
  assert.equal(events[0].data.repeat, 5);
  assert.equal(events[0].data.totalCoins, 5);
});

test('regalo que no es de racha se cuenta al instante', (t) => {
  const { src, conn, events } = setup();
  t.after(() => src.stop());
  conn.emit(lib.WebcastEvent.GIFT, {
    common: common('u1'), user: user('9', 'Rey'), giftId: '6064', repeatCount: 1, repeatEnd: 0,
    gift: { type: 2, diamondCount: 199, name: 'Corona' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.totalCoins, 199);
});

test('eventos de una conexión vieja se ignoran tras reconectar', (t) => {
  const { src, conn, events } = setup();
  t.after(() => src.stop());
  src.generation += 1; // lo que hace _teardown() al reconectar
  conn.emit(lib.WebcastEvent.CHAT, { common: common('old'), user: user('1', 'Ana'), content: 'pe' });
  assert.equal(events.length, 0);
});

test('usuario no en vivo → estado "offline" y reintento con la espera configurada', (t) => {
  const { src } = setup();
  t.after(() => src.stop());
  const before = Date.now();
  src._onFailure(new lib.UserOfflineError('offline'), lib);
  assert.equal(src.status.state, 'offline');
  assert.match(src.status.reason, /no está en vivo/);
  const wait = src.status.nextRetryAt - before;
  assert.ok(wait >= 30000 - 50 && wait <= 30000 + 1000, `espera ${wait}`);
});

test('límite del servidor de firma → respeta retry-after (y al menos el mínimo)', (t) => {
  const { src } = setup();
  t.after(() => src.stop());
  const before = Date.now();
  src._onFailure(new lib.SignatureRateLimitError(undefined, 'Rate limited, retry in %s', { headers: { 'retry-after': '120' } }), lib);
  assert.equal(src.status.state, 'reconnecting');
  assert.match(src.status.reason, /limitó las conexiones/);
  const wait = src.status.nextRetryAt - before;
  assert.ok(wait >= 120000 - 50, `espera ${wait}`);
});

test('errores genéricos → espera creciente', (t) => {
  const { src } = setup();
  t.after(() => src.stop());
  const waits = [];
  for (let i = 0; i < 4; i++) {
    const before = Date.now();
    src._onFailure(new Error('socket hang up'), lib);
    waits.push(src.status.nextRetryAt - before);
  }
  assert.ok(waits[0] >= 1600 && waits[0] <= 2500, `primera espera ${waits[0]}`);
  assert.ok(waits[3] > waits[0] * 4, `debe crecer: ${waits.join(', ')}`);
  assert.equal(src.status.attempt, 4);
});

test('desconexión inesperada → reconecta; si terminó el LIVE → espera a que vuelva', (t) => {
  const { src, conn } = setup();
  t.after(() => src.stop());
  conn.emit(lib.ControlEvent.DISCONNECTED, { code: 1006, reason: '' });
  assert.equal(src.status.state, 'reconnecting');

  const s2 = setup();
  t.after(() => s2.src.stop());
  s2.conn.emit(lib.WebcastEvent.STREAM_END, { action: 3 });
  s2.conn.emit(lib.ControlEvent.DISCONNECTED, { code: 1000, reason: '' });
  assert.equal(s2.src.status.state, 'offline');
});

test('usuario inválido → error sin reintentos', (t) => {
  const { src } = setup();
  t.after(() => src.stop());
  src._onFailure(new lib.InvalidUniqueIdError('bad'), lib);
  assert.equal(src.status.state, 'error');
  assert.equal(src.wanted, false);
  assert.equal(src.status.nextRetryAt, 0);
});
