'use strict';

// Genera eventos falsos con el MISMO formato normalizado que tiktok.js, para probar sin TikTok.
// Los regalos de racha pasan por el mismo GiftStreakTracker que usa la conexión real
// (incluye mensajes repetidos a propósito, para comprobar que no se cuentan dos veces).

const { GiftStreakTracker } = require('./gifts');
const { createLogger } = require('./logger');

const log = createLogger('sim');

const NAMES = [
  'Ana', 'Luis', 'Camila', 'Mateo', 'Valeria', 'Diego', 'Sofía', 'Javier', 'Lucía', 'Andrés',
  'Daniela', 'Carlos', 'Fernanda', 'Jorge', 'Paola', 'Ricardo', 'Gabriela', 'Miguel', 'Renata', 'José',
  'Mariana', 'Santiago', 'Isabella', 'Sebastián', 'Ximena', 'Tomás', 'Antonella', 'Bruno', 'Florencia', 'Joaquín',
];

const GIFTS = {
  big: { giftId: 'sim-rosa', giftName: 'Rosa', coins: 1, streakable: true },
  chili: { giftId: 'sim-perfume', giftName: 'Perfume', coins: 20, streakable: false },
  pot: { giftId: 'sim-corona', giftName: 'Corona', coins: 199, streakable: false },
};

class Simulator {
  /**
   * @param {object} o
   * @param {(payload: object) => void} o.onEvent  recibe eventos crudos para createEvent()
   * @param {object} o.config
   * @param {() => number} [o.random]
   */
  constructor({ onEvent, config, random = Math.random }) {
    this.onEvent = onEvent;
    this.cfg = config;
    this.random = random;
    this.seq = 0;
    this.msgSeq = 0;
    this.users = [];            // usuarios falsos creados (los del modo carga también)
    this.loadUsers = [];
    this.loadTimer = null;
    this.timers = new Set();
    this.eventsSent = 0;
    this.tracker = new GiftStreakTracker({ timeoutMs: config.gifts.streakTimeoutSec * 1000 });
    this.sweepTimer = setInterval(() => {
      for (const g of this.tracker.sweep()) this._emitFinalGift(g);
    }, 1000);
    this.sweepTimer.unref?.();
  }

  setConfig(config) {
    this.cfg = config;
  }

  get status() {
    return {
      loadRunning: !!this.loadTimer,
      loadUsers: this.loadUsers.length,
      users: this.users.length,
      eventsSent: this.eventsSent,
    };
  }

  // ───────── acciones sueltas (botones del panel) ─────────

  /** Crea un jugador falso y lo une a un país comentando de distintas formas. */
  joinPlayer(teamCode) {
    const team = this._team(teamCode) || this._randomTeam();
    const user = this._newUser();
    user.team = team.code;
    this.users.push(user);
    this._emit('join', user);
    this._emit('comment', user, { text: this._joinPhrase(team) });
    return user;
  }

  /** Likes de un jugador (por defecto uno al azar). TikTok los manda en grupos de hasta ~15. */
  likes(total = 20, teamCode = null) {
    const user = this._pickUser(teamCode);
    let left = Math.max(1, Math.floor(total));
    while (left > 0) {
      const n = Math.min(left, 15);
      this._emit('like', user, { count: n });
      left -= n;
    }
    return user;
  }

  /** tier: 'big' | 'chili' | 'pot'. 'big' es una racha de rosas. */
  gift(tier = 'big', { teamCode = null, streak = 5 } = {}) {
    const user = this._pickUser(teamCode);
    this._sendGift(user, tier, streak);
    return user;
  }

  /** Elige el valor del regalo para que caiga en el tramo pedido aunque cambien los tramos. */
  _sendGift(user, tier, streak = 5) {
    const g = this.cfg.gifts;
    if (tier === 'chili') {
      const coins = Math.min(g.potMinCoins - 1, Math.max(g.chiliMinCoins, GIFTS.chili.coins));
      this._single(user, { ...GIFTS.chili, coins });
    } else if (tier === 'pot') {
      this._single(user, { ...GIFTS.pot, coins: Math.max(g.potMinCoins, GIFTS.pot.coins) });
    } else {
      const count = Math.max(g.bigMinCoins, Math.min(g.chiliMinCoins - 1, Math.floor(streak) || 1));
      this._streak(user, GIFTS.big, count);
    }
  }

  follow(teamCode = null) {
    const user = this._pickUser(teamCode);
    this._emit('follow', user);
    return user;
  }

  share(teamCode = null) {
    const user = this._pickUser(teamCode);
    this._emit('share', user);
    return user;
  }

  /** Comentario libre (sirve para probar la detección de países desde el panel). */
  comment(text) {
    const user = this._pickUser(null);
    this._emit('comment', user, { text: String(text || '') });
    return user;
  }

  // ───────── modo carga ─────────

  startLoad(count = 200) {
    this.stopLoad();
    const n = Math.max(1, Math.min(2000, Math.floor(count)));
    this.loadUsers = [];
    for (let i = 0; i < n; i++) {
      const user = this._newUser();
      user.team = this._randomTeam().code;
      user.joined = false;
      this.loadUsers.push(user);
    }
    log.info(`Modo carga: ${n} espectadores falsos`);
    const startedAt = Date.now();
    this.loadTimer = setInterval(() => this._loadTick(startedAt), 100);
  }

  stopLoad() {
    if (!this.loadTimer) return;
    clearInterval(this.loadTimer);
    this.loadTimer = null;
    log.info(`Modo carga detenido (${this.loadUsers.length} espectadores)`);
  }

  _loadTick(startedAt) {
    const r = this.random;
    const elapsed = Date.now() - startedAt;
    const users = this.loadUsers;
    // Se van uniendo durante los primeros 3 s, como en un LIVE real.
    const joinedTarget = Math.min(users.length, Math.ceil((elapsed / 3000) * users.length));
    for (let i = 0; i < joinedTarget; i++) {
      const u = users[i];
      if (!u.joined) {
        u.joined = true;
        this._emit('comment', u, { text: this._joinPhrase(this._team(u.team)) });
      }
    }
    for (let i = 0; i < joinedTarget; i++) {
      const u = users[i];
      const x = r();
      if (x < 0.08) {
        this._emit('like', u, { count: 1 + Math.floor(r() * 15) });
      } else if (x < 0.0815) {
        // Algunos se cambian de país.
        u.team = this._randomTeam().code;
        this._emit('comment', u, { text: this._joinPhrase(this._team(u.team)) });
      } else if (x < 0.0825) {
        this._emit('comment', u, { text: this._chatter() });
      } else if (x < 0.083) {
        const y = r();
        const tier = y < 0.8 ? 'big' : y < 0.97 ? 'chili' : 'pot';
        this._sendGift(u, tier, 1 + Math.floor(r() * 9));
      } else if (x < 0.0833) {
        this._emit('follow', u);
      } else if (x < 0.0836) {
        this._emit('share', u);
      }
    }
  }

  // ───────── regalos ─────────

  _single(user, def) {
    const msgId = this._msgId();
    const final = this.tracker.push({ ...def, msgId, user: this._public(user), repeatCount: 1, repeatEnd: true });
    if (final) this._emitFinalGift(final);
    // Duplicado del mismo mensaje: el tracker lo descarta.
    this.tracker.push({ ...def, msgId, user: this._public(user), repeatCount: 1, repeatEnd: true });
  }

  _streak(user, def, count) {
    const groupId = `g${this._msgId()}`;
    const pub = this._public(user);
    for (let i = 1; i <= count; i++) {
      this._later(i * 120, () => {
        const final = this.tracker.push({ ...def, msgId: this._msgId(), user: pub, groupId, repeatCount: i, repeatEnd: false });
        if (final) this._emitFinalGift(final);
      });
    }
    const endMsg = this._msgId();
    this._later(count * 120 + 600, () => {
      const final = this.tracker.push({ ...def, msgId: endMsg, user: pub, groupId, repeatCount: count, repeatEnd: true });
      if (final) this._emitFinalGift(final);
      // Final repetido con otro msgId (pasa a veces en TikTok): tampoco debe contar.
      this.tracker.push({ ...def, msgId: this._msgId(), user: pub, groupId, repeatCount: count, repeatEnd: true });
    });
  }

  _emitFinalGift(g) {
    this._emitRaw({
      id: g.msgId || undefined,
      type: 'gift',
      source: 'sim',
      user: g.user,
      data: { giftId: g.giftId, giftName: g.giftName, coins: g.coins, repeat: g.repeat },
    });
  }

  // ───────── utilidades ─────────

  _emit(type, user, data = {}) {
    this._emitRaw({ type, source: 'sim', user: this._public(user), data });
  }

  _emitRaw(payload) {
    this.eventsSent += 1;
    this.onEvent(payload);
  }

  _later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  _msgId() {
    this.msgSeq += 1;
    return `m${Date.now().toString(36)}${this.msgSeq.toString(36)}`;
  }

  _newUser() {
    this.seq += 1;
    const name = `${NAMES[Math.floor(this.random() * NAMES.length)]}_${10 + Math.floor(this.random() * 89)}`;
    return { id: `sim${this.seq}`, name, avatar: null, team: null };
  }

  _public(user) {
    return { id: user.id, name: user.name, avatar: user.avatar };
  }

  /** Un jugador ya unido (del país pedido si se indica); si no hay, se crea uno. */
  _pickUser(teamCode) {
    const pool = this.users.filter((u) => !teamCode || u.team === teamCode);
    if (pool.length) return pool[Math.floor(this.random() * pool.length)];
    return this.joinPlayer(teamCode);
  }

  _team(code) {
    return this.cfg.teams.find((t) => t.code === code) || null;
  }

  _randomTeam() {
    return this.cfg.teams[Math.floor(this.random() * this.cfg.teams.length)];
  }

  _joinPhrase(team) {
    const forms = [
      team.code,
      team.code.toUpperCase(),
      `!${team.code}`,
      team.country,
      team.country.toLowerCase(),
      `vamos ${team.country}!!`,
    ];
    return forms[Math.floor(this.random() * forms.length)];
  }

  _chatter() {
    const lines = ['jajaja', 'qué buena', 'dale dale', 'saludos!!', 'ese plato se ve rico 😋', 'vamos!!', '🔥🔥🔥'];
    return lines[Math.floor(this.random() * lines.length)];
  }

  stop() {
    this.stopLoad();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    clearInterval(this.sweepTimer);
  }
}

module.exports = { Simulator, SIM_GIFTS: GIFTS };
