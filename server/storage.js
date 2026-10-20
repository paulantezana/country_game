'use strict';

// Rondas ganadas y ranking en data/stats.json.
// Escritura atómica: se escribe un .tmp y luego se renombra, así un cierre brusco
// nunca deja el archivo a medias. Los guardados se agrupan (debounce).

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('datos');
const MAX_PLAYERS = 5000;

function emptyStats() {
  return { version: 1, roundsPlayed: 0, countryWins: {}, players: {} };
}

class StatsStore {
  constructor(file, { debounceMs = 2000 } = {}) {
    this.file = file;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.data = emptyStats();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      log.info(`No existe ${path.relative(process.cwd(), this.file)}; se creará al terminar la primera ronda.`);
      return this.data;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...emptyStats(),
        ...parsed,
        countryWins: parsed.countryWins && typeof parsed.countryWins === 'object' ? parsed.countryWins : {},
        players: parsed.players && typeof parsed.players === 'object' ? parsed.players : {},
      };
      log.info(`Stats cargadas: ${this.data.roundsPlayed} rondas, ${Object.keys(this.data.players).length} jugadores.`);
    } catch (err) {
      const backup = `${this.file}.corrupto-${Date.now()}`;
      try { fs.renameSync(this.file, backup); } catch { /* sin respaldo posible */ }
      log.warn(`stats.json estaba dañado (${err.message}). Se guardó una copia en ${path.basename(backup)} y se empieza de cero.`);
      this.data = emptyStats();
    }
    return this.data;
  }

  /** Pide un guardado (se agrupan varios en uno). */
  markDirty() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }

  saveNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._prune();
    const tmp = `${this.file}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    try {
      fs.writeFileSync(tmp, json, 'utf8');
      this._renameWithRetry(tmp, this.file);
    } catch (err) {
      log.error(`No se pudo guardar stats.json: ${err.message}`);
    }
  }

  _renameWithRetry(from, to) {
    // En Windows un antivirus o el indexador puede bloquear el archivo un instante.
    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(from, to);
        return;
      } catch (err) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || i === 4) throw err;
        const until = Date.now() + 50 * (i + 1);
        while (Date.now() < until) { /* espera corta */ }
      }
    }
  }

  _prune() {
    const ids = Object.keys(this.data.players);
    if (ids.length <= MAX_PLAYERS) return;
    const keep = ids
      .map((id) => [id, this.data.players[id]])
      .sort((a, b) => (b[1].damage + b[1].coins * 10) - (a[1].damage + a[1].coins * 10))
      .slice(0, MAX_PLAYERS);
    this.data.players = Object.fromEntries(keep);
  }
}

module.exports = { StatsStore, emptyStats };
