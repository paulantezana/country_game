'use strict';

// Punto de entrada: Express + Socket.IO en 127.0.0.1. Une fuentes de eventos (TikTok y
// simulador) → eventos normalizados → reglas del juego → navegador (/game y /admin).

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');

const { createLogger } = require('./logger');
const { loadConfig, applyPatch, saveConfig, editableView, ROOT } = require('./config');
const { createEvent } = require('./events');
const { GameState, FLIGHT_MS } = require('./game-state');
const { StatsStore } = require('./storage');
const { Simulator } = require('./simulator');
const { TikTokSource } = require('./tiktok');

const log = createLogger('servidor');
const HOST = '127.0.0.1';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

// ───────────────────────── estado ─────────────────────────

const store = new StatsStore(path.join(ROOT, 'data', 'stats.json'));
store.load();

const game = new GameState({
  config,
  stats: store.data,
  onStatsChange: () => store.markDirty(),
  log: createLogger('juego'),
});

const recent = [];             // últimos eventos para el panel
let eventsThisSecond = 0;
let eventsPerSec = 0;
let lastPerf = null;

function eventOptions() {
  return {
    maxNameLength: config.moderation.maxNameLength,
    maxCommentLength: config.moderation.maxCommentLength,
    bannedWords: config.moderation.bannedWords,
  };
}

function ingest(payload) {
  const evt = createEvent(payload, eventOptions());
  if (!evt) return;
  eventsThisSecond += 1;
  try {
    game.handleEvent(evt);
  } catch (err) {
    log.error(`Error en reglas con evento ${evt.type}: ${err.stack || err.message}`);
  }
  // En el registro del panel no se guardan likes sueltos del modo carga (serían cientos por segundo).
  if (evt.type !== 'like' || evt.source === 'tiktok') {
    recent.push({ ts: evt.ts, type: evt.type, source: evt.source, name: evt.user.name, data: evt.data });
    if (recent.length > 40) recent.shift();
  }
}

const sim = new Simulator({ onEvent: ingest, config });
const tiktok = new TikTokSource({ onEvent: ingest, config });

// ───────────────────────── HTTP ─────────────────────────

const app = express();
app.disable('x-powered-by');

// Solo se acepta tráfico dirigido a localhost (evita "DNS rebinding" desde páginas externas).
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOOPBACK.has(host)) return res.status(403).send('Solo localhost');
  next();
});

const pub = path.join(ROOT, 'public');
app.get('/', (req, res) => res.redirect('/game/'));
app.use('/game', express.static(path.join(pub, 'game')));
app.use('/admin', express.static(path.join(pub, 'admin')));
app.use('/assets', express.static(path.join(pub, 'assets')));
app.use('/shared', express.static(path.join(pub, 'shared')));
app.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules', 'phaser', 'dist')));
app.use('/vendor/flag-icons', express.static(path.join(ROOT, 'node_modules', 'flag-icons')));
app.get('/health', (req, res) => res.json({ ok: true, phase: game.phase, round: game.round.number }));
// Sonidos propios opcionales en public/assets/sounds (hit.mp3, gift.mp3, win.mp3…).
app.get('/api/sounds', (req, res) => {
  fs.readdir(path.join(pub, 'assets', 'sounds'), (err, files) => {
    res.json(err ? [] : files.filter((f) => /^[\w-]+\.mp3$/i.test(f)));
  });
});

const server = http.createServer(app);

function allowedOrigin(origin) {
  if (!origin) return true; // clientes sin navegador (pruebas)
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const io = new Server(server, {
  serveClient: true,
  // Un WebSocket no respeta CORS: se revisa el Origin a mano para que ninguna web externa
  // abierta en tu navegador pueda controlar el panel.
  allowRequest: (req, cb) => cb(null, allowedOrigin(req.headers.origin)),
});

const gameNs = io.of('/game');
const adminNs = io.of('/admin');

function initPayload() {
  return {
    teams: config.teams.map(({ code, country, dish, image, color }) => ({ code, country, dish, image, color })),
    flightMs: FLIGHT_MS,
    display: config.display,
    sound: config.sound,
    likesPerProjectile: config.likes.likesPerProjectile,
    gifts: {
      bigMinCoins: config.gifts.bigMinCoins,
      chiliMinCoins: config.gifts.chiliMinCoins,
      potMinCoins: config.gifts.potMinCoins,
    },
  };
}

gameNs.on('connection', (socket) => {
  log.info(`Pantalla de juego conectada (${gameNs.sockets.size} abierta/s)`);
  socket.emit('init', initPayload());
  socket.emit('state', game.snapshot());
  socket.on('perf', (p) => {
    if (p && Number.isFinite(p.fps)) {
      lastPerf = { fps: Math.round(p.fps), projectiles: Number(p.projectiles) || 0, at: Date.now() };
    }
  });
  socket.on('disconnect', () => log.info('Pantalla de juego desconectada'));
});

function adminState() {
  return {
    tiktok: tiktok.status,
    sim: sim.status,
    game: game.snapshot(),
    allTime: game.topAllTime(10),
    countryWins: store.data.countryWins,
    roundsPlayed: store.data.roundsPlayed,
    eventsPerSec,
    recent,
    perf: lastPerf && Date.now() - lastPerf.at < 5000 ? lastPerf : null,
    screens: gameNs.sockets.size,
    settings: editableView(config),
    teams: initPayload().teams,
  };
}

// Envuelve un manejador de comando del panel con respuesta { ok, error }.
function command(socket, name, fn) {
  socket.on(name, async (args, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const result = await fn(args || {});
      reply({ ok: true, result });
      socket.emit('admin:state', adminState());
    } catch (err) {
      log.warn(`Comando ${name} falló: ${err.message}`);
      reply({ ok: false, error: err.message });
    }
  });
}

adminNs.on('connection', (socket) => {
  log.info('Panel de administración conectado');
  socket.emit('admin:state', adminState());

  command(socket, 'tiktok:connect', async ({ username }) => {
    const user = await tiktok.connect(username);
    if (config.tiktok.username !== user) {
      config.tiktok.username = user;
      saveConfig(config);
    }
    return user;
  });
  command(socket, 'tiktok:disconnect', () => tiktok.disconnect());

  command(socket, 'sim:join', ({ team, count = 1 }) => {
    const n = Math.max(1, Math.min(100, Number(count) || 1));
    for (let i = 0; i < n; i++) sim.joinPlayer(team);
    return n;
  });
  command(socket, 'sim:likes', ({ team, count = 20 }) => sim.likes(Number(count) || 20, team || null).name);
  command(socket, 'sim:gift', ({ tier, team, streak }) => sim.gift(tier, { teamCode: team || null, streak: Number(streak) || 5 }).name);
  command(socket, 'sim:follow', ({ team }) => sim.follow(team || null).name);
  command(socket, 'sim:share', ({ team }) => sim.share(team || null).name);
  command(socket, 'sim:comment', ({ text }) => sim.comment(text).name);
  command(socket, 'sim:load:start', ({ count = 200 }) => sim.startLoad(Number(count) || 200));
  command(socket, 'sim:load:stop', () => sim.stopLoad());

  command(socket, 'round:start', () => {
    if (game.phase === 'paused') return game.resumeRound();
    if (game.phase === 'running') throw new Error('La ronda ya está en curso');
    return game.startRound();
  });
  command(socket, 'round:pause', () => {
    if (!game.pauseRound()) throw new Error('No hay una ronda en curso');
  });
  command(socket, 'round:resume', () => {
    if (!game.resumeRound()) throw new Error('La ronda no está en pausa');
  });
  command(socket, 'round:restart', () => game.restartRound());
  command(socket, 'stats:reset', () => {
    game.resetRanking();
    store.saveNow();
  });

  command(socket, 'config:update', ({ patch }) => {
    const res = applyPatch(config, patch);
    if (!res.ok) throw new Error(res.errors.join(' · '));
    config = res.config;
    saveConfig(config);
    game.applyConfig(config);
    sim.setConfig(config);
    tiktok.setConfig(config);
    gameNs.emit('init', initPayload());
    log.info(`Ajustes guardados: ${Object.keys(patch).join(', ')}`);
    return editableView(config);
  });
});

tiktok.on('status', () => adminNs.emit('admin:state', adminState()));

// ───────────────────────── bucle ─────────────────────────

let tickCount = 0;
let lastStateJson = '';

const loop = setInterval(() => {
  tickCount += 1;
  try {
    game.tick();
  } catch (err) {
    log.error(`Error en tick: ${err.stack || err.message}`);
  }

  // Efectos a 10 Hz
  if (tickCount % 2 === 0) {
    const fx = game.drainFx();
    if (fx.length) gameNs.emit('fx', fx);
  }
  // Estado a 4 Hz, solo si cambió
  if (tickCount % 5 === 0) {
    const snap = game.snapshot();
    const json = JSON.stringify({ ...snap, remainingMs: Math.ceil(snap.remainingMs / 1000), restartInMs: Math.ceil(snap.restartInMs / 1000) });
    if (json !== lastStateJson) {
      lastStateJson = json;
      gameNs.emit('state', snap);
    }
  }
  // Panel a 1 Hz
  if (tickCount % 20 === 0) {
    eventsPerSec = eventsThisSecond;
    eventsThisSecond = 0;
    if (adminNs.sockets.size) adminNs.emit('admin:state', adminState());
  }
}, 50);

// ───────────────────────── arranque y cierre ─────────────────────────

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(portBusyMessage(config.server.port));
  } else {
    log.error(`Error del servidor: ${err.message}`);
  }
  process.exit(1);
});

// ¿Ya hay otro programa en este puerto? En Windows otro servidor puede estar en [::]:3000 y
// aun así dejarnos abrir 127.0.0.1:3000; el navegador abriría "localhost" en el OTRO programa.
function portInUse(port) {
  const probe = (host) => new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (used) => { sock.destroy(); resolve(used); };
    sock.setTimeout(700, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([v4, v6]) => v4 || v6);
}

function portBusyMessage(port) {
  return `El puerto ${port} ya lo está usando otro programa (¿otra ventana con "npm start" u otro proyecto?).\n`
    + `  Ciérralo, o arranca en otro puerto:  $env:PORT=${port + 1}; npm start\n`
    + '  (o cambia "server.port" en config.json)';
}

portInUse(config.server.port).then((busy) => {
  if (busy) {
    log.error(portBusyMessage(config.server.port));
    process.exit(1);
  }
  server.listen(config.server.port, HOST, onListening);
});

function onListening() {
  const base = `http://localhost:${config.server.port}`;
  log.info('──────────────────────────────────────────────');
  log.info(' Batalla de Comida en marcha (solo en esta PC)');
  log.info(` Juego:  ${base}/game`);
  log.info(` Panel:  ${base}/admin`);
  log.info(` Firma Euler Stream: ${process.env.SIGN_API_KEY ? 'con SIGN_API_KEY' : 'sin clave (límite gratuito)'}`);
  log.info('──────────────────────────────────────────────');
  if (config.round.autoStart) game.startRound();
  else log.info('autoStart = false: inicia la ronda desde el panel.');
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info(`Cerrando (${signal})…`);
  clearInterval(loop);
  store.saveNow();
  sim.stop();
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  try {
    await tiktok.stop();
  } catch { /* nada */ }
  io.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('Ctrl+Break'));
process.on('unhandledRejection', (err) => log.error(`Promesa sin manejar: ${(err && err.stack) || err}`));
process.on('uncaughtException', (err) => log.error(`Excepción sin manejar: ${err.stack || err.message}`));
