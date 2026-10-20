/* global io */
// Panel privado (/admin). Habla con el servidor por Socket.IO (espacio '/admin').
// Todo lo que viene del chat se pinta con textContent.

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function flag(code) {
  const s = el('span', `fi fi-${String(code || '').replace(/[^a-z]/g, '')}`);
  s.setAttribute('aria-hidden', 'true');
  return s;
}
function fmtTime(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
const fmt = (n) => Number(n || 0).toLocaleString('es');

// ───────── conexión y comandos ─────────

const socket = io('/admin', { transports: ['websocket'], reconnectionDelayMax: 3000 });
let state = null;
let stateAt = 0;

socket.on('connect', () => setPill('#pill-server', 'Servidor: conectado', 'ok'));
socket.on('disconnect', () => setPill('#pill-server', 'Servidor: sin conexión', 'bad'));
socket.on('admin:state', (s) => {
  state = s;
  stateAt = performance.now();
  render(s);
});

function cmd(name, args = {}) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: 'El servidor no respondió' });
    }, 8000);
    socket.emit(name, args, (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res || { ok: false, error: 'Sin respuesta' });
    });
  });
}

async function run(name, args, okMsg) {
  const res = await cmd(name, args);
  if (res.ok) {
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(res.result) : okMsg, 'ok');
  } else {
    toast(res.error || 'Error', 'bad');
  }
  return res;
}

let toastTimer = null;
function toast(text, kind = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}

function setPill(sel, text, kind = '') {
  const p = $(sel);
  p.textContent = text;
  p.className = `pill ${kind}`;
}

// ───────── TikTok ─────────

const BADGE = {
  disconnected: 'desconectado',
  connecting: 'conectando…',
  connected: 'conectado',
  reconnecting: 'reconectando…',
  offline: 'sin LIVE',
  error: 'error',
};

$('#tiktok-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#tiktok-user').value.trim();
  if (!username) {
    toast('Escribe el usuario de TikTok', 'bad');
    $('#tiktok-user').focus();
    return;
  }
  await run('tiktok:connect', { username }, (u) => `Conectando a @${u}…`);
});
$('#btn-disconnect').addEventListener('click', () => run('tiktok:disconnect', {}, 'Desconectado de TikTok'));

function renderTikTok(t) {
  const badge = $('#tt-badge');
  badge.textContent = BADGE[t.state] || t.state;
  badge.className = `badge ${t.state}`;
  $('#tt-reason').textContent = t.reason || '';
  const input = $('#tiktok-user');
  if (document.activeElement !== input && !input.value && t.username) input.value = t.username;

  const facts = [];
  if (t.username) facts.push(['Usuario', `@${t.username}`]);
  if (t.state === 'connected') {
    facts.push(['Sala', t.roomId || '—']);
    facts.push(['Espectadores', t.viewers ? fmt(t.viewers) : '—']);
  }
  if (t.nextRetryAt) {
    const secs = Math.max(0, Math.round((t.nextRetryAt - Date.now()) / 1000));
    facts.push(['Próximo intento', `en ${secs} s (intento ${t.attempt + 1})`]);
  }
  facts.push(['Eventos recibidos', fmt(t.events)]);
  if (t.lastEventAt) facts.push(['Último evento', `hace ${Math.max(0, Math.round((Date.now() - t.lastEventAt) / 1000))} s`]);
  facts.push(['Firma Euler Stream', t.signKey ? 'con SIGN_API_KEY' : 'sin clave (límite gratuito)']);
  if (t.pendingStreaks) facts.push(['Rachas en curso', String(t.pendingStreaks)]);
  $('#tt-facts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
}

// ───────── ronda ─────────

const PHASE = { idle: 'esperando inicio', running: 'en curso', paused: 'en pausa', ended: 'terminada' };

document.querySelectorAll('[data-cmd]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.dataset.confirm && !window.confirm(btn.dataset.confirm)) return;
    btn.disabled = true;
    await run(btn.dataset.cmd, {}, '¡Hecho!');
    btn.disabled = false;
  });
});

function renderRound(s) {
  const g = s.game;
  $('#round-num').textContent = g.round > 0 ? `Ronda ${g.round}` : 'Sin ronda';
  $('#round-phase').textContent = PHASE[g.phase] || g.phase;
  $('#btn-start').textContent = g.phase === 'paused' ? '▶ Reanudar' : '▶ Iniciar ronda';

  const bars = $('#team-bars');
  if (bars.children.length !== g.teams.length) {
    bars.replaceChildren(...g.teams.map((t) => {
      const team = s.teams.find((x) => x.code === t.code);
      const box = el('div', 'team-bar');
      box.dataset.code = t.code;
      const lbl = el('div', 'lbl');
      const left = el('span');
      left.append(flag(t.code), el('span', null, team ? team.country : t.code));
      lbl.append(left, el('span', 'hp'));
      const track = el('div', 'track');
      track.append(el('div', 'fill'));
      box.append(lbl, track, el('div', 'players muted'));
      return box;
    }));
  }
  for (const t of g.teams) {
    const box = bars.querySelector(`[data-code="${t.code}"]`);
    if (!box) continue;
    box.querySelector('.hp').textContent = `${fmt(t.hp)} ❤`;
    box.querySelector('.players').textContent = `👥 ${fmt(t.players)} · ${fmt(t.damageDealt)} daño hecho`;
    box.querySelector('.fill').style.transform = `scaleX(${Math.max(0, t.hp / t.maxHp)})`;
    box.classList.toggle('dead', !t.alive);
    box.classList.toggle('shield', t.shieldMs > 0);
  }
}

function tickClock() {
  if (state) {
    const g = state.game;
    let ms = g.remainingMs;
    if (g.phase === 'running') ms -= performance.now() - stateAt;
    if (g.phase === 'ended') ms = g.restartInMs - (performance.now() - stateAt);
    $('#round-time').textContent = fmtTime(ms);
  }
  requestAnimationFrame(tickClock);
}
requestAnimationFrame(tickClock);

// ───────── simulador ─────────

const simTeam = () => $('#sim-team').value || null;

document.querySelectorAll('[data-sim]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.sim;
    const team = simTeam();
    const count = Number(btn.dataset.count) || undefined;
    switch (kind) {
      case 'join': await run('sim:join', { team, count }, (n) => `${n} jugador(es) falso(s) unido(s)`); break;
      case 'likes': await run('sim:likes', { team, count }, (name) => `${count} likes de ${name}`); break;
      case 'gift': await run('sim:gift', { team, tier: btn.dataset.tier, streak: 5 }, (name) => `Regalo de ${name}`); break;
      case 'follow': await run('sim:follow', { team }, (name) => `Follow de ${name}`); break;
      case 'share': await run('sim:share', { team }, (name) => `Share de ${name}`); break;
      default: break;
    }
  });
});

$('#sim-comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#sim-comment');
  const text = input.value.trim();
  if (!text) return;
  await run('sim:comment', { text }, (name) => `${name} comentó "${text}"`);
  input.value = '';
});

$('#btn-load-start').addEventListener('click', () => {
  const count = Number($('#load-count').value) || 200;
  run('sim:load:start', { count }, `Modo carga con ${count} espectadores`);
});
$('#btn-load-stop').addEventListener('click', () => run('sim:load:stop', {}, 'Modo carga detenido'));

function renderSim(s) {
  const select = $('#sim-team');
  if (select.options.length === 1) {
    for (const t of s.teams) select.append(new Option(`${t.country} (${t.code})`, t.code));
  }
  const sim = s.sim;
  $('#load-status').textContent = sim.loadRunning
    ? `● activo con ${fmt(sim.loadUsers)} espectadores · ${fmt(sim.eventsSent)} eventos enviados`
    : `detenido · ${fmt(sim.eventsSent)} eventos enviados en total`;

  const st = s.settings;
  $('#btn-gift-big').textContent = `🎁 Regalo ${st['gifts.bigMinCoins']}–${st['gifts.chiliMinCoins'] - 1} (racha de rosas)`;
  $('#btn-gift-chili').textContent = `🌶️ Regalo ${st['gifts.chiliMinCoins']}–${st['gifts.potMinCoins'] - 1}`;
  $('#btn-gift-pot').textContent = `🍲 Regalo ${st['gifts.potMinCoins']}+`;
}

// ───────── ajustes ─────────

const SETTINGS = [
  ['Ronda', [
    ['round.durationSec', 'Duración (s)', 'number', 1],
    ['round.winnerScreenSec', 'Pantalla de ganador (s)', 'number', 1],
    ['round.maxHp', 'Vida de cada plato', 'number', 10],
    ['round.autoRestart', 'Reinicio automático', 'checkbox'],
  ]],
  ['Likes', [
    ['likes.likesPerProjectile', 'Likes por proyectil', 'number', 1],
    ['likes.damage', 'Daño del proyectil chico', 'number', 1],
    ['likes.maxProjectilesPerSec', 'Tope por usuario (proy./s)', 'number', 0.5],
  ]],
  ['Tramos de regalos (monedas)', [
    ['gifts.bigMinCoins', 'Proyectil grande desde', 'number', 1],
    ['gifts.chiliMinCoins', 'Lluvia de ají desde', 'number', 1],
    ['gifts.potMinCoins', 'Olla gigante desde', 'number', 1],
    ['gifts.alertMinCoins', 'Alerta en pantalla desde', 'number', 1],
  ]],
  ['Daño de regalos', [
    ['gifts.bigDamage', 'Proyectil grande', 'number', 1],
    ['gifts.chiliDamage', 'Lluvia de ají', 'number', 1],
    ['gifts.potDamage', 'Olla (a cada rival)', 'number', 1],
    ['gifts.maxMultiplier', 'Multiplicador máximo', 'number', 0.5],
  ]],
  ['Follow, share y equipos', [
    ['social.follow', 'Follow da', 'select'],
    ['social.share', 'Share da', 'select'],
    ['social.shieldSec', 'Escudo (s)', 'number', 1],
    ['social.healPct', 'Curación (% de vida)', 'number', 1],
    ['join.switchCooldownSec', 'Espera para cambiar de país (s)', 'number', 1],
  ]],
  ['Pantalla y sonido', [
    ['display.maxProjectiles', 'Máx. proyectiles a la vez', 'number', 5],
    ['display.showComments', 'Mostrar comentarios', 'checkbox'],
    ['sound.volume', 'Volumen general', 'range'],
    ['sound.hit', 'Golpes', 'range'],
    ['sound.gift', 'Regalos', 'range'],
    ['sound.win', 'Victoria', 'range'],
  ]],
];
const EFFECTS = [['shield', 'Escudo'], ['heal', 'Curación'], ['none', 'Nada']];

let settingsBuilt = false;
let savedSettings = {};
const inputs = new Map();

function buildSettings(values) {
  const grid = $('#settings-grid');
  for (const [legend, fields] of SETTINGS) {
    const fs = el('fieldset');
    fs.append(el('legend', null, legend));
    for (const [key, label, type, step] of fields) {
      const row = el('label', 'field');
      row.append(el('span', null, label));
      let input;
      if (type === 'select') {
        input = el('select');
        for (const [v, l] of EFFECTS) input.append(new Option(l, v));
      } else {
        input = el('input');
        input.type = type;
        if (type === 'number') input.step = String(step);
        if (type === 'range') Object.assign(input, { min: '0', max: '1', step: '0.05' });
      }
      input.name = key;
      input.addEventListener('input', () => markDirty(input));
      input.addEventListener('change', () => markDirty(input));
      inputs.set(key, input);
      row.append(input);
      fs.append(row);
    }
    grid.append(fs);
  }
  settingsBuilt = true;
  fillSettings(values, true);
}

function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number' || input.type === 'range') return Number(input.value);
  return input.value;
}

function writeInput(input, value) {
  if (input.type === 'checkbox') input.checked = !!value;
  else input.value = String(value);
}

function markDirty(input) {
  input.classList.toggle('dirty', readInput(input) !== savedSettings[input.name]);
}

function fillSettings(values, force = false) {
  savedSettings = { ...values };
  for (const [key, input] of inputs) {
    if (!force && input.classList.contains('dirty')) continue;
    if (document.activeElement === input) continue;
    writeInput(input, values[key]);
    input.classList.remove('dirty', 'invalid');
  }
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  for (const [key, input] of inputs) {
    const v = readInput(input);
    if (v !== savedSettings[key]) patch[key] = v;
  }
  if (!Object.keys(patch).length) {
    toast('No hay cambios que guardar');
    return;
  }
  const res = await run('config:update', { patch }, 'Ajustes guardados en config.json');
  const msg = $('#settings-msg');
  if (res.ok) {
    msg.textContent = '';
    fillSettings(res.result, true);
  } else {
    msg.textContent = res.error;
  }
});

$('#btn-settings-reset').addEventListener('click', () => {
  fillSettings(savedSettings, true);
  $('#settings-msg').textContent = '';
});

// ───────── ranking y eventos ─────────

function renderRanking(s) {
  $('#rounds-played').textContent = `${fmt(s.roundsPlayed)} rondas jugadas (guardado en data/stats.json)`;
  const wins = s.countryWins || {};
  const countries = [...s.teams].sort((a, b) => (wins[b.code] || 0) - (wins[a.code] || 0));
  $('#rank-countries').replaceChildren(...countries.map((t) => {
    const li = el('li');
    li.append(flag(t.code), el('span', null, t.country), el('span', 'val', `· ${wins[t.code] || 0}`));
    return li;
  }));
  const players = s.allTime || [];
  const list = $('#rank-players');
  if (!players.length) {
    list.replaceChildren(el('li', 'muted', 'Aún no hay jugadores'));
    return;
  }
  list.replaceChildren(...players.map((p) => {
    const li = el('li');
    if (p.team) li.append(flag(p.team));
    li.append(el('span', null, p.name), el('span', 'val', `· ${fmt(p.damage)} daño · ${fmt(p.coins)} 🪙 · ${p.mvps} MVP`));
    return li;
  }));
}

const TYPE = { join: 'entró', comment: 'coment.', like: 'likes', gift: 'regalo', follow: 'follow', share: 'share' };

function describe(e) {
  switch (e.type) {
    case 'comment': return `${e.name}: ${e.data.text}`;
    case 'like': return `${e.name} ×${e.data.count}`;
    case 'gift': return `${e.name} → ${e.data.giftName} ×${e.data.repeat} (${fmt(e.data.totalCoins)} monedas)`;
    default: return e.name;
  }
}

let lastEventsKey = '';
function renderEvents(list) {
  const key = list.length ? `${list.length}:${list[list.length - 1].ts}` : '0';
  if (key === lastEventsKey) return;
  lastEventsKey = key;
  $('#events').replaceChildren(...[...list].reverse().map((e) => {
    const li = el('li', `src-${e.source}`);
    const d = new Date(e.ts);
    li.append(
      el('span', 't', d.toLocaleTimeString('es', { hour12: false })),
      el('span', 'type', TYPE[e.type] || e.type),
      el('span', 'txt', describe(e)),
    );
    li.title = e.source === 'tiktok' ? 'TikTok' : 'Simulador';
    return li;
  }));
}

// ───────── render general ─────────

function render(s) {
  setPill('#pill-screens', `Pantallas de juego: ${s.screens}`, s.screens ? 'ok' : 'bad');
  setPill('#pill-perf', s.perf ? `FPS: ${s.perf.fps} · ${s.perf.projectiles} proy.` : 'FPS: —', s.perf ? (s.perf.fps >= 55 ? 'ok' : 'bad') : '');
  setPill('#pill-eps', `Eventos/s: ${fmt(s.eventsPerSec)}`);
  renderTikTok(s.tiktok);
  renderRound(s);
  renderSim(s);
  if (!settingsBuilt) buildSettings(s.settings);
  else fillSettings(s.settings);
  renderRanking(s);
  renderEvents(s.recent || []);
}
