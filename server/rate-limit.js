'use strict';

// Cubeta de fichas por clave (usuario). take() gasta una ficha si hay.
class RateLimiter {
  /**
   * @param {object} o
   * @param {number} o.perSec   fichas que se recuperan por segundo
   * @param {number} o.burst    máximo de fichas acumuladas
   * @param {() => number} [o.now]
   */
  constructor({ perSec, burst, now = Date.now, maxKeys = 20000 }) {
    this.perSec = perSec;
    this.burst = burst;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  take(key, cost = 1) {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
      if (this.buckets.size > this.maxKeys) this._prune(now);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSec);
      b.at = now;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return true;
    }
    return false;
  }

  setRate({ perSec, burst }) {
    if (perSec > 0) this.perSec = perSec;
    if (burst > 0) this.burst = burst;
  }

  _prune(now) {
    // Las cubetas llenas desde hace rato no aportan nada: se borran.
    const fullAfterMs = (this.burst / this.perSec) * 1000;
    for (const [k, b] of this.buckets) if (now - b.at > fullAfterMs) this.buckets.delete(k);
  }
}

// Espera mínima entre acciones del mismo usuario (cambio de equipo, follow, share).
class Cooldown {
  constructor({ now = Date.now, maxKeys = 20000 } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
    this.until = new Map();
  }

  /** true si la acción está permitida (y arranca la espera). */
  try(key, ms) {
    const now = this.now();
    const u = this.until.get(key);
    if (u && u > now) return false;
    this.until.set(key, now + ms);
    if (this.until.size > this.maxKeys) {
      for (const [k, v] of this.until) if (v <= now) this.until.delete(k);
    }
    return true;
  }

  remaining(key) {
    const u = this.until.get(key);
    return u ? Math.max(0, u - this.now()) : 0;
  }

  clear() {
    this.until.clear();
  }
}

module.exports = { RateLimiter, Cooldown };
