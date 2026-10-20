'use strict';

// Regalos: tramos por monedas y rachas.
//
// Rachas (según el README de tiktok-live-connector 2.5.0): los regalos con giftType === 1 llegan
// varias veces mientras dura la racha, con repeatEnd = false y repeatCount creciendo, y una vez
// más al final con repeatEnd = true y el repeatCount final. Ese último es el único que se cuenta.
// Los regalos que no son de racha se cuentan en cuanto llegan.
//
// Este módulo no sabe nada de la librería: recibe un objeto simple (ver push()).

const TIERS = ['big', 'chili', 'pot'];

/** Devuelve 'big' | 'chili' | 'pot' | null según el total de monedas (valor × cantidad). */
function giftTier(totalCoins, cfg) {
  const coins = Number(totalCoins) || 0;
  if (coins >= cfg.potMinCoins) return 'pot';
  if (coins >= cfg.chiliMinCoins) return 'chili';
  if (coins >= cfg.bigMinCoins) return 'big';
  return null;
}

/**
 * Daño del ataque de un regalo. Crece con las monedas dentro del tramo hasta maxMultiplier.
 * Ej.: tramo "big" empieza en 1 moneda con 30 de daño → 3 monedas = 90, 9 monedas = 150 (tope ×5).
 */
function giftAttack(totalCoins, cfg) {
  const tier = giftTier(totalCoins, cfg);
  if (!tier) return null;
  const minCoins = Math.max(1, cfg[`${tier}MinCoins`]);
  const base = cfg[`${tier}Damage`];
  const multiplier = Math.min(cfg.maxMultiplier, Math.max(1, totalCoins / minCoins));
  return { tier, multiplier, damage: Math.round(base * multiplier) };
}

class GiftStreakTracker {
  /**
   * @param {object} [o]
   * @param {number} [o.timeoutMs]  si una racha no recibe nada en este tiempo se cierra sola
   * @param {() => number} [o.now]
   */
  constructor({ timeoutMs = 15000, now = Date.now, maxSeen = 5000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.maxSeen = maxSeen;
    this.seenMsg = new Map();   // msgId → ts (deduplicado de mensajes repetidos)
    this.streaks = new Map();   // clave de racha → { gift, count, lastAt }
    this.closed = new Map();    // clave de racha → expiración (evita contar dos veces el final)
  }

  /**
   * @param {object} g
   * @param {string} [g.msgId]       id del mensaje (para descartar duplicados)
   * @param {object} g.user          { id, name, avatar }
   * @param {string} g.giftId
   * @param {string} [g.giftName]
   * @param {number} g.coins         valor de UNA unidad del regalo
   * @param {boolean} g.streakable   giftType === 1
   * @param {boolean} g.repeatEnd
   * @param {number} g.repeatCount
   * @param {string} [g.groupId]     id de la racha
   * @returns {object|null} regalo final { msgId, user, giftId, giftName, coins, repeat } o null
   */
  push(g) {
    if (!g || !g.user || !g.user.id) return null;
    const now = this.now();

    if (g.msgId) {
      if (this.seenMsg.has(g.msgId)) return null;
      this.seenMsg.set(g.msgId, now);
      if (this.seenMsg.size > this.maxSeen) {
        const drop = this.seenMsg.size - this.maxSeen;
        let i = 0;
        for (const k of this.seenMsg.keys()) {
          if (i++ >= drop) break;
          this.seenMsg.delete(k);
        }
      }
    }

    const count = Math.max(1, Math.floor(Number(g.repeatCount) || 1));

    if (!g.streakable) return this._final(g, count, false);

    const key = `${g.user.id}|${g.giftId}|${g.groupId || ''}`;
    const closedUntil = this.closed.get(key);
    if (closedUntil && closedUntil > now) return null;

    const prev = this.streaks.get(key);
    const best = Math.max(prev ? prev.count : 0, count);

    if (!g.repeatEnd) {
      this.streaks.set(key, { gift: g, count: best, lastAt: now });
      return null;
    }

    this.streaks.delete(key);
    this._close(key, g.groupId, now);
    return this._final(g, best, false);
  }

  /** Cierra rachas que se quedaron sin final (p. ej. se cortó la conexión). */
  sweep() {
    const now = this.now();
    const out = [];
    for (const [key, s] of this.streaks) {
      if (now - s.lastAt >= this.timeoutMs) {
        this.streaks.delete(key);
        this._close(key, s.gift.groupId, now);
        out.push(this._final(s.gift, s.count, true));
      }
    }
    for (const [key, until] of this.closed) if (until <= now) this.closed.delete(key);
    return out;
  }

  get pendingCount() {
    return this.streaks.size;
  }

  _close(key, groupId, now) {
    // Con groupId la racha es única: se bloquea más tiempo. Sin él, solo un momento,
    // para no tapar una racha nueva del mismo regalo.
    this.closed.set(key, now + (groupId ? 60000 : 3000));
  }

  _final(g, repeat, stale) {
    return {
      msgId: g.msgId || null,
      user: g.user,
      giftId: String(g.giftId || 'gift'),
      giftName: g.giftName || 'Regalo',
      coins: Math.max(0, Number(g.coins) || 0),
      repeat,
      stale,
    };
  }
}

module.exports = { giftTier, giftAttack, GiftStreakTracker, TIERS };
