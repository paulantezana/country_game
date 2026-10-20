'use strict';

// Carga y valida config.json, lee .env y guarda los cambios hechos desde /admin.

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('config');
const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const ENV_FILE = path.join(ROOT, '.env');

// Ajustes que se pueden cambiar desde /admin: ruta → [mínimo, máximo] (o lista de valores).
const EDITABLE = {
  'round.durationSec': [30, 3600],
  'round.winnerScreenSec': [3, 60],
  'round.maxHp': [100, 100000],
  'round.autoRestart': 'boolean',
  'likes.likesPerProjectile': [1, 10000],
  'likes.damage': [0, 10000],
  'likes.maxProjectilesPerSec': [0.2, 50],
  'gifts.bigMinCoins': [1, 1000000],
  'gifts.chiliMinCoins': [1, 1000000],
  'gifts.potMinCoins': [1, 1000000],
  'gifts.bigDamage': [0, 100000],
  'gifts.chiliDamage': [0, 100000],
  'gifts.potDamage': [0, 100000],
  'gifts.maxMultiplier': [1, 100],
  'gifts.alertMinCoins': [1, 1000000],
  'join.switchCooldownSec': [0, 3600],
  'social.follow': ['shield', 'heal', 'none'],
  'social.share': ['shield', 'heal', 'none'],
  'social.shieldSec': [1, 120],
  'social.healPct': [0, 100],
  'display.maxProjectiles': [5, 300],
  'display.showComments': 'boolean',
  'sound.volume': [0, 1],
  'sound.hit': [0, 1],
  'sound.gift': [0, 1],
  'sound.win': [0, 1],
};

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  try {
    process.loadEnvFile(ENV_FILE);
    log.info('Variables de .env cargadas.');
  } catch (err) {
    log.warn(`No se pudo leer .env: ${err.message}`);
  }
}

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function set(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys[keys.length - 1]] = value;
}

function validate(cfg) {
  const errors = [];
  if (!Array.isArray(cfg.teams) || cfg.teams.length < 2) errors.push('teams: hacen falta al menos 2 equipos');
  const codes = new Set();
  for (const t of cfg.teams || []) {
    if (!/^[a-z]{2}$/.test(t.code || '')) errors.push(`teams: código inválido "${t.code}" (2 letras minúsculas)`);
    if (codes.has(t.code)) errors.push(`teams: código repetido "${t.code}"`);
    codes.add(t.code);
    if (!t.country || !t.dish || !t.image) errors.push(`teams.${t.code}: faltan country, dish o image`);
    if (t.image && !/^[\w.-]+\.(svg|png|webp|jpg|jpeg)$/i.test(t.image)) errors.push(`teams.${t.code}: nombre de imagen inválido`);
  }
  for (const [key, rule] of Object.entries(EDITABLE)) {
    const v = get(cfg, key);
    if (rule === 'boolean') {
      if (typeof v !== 'boolean') errors.push(`${key}: debe ser true o false`);
    } else if (Array.isArray(rule) && typeof rule[0] === 'string') {
      if (!rule.includes(v)) errors.push(`${key}: debe ser uno de ${rule.join(', ')}`);
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < rule[0] || v > rule[1]) {
      errors.push(`${key}: debe ser un número entre ${rule[0]} y ${rule[1]}`);
    }
  }
  const g = cfg.gifts || {};
  if (!(g.bigMinCoins < g.chiliMinCoins && g.chiliMinCoins < g.potMinCoins)) {
    errors.push('gifts: los tramos deben ir en orden (grande < ají < olla)');
  }
  return errors;
}

function loadConfig() {
  loadEnv();
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`No se pudo leer config.json: ${err.message}`);
  }
  const errors = validate(cfg);
  if (errors.length) throw new Error(`config.json tiene errores:\n  - ${errors.join('\n  - ')}`);
  if (process.env.PORT) cfg.server.port = Number(process.env.PORT) || cfg.server.port;
  if (process.env.TIKTOK_USERNAME && !cfg.tiktok.username) cfg.tiktok.username = process.env.TIKTOK_USERNAME;
  return cfg;
}

/**
 * Aplica cambios desde /admin. Solo acepta las claves de EDITABLE.
 * @returns {{ ok: boolean, config?: object, errors?: string[] }}
 */
function applyPatch(current, patch) {
  const next = structuredClone(current);
  const errors = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    const rule = EDITABLE[key];
    if (!rule) {
      errors.push(`${key}: no se puede editar desde el panel`);
      continue;
    }
    let value = raw;
    if (rule === 'boolean') value = raw === true || raw === 'true';
    else if (Array.isArray(rule) && typeof rule[0] === 'number') value = Number(raw);
    set(next, key, value);
  }
  errors.push(...validate(next));
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: next };
}

/** Guarda en config.json solo lo editable, sin pisar lo demás (p. ej. equipos editados a mano). */
function saveConfig(cfg) {
  let onDisk;
  try {
    onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    onDisk = structuredClone(cfg);
  }
  for (const key of Object.keys(EDITABLE)) set(onDisk, key, get(cfg, key));
  if (cfg.tiktok && typeof cfg.tiktok.username === 'string') onDisk.tiktok.username = cfg.tiktok.username;
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, formatConfig(onDisk), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

// JSON con sangría, pero cada equipo en una sola línea para que sea fácil de editar a mano.
function formatConfig(cfg) {
  const { teams, ...rest } = cfg;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  const lines = (teams || []).map((t) => `    { ${Object.entries(t).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`);
  return `${head},\n  "teams": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

/** Lo que el panel muestra en el formulario de ajustes. */
function editableView(cfg) {
  const out = {};
  for (const key of Object.keys(EDITABLE)) out[key] = get(cfg, key);
  return out;
}

module.exports = { loadConfig, applyPatch, saveConfig, editableView, validate, EDITABLE, ROOT };
