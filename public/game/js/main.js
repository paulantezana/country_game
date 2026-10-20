/* global io */
// Pantalla del juego (/game). Recibe del servidor:
//   'init'  → equipos y ajustes de pantalla/sonido
//   'state' → foto del estado (4 por segundo)
//   'fx'    → lote de efectos (10 por segundo): lanzamientos, golpes, uniones, regalos…
// Añade ?debug a la URL para ver los FPS.

import { createArena } from './arena.js';
import { Hud } from './hud.js';
import { Sound } from './sound.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const stage = document.getElementById('stage');
const shell = document.getElementById('shell');
const hud = new Hud(shell);
const sound = new Sound();

let arena = null;
let creating = false;
let initData = null;
let teamKey = '';
let lastState = null;

// ───────── escala 1080×1920 a la ventana ─────────

function fit() {
  const s = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
  const x = (window.innerWidth - 1080 * s) / 2;
  const y = (window.innerHeight - 1920 * s) / 2;
  stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
}
window.addEventListener('resize', fit);
fit();

// ───────── sonido ─────────

sound.init();
const hint = document.getElementById('sound-hint');
function unlock() {
  sound.resume().then(() => { hint.hidden = !sound.suspended; });
}
hint.addEventListener('click', unlock);
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);
setTimeout(() => { hint.hidden = !sound.suspended; }, 800);

// ───────── conexión ─────────

const offline = document.getElementById('offline');
const socket = io('/game', { transports: ['websocket'], reconnectionDelayMax: 3000 });

socket.on('connect', () => { offline.hidden = true; });
socket.on('disconnect', () => {
  offline.textContent = 'Sin conexión con el servidor… reintentando';
  offline.hidden = false;
});

socket.on('init', async (data) => {
  const key = data.teams.map((t) => `${t.code}:${t.image}`).join('|');
  if (teamKey && key !== teamKey) {
    location.reload(); // cambiaron los equipos en config.json
    return;
  }
  initData = data;
  sound.setVolumes(data.sound);
  if (arena || creating) return;
  creating = true;
  teamKey = key;
  hud.build(data.teams);
  arena = await createArena({
    parent: document.getElementById('arena'),
    teams: data.teams,
    maxProjectiles: () => initData.display.maxProjectiles,
    onImpact: (kind, big) => {
      sound.play(kind);
      if (kind === 'pot') hud.shake(2);
      else if (big) hud.shake(1);
    },
  });
  if (lastState) applyState(lastState);
  if (DEBUG) window.__bdc = { arena, hud, sound, fxStats };
});

socket.on('state', (s) => {
  lastState = s;
  applyState(s);
});

function applyState(s) {
  hud.setState(s);
  if (!arena) return;
  for (const t of s.teams) {
    arena.setAlive(t.code, t.alive);
    if (t.shieldMs > 0) arena.setShield(t.code, t.shieldMs);
  }
}

const fxStats = { batches: 0, items: 0, ms: 0, maxMs: 0 };

socket.on('fx', (list) => {
  const t0 = performance.now();
  for (const fx of list) {
    try {
      handleFx(fx);
    } catch (err) {
      console.error('Error en efecto', fx, err);
    }
  }
  if (DEBUG) {
    const dt = performance.now() - t0;
    fxStats.batches += 1;
    fxStats.items += list.length;
    fxStats.ms += dt;
    fxStats.maxMs = Math.max(fxStats.maxMs, dt);
  }
});

const teamName = (code) => initData?.teams.find((t) => t.code === code)?.country || code;

function handleFx(fx) {
  switch (fx.kind) {
    case 'launch':
      arena?.launch(fx);
      break;
    case 'hit':
      if (fx.blocked) arena?.showNumber(fx.to, 0, 'blocked');
      else if (fx.damage > 0) arena?.showNumber(fx.to, fx.damage);
      arena?.hitUndrawn(fx);
      hud.setHp(fx.to, fx.hp);
      break;
    case 'eliminated':
      arena?.setAlive(fx.team, false);
      hud.setAlive(fx.team, false);
      hud.chip('gift', ['💀', { flag: fx.team }, `¡${teamName(fx.team)} eliminado!`]);
      sound.play('bigHit', 1.3);
      hud.shake(1);
      break;
    case 'shield':
      arena?.setShield(fx.team, fx.ms);
      hud.chip('join', ['🛡️', `${fx.user.name} protegió a`, { flag: fx.team }]);
      break;
    case 'heal':
      if (fx.amount > 0) arena?.showNumber(fx.team, fx.amount, 'heal');
      hud.setHp(fx.team, fx.hp);
      hud.chip('join', ['💚', `${fx.user.name} curó a`, { flag: fx.team }]);
      break;
    case 'gift':
      sound.play('gift');
      if (fx.big) hud.alert(fx);
      else hud.chip('gift', ['🎁', `${fx.user.name}: ${fx.giftName} ×${fx.repeat}`, ...(fx.team ? [{ flag: fx.team }] : [])]);
      break;
    case 'join':
      sound.play('join');
      if (fx.auto) hud.chip('join', [{ flag: fx.team }, `${fx.user.name} juega por ${teamName(fx.team)}`]);
      else if (fx.from) hud.chip('join', [`${fx.user.name} cambió a`, { flag: fx.team }]);
      else hud.chip('join', [{ flag: fx.team }, `${fx.user.name} se unió`]);
      break;
    case 'comment':
      hud.chip('comment', [...(fx.team ? [{ flag: fx.team }] : []), `${fx.user.name}: ${fx.text}`]);
      break;
    case 'roundStart':
      arena?.resetRound();
      hud.roundStart(fx.round);
      break;
    case 'roundEnd':
      sound.play('win');
      hud.showWinner(fx);
      break;
    default:
      break;
  }
}

// ───────── bucle de interfaz y rendimiento ─────────

const debugBox = document.getElementById('debug');
debugBox.hidden = !DEBUG;

function frame() {
  hud.tickTimer();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

setInterval(() => {
  if (!arena) return;
  const fps = arena.fps;
  socket.emit('perf', { fps, projectiles: arena.activeCount });
  if (DEBUG) debugBox.textContent = `${fps.toFixed(0)} fps · ${arena.activeCount} proyectiles`;
}, 2000);
