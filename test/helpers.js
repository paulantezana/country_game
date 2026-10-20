'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Las pruebas no necesitan los logs del servidor.
require('../server/logger').setLevel('silent');

function loadTestConfig(overrides = {}) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  for (const [section, values] of Object.entries(overrides)) Object.assign(cfg[section], values);
  return cfg;
}

function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  now.set = (v) => { t = v; };
  return now;
}

// Azar reproducible (LCG) para que las pruebas den siempre lo mismo.
function seededRandom(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

module.exports = { loadTestConfig, fakeClock, seededRandom };
