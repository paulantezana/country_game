'use strict';

// Logs con hora, nivel y módulo. Colores ANSI (Windows Terminal y PowerShell 7 los soportan).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

let minLevel = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function setLevel(level) {
  if (LEVELS[level]) minLevel = LEVELS[level];
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function write(level, scope, args) {
  if (LEVELS[level] < minLevel) return;
  const tag = `[${stamp()}] ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const line = useColor ? `${COLORS[level]}${tag}${RESET}` : tag;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line, ...args);
}

function createLogger(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

module.exports = { createLogger, setLevel };
