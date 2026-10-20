'use strict';

// Reglas del juego. El servidor es la fuente de verdad: aquí se decide quién ataca a quién,
// cuánto daño hace y quién gana. El navegador solo dibuja lo que se le manda.
//
// No hace I/O ni usa timers propios: el reloj (now) y el azar (random) se inyectan y el
// servidor llama a tick() cada ~50 ms. Así las pruebas pueden simular minutos en un instante.

const { createCountryDetector } = require('./countries');
const { giftAttack } = require('./gifts');
const { RateLimiter } = require('./rate-limit');

// Tiempo de vuelo de cada ataque (ms). El cliente usa los mismos valores para animar.
const FLIGHT_MS = { small: 900, big: 1100, chili: 1500, pot: 1800 };

const MAX_COMMENT_FX = 6;

class GameState {
  /**
   * @param {object} o
   * @param {object} o.config         config.json ya validado
   * @param {object} o.stats          { roundsPlayed, countryWins, players } (se modifica en el sitio)
   * @param {() => number} [o.now]
   * @param {() => number} [o.random]
   * @param {() => void} [o.onStatsChange]   se llama cuando hay que guardar stats
   * @param {object} [o.log]
   */
  constructor({ config, stats, now = Date.now, random = Math.random, onStatsChange = () => {}, log = null }) {
    this.now = now;
    this.random = random;
    this.onStatsChange = onStatsChange;
    this.log = log || { info() {}, warn() {}, debug() {}, error() {} };
    this.stats = stats;
    this.players = new Map();
    this.pending = [];
    this.giftQueue = [];
    this.fx = [];
    this.commentFx = [];
    this.attackSeq = 0;
    this.round = {
      number: 0,
      phase: 'idle',
      startedAt: 0,
      endsAt: 0,
      durationMs: 0,
      pausedAt: 0,
      remainingAtPause: 0,
      restartAt: 0,
      winner: null,
    };
    this.applyConfig(config, true);
  }

  // ───────────────────────── configuración ─────────────────────────

  applyConfig(config, initial = false) {
    this.cfg = config;
    this.detector = createCountryDetector(config.teams);
    const perSec = Math.max(0.1, config.likes.maxProjectilesPerSec);
    if (this.likeLimiter) this.likeLimiter.setRate({ perSec, burst: perSec * 2 });
    else this.likeLimiter = new RateLimiter({ perSec, burst: perSec * 2, now: this.now });

    if (initial || !this.teams) {
      this.teams = new Map();
      config.teams.forEach((t, order) => {
        this.teams.set(t.code, this._freshTeam(t.code, order, config.round.maxHp));
      });
    }
  }

  _freshTeam(code, order, maxHp) {
    return {
      code,
      order,
      hp: maxHp,
      maxHp,
      alive: true,
      shieldUntil: 0,
      damageDealt: 0,
      damageTaken: 0,
      eliminatedAt: null,
    };
  }

  get phase() {
    return this.round.phase;
  }

  // ───────────────────────── rondas ─────────────────────────

  startRound() {
    const now = this.now();
    const r = this.round;
    r.number += 1;
    r.phase = 'running';
    r.startedAt = now;
    r.durationMs = this.cfg.round.durationSec * 1000;
    r.endsAt = now + r.durationMs;
    r.restartAt = 0;
    r.winner = null;

    for (const [code, t] of this.teams) {
      this.teams.set(code, this._freshTeam(code, t.order, this.cfg.round.maxHp));
    }
    for (const p of this.players.values()) {
      p.roundDamage = 0;
      p.roundCoins = 0;
      p.likeBuffer = 0;
    }
    this.pending = [];
    this._fx({ kind: 'roundStart', round: r.number, durationMs: r.durationMs });
    this.log.info(`Ronda ${r.number} iniciada (${this.cfg.round.durationSec} s)`);

    // Regalos que llegaron entre rondas o en pausa: no se pierden.
    const queued = this.giftQueue;
    this.giftQueue = [];
    for (const evt of queued) this._applyGift(evt, this.players.get(evt.user.id));
  }

  pauseRound() {
    const r = this.round;
    if (r.phase !== 'running') return false;
    const now = this.now();
    r.phase = 'paused';
    r.pausedAt = now;
    r.remainingAtPause = Math.max(0, r.endsAt - now);
    this._fx({ kind: 'paused' });
    this.log.info(`Ronda ${r.number} en pausa`);
    return true;
  }

  resumeRound() {
    const r = this.round;
    if (r.phase !== 'paused') return false;
    const delta = this.now() - r.pausedAt;
    r.endsAt += delta;
    for (const a of this.pending) a.hitAt += delta;
    for (const t of this.teams.values()) if (t.shieldUntil > r.pausedAt) t.shieldUntil += delta;
    r.phase = 'running';
    this._fx({ kind: 'resumed' });
    this.log.info(`Ronda ${r.number} reanudada`);
    return true;
  }

  /** Reinicia la ronda actual desde cero, sin ganador. */
  restartRound() {
    this.log.info('Reinicio manual de ronda');
    this.startRound();
  }

  resetRanking() {
    this.stats.roundsPlayed = 0;
    this.stats.countryWins = {};
    this.stats.players = {};
    this.onStatsChange();
    this.log.info('Ranking reiniciado');
  }

  tick() {
    const now = this.now();
    const r = this.round;

    if (r.phase === 'running') {
      if (this.pending.length) this._resolveHits(now);
      if (r.phase === 'running' && now >= r.endsAt) this._endRound('time');
    } else if (r.phase === 'ended' && this.cfg.round.autoRestart && now >= r.restartAt) {
      this.startRound();
    }
  }

  _resolveHits(now) {
    const still = [];
    const due = [];
    for (const a of this.pending) (a.hitAt <= now ? due : still).push(a);
    this.pending = still;

    for (const a of due) {
      for (const code of a.targets) {
        const team = this.teams.get(code);
        if (!team || !team.alive) continue;
        if (team.shieldUntil > now) {
          this._fx({ kind: 'hit', id: a.id, attack: a.kind, to: code, damage: 0, blocked: true, hp: team.hp });
          continue;
        }
        const dmg = Math.min(a.damage, team.hp);
        team.hp -= dmg;
        team.damageTaken += dmg;
        const from = this.teams.get(a.from);
        if (from) from.damageDealt += dmg;
        this._creditDamage(a.attackerId, dmg);
        this._fx({ kind: 'hit', id: a.id, attack: a.kind, to: code, damage: dmg, hp: team.hp });
        if (team.hp <= 0) {
          team.alive = false;
          team.eliminatedAt = now;
          this._fx({ kind: 'eliminated', team: code });
          this.log.info(`Plato eliminado: ${code}`);
        }
      }
    }

    const alive = [...this.teams.values()].filter((t) => t.alive).length;
    if (alive <= 1) this._endRound('last');
  }

  _creditDamage(userId, dmg) {
    if (!dmg) return;
    const p = this.players.get(userId);
    if (p) p.roundDamage += dmg;
    const rec = this._statsPlayer(userId, p);
    rec.damage += dmg;
    this.onStatsChange();
  }

  _statsPlayer(userId, p) {
    let rec = this.stats.players[userId];
    if (!rec) {
      rec = { name: p ? p.name : 'Anónimo', avatar: p ? p.avatar : null, damage: 0, coins: 0, mvps: 0, team: p ? p.team : null };
      this.stats.players[userId] = rec;
    } else if (p) {
      rec.name = p.name;
      rec.avatar = p.avatar;
      rec.team = p.team;
    }
    rec.seenAt = this.now();
    return rec;
  }

  /** Orden de clasificación: vivo, más vida, eliminado más tarde, más daño hecho. */
  _standings() {
    return [...this.teams.values()].sort((a, b) =>
      (b.alive - a.alive)
      || (b.hp - a.hp)
      || ((b.eliminatedAt ?? Infinity) - (a.eliminatedAt ?? Infinity))
      || (b.damageDealt - a.damageDealt)
      || (a.order - b.order));
  }

  _endRound(reason) {
    const now = this.now();
    const r = this.round;
    const standings = this._standings();
    const [first, second] = standings;
    const tied = second
      && first.alive === second.alive
      && first.hp === second.hp
      && (first.eliminatedAt ?? Infinity) === (second.eliminatedAt ?? Infinity)
      && first.damageDealt === second.damageDealt;
    const winner = tied ? null : first.code;

    const ranked = [...this.players.values()].filter((p) => p.roundDamage > 0)
      .sort((a, b) => b.roundDamage - a.roundDamage);
    const mvpP = ranked[0] || null;
    const mvp = mvpP ? { id: mvpP.id, name: mvpP.name, avatar: mvpP.avatar, team: mvpP.team, damage: mvpP.roundDamage } : null;

    this.stats.roundsPlayed = (this.stats.roundsPlayed || 0) + 1;
    if (winner) this.stats.countryWins[winner] = (this.stats.countryWins[winner] || 0) + 1;
    if (mvp) this._statsPlayer(mvp.id, mvpP).mvps += 1;

    r.phase = 'ended';
    r.restartAt = now + this.cfg.round.winnerScreenSec * 1000;
    r.winner = {
      team: winner,
      reason,
      mvp,
      top: ranked.slice(0, 3).map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, team: p.team, damage: p.roundDamage })),
      standings: standings.map((t) => ({ code: t.code, hp: t.hp, alive: t.alive, damageDealt: t.damageDealt })),
    };
    this.pending = [];
    this._fx({ kind: 'roundEnd', round: r.number, ...r.winner, winnerScreenMs: this.cfg.round.winnerScreenSec * 1000 });
    this.onStatsChange();
    this.log.info(`Ronda ${r.number} terminada (${reason === 'time' ? 'tiempo' : 'último en pie'}). `
      + `Ganador: ${winner || 'empate'}${mvp ? ` · MVP ${mvp.name} (${mvp.damage})` : ''}`);
  }

  // ───────────────────────── eventos ─────────────────────────

  handleEvent(evt) {
    if (!evt || !evt.user) return;
    switch (evt.type) {
      case 'join': {
        const p = this.players.get(evt.user.id);
        if (p) this._touch(p, evt.user);
        break;
      }
      case 'comment':
        this._onComment(evt);
        break;
      case 'like':
        this._onLike(evt);
        break;
      case 'gift':
        this._onGift(evt);
        break;
      case 'follow':
      case 'share':
        this._onSocial(evt);
        break;
      default:
        break;
    }
  }

  _player(user) {
    let p = this.players.get(user.id);
    if (!p) {
      p = {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        team: null,
        lastActiveAt: 0,
        lastSwitchAt: -Infinity,
        likeBuffer: 0,
        roundDamage: 0,
        roundCoins: 0,
      };
      this.players.set(user.id, p);
    }
    this._touch(p, user);
    return p;
  }

  _touch(p, user) {
    p.name = user.name || p.name;
    if (user.avatar) p.avatar = user.avatar;
    p.lastActiveAt = this.now();
  }

  _onComment(evt) {
    const code = this.detector.detect(evt.data.text);
    const known = this.players.get(evt.user.id);
    if (code && this.teams.has(code)) {
      this._joinTeam(this._player(evt.user), code);
    } else if (known) {
      this._touch(known, evt.user);
    }
    // Los comentarios que solo eligen país ya se muestran como "se unió"; no se repiten.
    if (this.cfg.display.showComments && !code) {
      const team = (known || this.players.get(evt.user.id))?.team || null;
      this.commentFx.push({ kind: 'comment', user: { name: evt.user.name }, team, text: evt.data.text });
      if (this.commentFx.length > MAX_COMMENT_FX) this.commentFx.shift();
    }
  }

  _joinTeam(p, code) {
    if (p.team === code) return false;
    const now = this.now();
    const switching = !!p.team;
    if (switching && now - p.lastSwitchAt < this.cfg.join.switchCooldownSec * 1000) return false;
    const prev = p.team;
    p.team = code;
    p.lastSwitchAt = now;
    p.likeBuffer = 0;
    this._fx({ kind: 'join', user: { id: p.id, name: p.name, avatar: p.avatar }, team: code, from: prev });
    this.log.debug(`${p.name} → ${code}${prev ? ` (antes ${prev})` : ''}`);
    return true;
  }

  _onLike(evt) {
    const p = this.players.get(evt.user.id);
    if (!p) return;
    this._touch(p, evt.user);
    if (!p.team || this.round.phase !== 'running') return;
    const team = this.teams.get(p.team);
    if (!team || !team.alive) return;

    const per = Math.max(1, this.cfg.likes.likesPerProjectile);
    p.likeBuffer += evt.data.count;
    let shots = Math.floor(p.likeBuffer / per);
    p.likeBuffer -= shots * per;
    while (shots-- > 0) {
      if (!this.likeLimiter.take(p.id)) {
        // Spam: se descartan los proyectiles extra de este usuario.
        break;
      }
      const target = this._randomRival(p.team);
      if (!target) break;
      this._launch('small', p, [target], this.cfg.likes.damage, 1);
    }
  }

  _onGift(evt) {
    const p = this._player(evt.user);
    const total = evt.data.totalCoins;
    if (total > 0) {
      p.roundCoins += total;
      this._statsPlayer(p.id, p).coins += total;
      this.onStatsChange();
    }

    // Sin equipo, o con su plato eliminado: se le asigna el país con menos jugadores.
    const myTeam = p.team ? this.teams.get(p.team) : null;
    if (!myTeam || (!myTeam.alive && this.round.phase === 'running')) {
      const code = this._smallestAliveTeam();
      if (code) {
        const prev = p.team;
        p.team = code;
        p.lastSwitchAt = this.now();
        this._fx({ kind: 'join', user: { id: p.id, name: p.name, avatar: p.avatar }, team: code, from: prev, auto: true });
      }
    }

    const attack = giftAttack(total, this.cfg.gifts);
    this._fx({
      kind: 'gift',
      user: { id: p.id, name: p.name, avatar: p.avatar },
      team: p.team,
      giftName: evt.data.giftName,
      repeat: evt.data.repeat,
      totalCoins: total,
      tier: attack ? attack.tier : null,
      big: total >= this.cfg.gifts.alertMinCoins,
    });
    if (!attack) return;

    if (this.round.phase !== 'running') {
      if (this.giftQueue.length < this.cfg.limits.maxQueuedGifts) this.giftQueue.push(evt);
      else this.log.warn(`Cola de regalos llena; se descarta el regalo de ${p.name}`);
      return;
    }
    this._applyGift(evt, p);
  }

  _applyGift(evt, p) {
    if (!p || !p.team) return;
    const team = this.teams.get(p.team);
    if (!team || !team.alive) return;
    const attack = giftAttack(evt.data.totalCoins, this.cfg.gifts);
    if (!attack) return;
    if (attack.tier === 'pot') {
      const targets = this._aliveRivals(p.team);
      if (targets.length) this._launch('pot', p, targets, attack.damage, attack.multiplier, true);
    } else {
      const target = this._randomRival(p.team);
      if (target) this._launch(attack.tier, p, [target], attack.damage, attack.multiplier, true);
    }
  }

  _onSocial(evt) {
    const p = this.players.get(evt.user.id);
    if (!p) return;
    this._touch(p, evt.user);
    if (!p.team || this.round.phase !== 'running') return;
    const team = this.teams.get(p.team);
    if (!team || !team.alive) return;

    const s = this.cfg.social;
    const cdSec = evt.type === 'follow' ? s.followCooldownSec : s.shareCooldownSec;
    const key = `${evt.type}At`;
    const now = this.now();
    if (p[key] && now - p[key] < cdSec * 1000) return;
    p[key] = now;

    const effect = evt.type === 'follow' ? s.follow : s.share;
    const user = { id: p.id, name: p.name, avatar: p.avatar };
    if (effect === 'shield') {
      team.shieldUntil = Math.max(team.shieldUntil, now + s.shieldSec * 1000);
      this._fx({ kind: 'shield', team: team.code, ms: team.shieldUntil - now, user, via: evt.type });
    } else if (effect === 'heal') {
      const amount = Math.min(team.maxHp - team.hp, Math.round(team.maxHp * (s.healPct / 100)));
      team.hp += amount;
      this._fx({ kind: 'heal', team: team.code, amount, hp: team.hp, user, via: evt.type });
    }
  }

  _launch(kind, p, targets, damage, multiplier, withUser = false) {
    if (kind === 'small' && this.pending.length >= this.cfg.limits.maxPendingAttacks) return;
    const flightMs = FLIGHT_MS[kind];
    const a = {
      id: ++this.attackSeq,
      kind,
      from: p.team,
      targets,
      damage,
      attackerId: p.id,
      hitAt: this.now() + flightMs,
    };
    this.pending.push(a);
    const fx = { kind: 'launch', id: a.id, attack: kind, from: a.from, targets, flightMs, mult: Math.round(multiplier * 10) / 10 };
    if (withUser) fx.user = { name: p.name, avatar: p.avatar };
    this._fx(fx);
  }

  _aliveRivals(code) {
    const out = [];
    for (const t of this.teams.values()) if (t.alive && t.code !== code) out.push(t.code);
    return out;
  }

  _randomRival(code) {
    const rivals = this._aliveRivals(code);
    if (!rivals.length) return null;
    return rivals[Math.floor(this.random() * rivals.length) % rivals.length];
  }

  _activeCounts() {
    const since = this.now() - this.cfg.join.activeWindowMin * 60000;
    const counts = {};
    for (const code of this.teams.keys()) counts[code] = 0;
    for (const p of this.players.values()) {
      if (p.team && p.lastActiveAt >= since && counts[p.team] !== undefined) counts[p.team] += 1;
    }
    return counts;
  }

  _smallestAliveTeam() {
    const counts = this._activeCounts();
    const alive = [...this.teams.values()].filter((t) => t.alive);
    const pool = alive.length ? alive : [...this.teams.values()];
    const min = Math.min(...pool.map((t) => counts[t.code]));
    const best = pool.filter((t) => counts[t.code] === min);
    return best[Math.floor(this.random() * best.length) % best.length].code;
  }

  // ───────────────────────── salida ─────────────────────────

  _fx(e) {
    this.fx.push(e);
  }

  /** Devuelve y vacía los efectos acumulados desde la última llamada. */
  drainFx() {
    const out = this.fx;
    if (this.commentFx.length) out.push(...this.commentFx);
    this.fx = [];
    this.commentFx = [];
    return out;
  }

  topCountries(n = 3) {
    const wins = this.stats.countryWins || {};
    return [...this.teams.values()]
      .map((t) => ({ code: t.code, wins: wins[t.code] || 0 }))
      .sort((a, b) => b.wins - a.wins || this.teams.get(a.code).order - this.teams.get(b.code).order)
      .slice(0, n);
  }

  topRoundPlayers(n = 5) {
    const list = [];
    for (const p of this.players.values()) if (p.roundDamage > 0) list.push(p);
    list.sort((a, b) => b.roundDamage - a.roundDamage);
    return list.slice(0, n).map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, team: p.team, damage: p.roundDamage }));
  }

  topAllTime(n = 10) {
    return Object.entries(this.stats.players || {})
      .map(([id, r]) => ({ id, name: r.name, avatar: r.avatar, team: r.team, damage: r.damage || 0, coins: r.coins || 0, mvps: r.mvps || 0 }))
      .sort((a, b) => b.damage - a.damage || b.coins - a.coins)
      .slice(0, n);
  }

  snapshot() {
    const now = this.now();
    const r = this.round;
    const counts = this._activeCounts();
    let remainingMs = 0;
    if (r.phase === 'running') remainingMs = Math.max(0, r.endsAt - now);
    else if (r.phase === 'paused') remainingMs = r.remainingAtPause;
    return {
      phase: r.phase,
      round: r.number,
      remainingMs,
      durationMs: r.durationMs || this.cfg.round.durationSec * 1000,
      restartInMs: r.phase === 'ended' ? Math.max(0, r.restartAt - now) : 0,
      teams: [...this.teams.values()].map((t) => ({
        code: t.code,
        hp: t.hp,
        maxHp: t.maxHp,
        alive: t.alive,
        shieldMs: Math.max(0, t.shieldUntil - now),
        players: counts[t.code],
        damageDealt: t.damageDealt,
      })),
      topPlayers: this.topRoundPlayers(5),
      topCountries: this.topCountries(3),
      winner: r.phase === 'ended' ? r.winner : null,
      totals: {
        players: Object.values(counts).reduce((s, n) => s + n, 0),
        pending: this.pending.length,
        queuedGifts: this.giftQueue.length,
      },
    };
  }
}

module.exports = { GameState, FLIGHT_MS };
