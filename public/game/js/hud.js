// Interfaz HTML sobre el canvas: cabecera, vida de cada plato, contador, rankings,
// cinta de eventos, alertas de regalos y pantalla de ganador.

import { el, flag, avatar, formatTime, formatNumber } from './util.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const TIER_LABEL = {
  big: '💥 ¡PROYECTIL GRANDE!',
  chili: '🌶️ ¡LLUVIA DE AJÍ!',
  pot: '🍲 ¡OLLA GIGANTE!',
};
const MAX_CHIPS = 4;
const MAX_ALERT_QUEUE = 6;

export class Hud {
  constructor(root) {
    this.root = root;
    this.$ = (sel) => root.querySelector(sel);
    this.teams = new Map();
    this.cells = new Map();
    this.timer = { remainingMs: 0, at: 0, running: false };
    this.lastTimerText = '';
    this.lists = { countries: '', players: '' };
    this.avatarCache = new Map();
    this.chipQueue = [];
    this.chipBusy = false;
    this.alertQueue = [];
    this.alertBusy = false;
    this.phase = null;
    this.winnerShownFor = 0;
    this.bannerTimer = null;
  }

  build(teams) {
    this.teams = new Map(teams.map((t) => [t.code, t]));

    const codes = this.$('#join-codes');
    codes.replaceChildren(...teams.map((t) => {
      const li = el('li');
      li.title = `${t.country} · ${t.dish}`;
      li.append(flag(t.code), el('b', null, t.code.toUpperCase()));
      return li;
    }));

    const cells = this.$('#cells');
    this.cells.clear();
    cells.replaceChildren(...teams.map((t) => {
      const cell = el('div', 'cell');
      const label = el('div', 'cell-label');
      label.append(flag(t.code), el('span', 'name', t.country.toUpperCase()));
      const count = el('div', 'count', '👥 0');
      const stamp = el('div', 'stamp', 'ELIMINADO');
      const bar = el('div', 'hpbar');
      const fill = el('div', 'hp-fill');
      const text = el('div', 'hp-text', '');
      bar.append(fill, text);
      cell.append(label, count, stamp, bar);
      this.cells.set(t.code, { cell, fill, text, count, hp: -1, maxHp: 1, players: -1 });
      return cell;
    }));
  }

  // ───────── estado periódico ─────────

  setState(s) {
    this.timer = { remainingMs: s.remainingMs, at: performance.now(), running: s.phase === 'running' };
    this.$('#round-label').textContent = s.round > 0 ? `RONDA ${s.round}` : 'RONDA —';
    this.$('#players-total').textContent = `👥 ${formatNumber(s.totals.players)}`;

    let leader = null;
    if (s.phase === 'running') {
      const alive = s.teams.filter((t) => t.alive);
      const max = Math.max(...alive.map((t) => t.hp));
      const top = alive.filter((t) => t.hp === max);
      if (top.length === 1 && alive.length > 1 && max < top[0].maxHp) leader = top[0].code;
    }
    for (const t of s.teams) {
      this.setHp(t.code, t.hp, t.maxHp);
      const c = this.cells.get(t.code);
      if (!c) continue;
      if (c.players !== t.players) {
        c.players = t.players;
        c.count.textContent = `👥 ${formatNumber(t.players)}`;
      }
      c.cell.classList.toggle('eliminated', !t.alive);
      c.cell.classList.toggle('shielded', t.shieldMs > 0);
      c.cell.classList.toggle('leader', t.code === leader);
    }

    this._renderCountries(s.topCountries);
    this._renderPlayers(s.topPlayers);
    this._phase(s);
    this.tickTimer(); // por si el navegador frena requestAnimationFrame (página en segundo plano)
  }

  setHp(code, hp, maxHp) {
    const c = this.cells.get(code);
    if (!c) return;
    if (maxHp) c.maxHp = maxHp;
    if (c.hp === hp) return;
    c.hp = hp;
    const ratio = Math.max(0, Math.min(1, hp / c.maxHp));
    c.fill.style.transform = `scaleX(${ratio})`;
    c.fill.classList.toggle('mid', ratio <= 0.5 && ratio > 0.25);
    c.fill.classList.toggle('low', ratio <= 0.25);
    c.text.textContent = `${formatNumber(Math.max(0, Math.round(hp)))} ❤`;
  }

  setAlive(code, alive) {
    const c = this.cells.get(code);
    if (c) c.cell.classList.toggle('eliminated', !alive);
  }

  /** Se llama en cada frame: solo toca el DOM cuando cambia el segundo. */
  tickTimer() {
    const t = this.timer;
    const ms = t.running ? t.remainingMs - (performance.now() - t.at) : t.remainingMs;
    const text = formatTime(ms);
    if (text === this.lastTimerText) return;
    this.lastTimerText = text;
    const node = this.$('#timer');
    node.textContent = text;
    node.classList.toggle('warn', t.running && ms <= 30000);
    if (this.phase === 'ended') this._updateWinnerCountdown();
  }

  _renderCountries(list) {
    const key = JSON.stringify(list);
    if (key === this.lists.countries) return;
    this.lists.countries = key;
    const ol = this.$('#top-countries ol');
    ol.replaceChildren(...list.map((c, i) => {
      const t = this.teams.get(c.code);
      const li = el('li');
      li.append(el('span', 'pos', MEDALS[i] || `${i + 1}.`), flag(c.code), el('span', 'name', t ? t.country : c.code),
        el('span', 'val', `${c.wins} 🏆`));
      return li;
    }));
  }

  _renderPlayers(list) {
    const key = JSON.stringify(list);
    if (key === this.lists.players) return;
    this.lists.players = key;
    const ol = this.$('#top-players ol');
    if (!list.length) {
      ol.replaceChildren(el('li', 'empty', '¡Manda likes para atacar!'));
      return;
    }
    ol.replaceChildren(...list.map((p, i) => {
      const li = el('li');
      li.append(el('span', 'pos', `${i + 1}.`), this._cachedAvatar(p), el('span', 'name', p.name));
      if (p.team) li.append(flag(p.team));
      li.append(el('span', 'val', `${formatNumber(p.damage)} 💥`));
      return li;
    }));
  }

  // La lista se redibuja varias veces por segundo: se reutiliza la foto para que no parpadee.
  _cachedAvatar(p) {
    const key = `${p.id}|${p.avatar || ''}`;
    let node = this.avatarCache.get(key);
    if (!node) {
      node = avatar(p);
      this.avatarCache.set(key, node);
      if (this.avatarCache.size > 200) this.avatarCache.delete(this.avatarCache.keys().next().value);
    }
    return node;
  }

  _phase(s) {
    const prev = this.phase;
    this.phase = s.phase;
    const banner = this.$('#center-banner');
    if (s.phase === 'paused') {
      banner.textContent = '⏸ PAUSA';
      banner.hidden = false;
    } else if (s.phase === 'idle') {
      banner.textContent = '¡Comenta tu país!\nLa ronda empieza pronto';
      banner.style.whiteSpace = 'pre-line';
      banner.hidden = false;
    } else if (!this.bannerTimer) {
      banner.hidden = true;
    }

    if (s.phase === 'ended' && s.winner) {
      this.restartAt = performance.now() + s.restartInMs;
      if (prev !== 'ended') this.showWinner(s.winner);
      this._updateWinnerCountdown();
    } else if (prev === 'ended' && s.phase !== 'ended') {
      this.hideWinner();
    }
  }

  roundStart(number) {
    this.hideWinner();
    const banner = this.$('#center-banner');
    banner.textContent = `¡RONDA ${number}!`;
    banner.style.whiteSpace = '';
    banner.hidden = false;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => {
      this.bannerTimer = null;
      if (this.phase === 'running') banner.hidden = true;
    }, 1800);
  }

  // ───────── ganador ─────────

  showWinner(w) {
    const box = this.$('#winner');
    const team = w.team ? this.teams.get(w.team) : null;
    const img = box.querySelector('.winner-dish img');
    const nameEl = box.querySelector('.winner-name');
    const sub = box.querySelector('.winner-sub');
    if (team) {
      img.src = `/assets/dishes/${team.image}`;
      img.hidden = false;
      nameEl.replaceChildren(flag(team.code), el('span', null, `¡GANÓ ${team.country.toUpperCase()}!`));
      sub.textContent = w.reason === 'last'
        ? `¡${team.dish} es el último plato en pie!`
        : `¡${team.dish} terminó con más vida!`;
    } else {
      img.hidden = true;
      nameEl.replaceChildren(el('span', null, '¡EMPATE!'));
      sub.textContent = 'Nadie se llevó la ronda';
    }

    const mvp = box.querySelector('.mvp');
    if (w.mvp) {
      const card = box.querySelector('.mvp-card');
      const info = el('div');
      const name = el('div', 'mvp-name', w.mvp.name);
      const dmg = el('div', 'mvp-dmg', `${formatNumber(w.mvp.damage)} de daño`);
      if (w.mvp.team) dmg.prepend(flag(w.mvp.team), ' ');
      info.append(name, dmg);
      card.replaceChildren(avatar(w.mvp), info);
      mvp.hidden = false;
    } else {
      mvp.hidden = true;
    }

    const top = box.querySelector('.winner-top');
    top.replaceChildren(...(w.top || []).slice(1, 3).map((p, i) => {
      const li = el('li');
      li.append(el('span', 'pos', MEDALS[i + 1]), avatar(p), el('span', 'name', p.name), el('span', 'val', `${formatNumber(p.damage)} 💥`));
      return li;
    }));
    box.hidden = false;
  }

  _updateWinnerCountdown() {
    const left = Math.max(0, Math.ceil((this.restartAt - performance.now()) / 1000));
    this.$('#winner .winner-next').textContent = `Nueva ronda en ${left}…`;
  }

  hideWinner() {
    this.$('#winner').hidden = true;
  }

  // ───────── cinta de eventos ─────────

  chip(kind, parts) {
    this.chipQueue.push({ kind, parts });
    if (this.chipQueue.length > 10) this.chipQueue.splice(0, this.chipQueue.length - 10);
    if (!this.chipBusy) this._nextChip();
  }

  _nextChip() {
    const item = this.chipQueue.shift();
    if (!item) {
      this.chipBusy = false;
      return;
    }
    this.chipBusy = true;
    const node = el('div', `chip ${item.kind}`);
    for (const p of item.parts) {
      if (p && p.flag) node.append(flag(p.flag));
      else node.append(el('span', null, p));
    }
    const ticker = this.$('#ticker');
    ticker.prepend(node);
    while (ticker.children.length > MAX_CHIPS) ticker.lastChild.remove();
    setTimeout(() => this._nextChip(), this.chipQueue.length > 5 ? 120 : 260);
  }

  // ───────── alertas de regalos grandes ─────────

  alert(fx) {
    if (this.alertQueue.length >= MAX_ALERT_QUEUE) {
      // Cola llena: se descarta la alerta más chica que esté esperando.
      let idx = 0;
      this.alertQueue.forEach((a, i) => { if (a.totalCoins < this.alertQueue[idx].totalCoins) idx = i; });
      if (this.alertQueue[idx].totalCoins >= fx.totalCoins) return;
      this.alertQueue.splice(idx, 1);
    }
    this.alertQueue.push(fx);
    if (!this.alertBusy) this._nextAlert();
  }

  _nextAlert() {
    const fx = this.alertQueue.shift();
    if (!fx) {
      this.alertBusy = false;
      return;
    }
    this.alertBusy = true;
    const box = el('div', `alert ${fx.tier || ''}`);
    const info = el('div');
    const gift = el('div', 'alert-gift');
    gift.append(el('span', null, `🎁 ${fx.giftName} ×${fx.repeat}`));
    if (fx.team) gift.append(flag(fx.team));
    info.append(el('div', 'alert-name', fx.user.name), gift);
    if (fx.tier) info.append(el('div', 'alert-tier', TIER_LABEL[fx.tier]));
    box.append(avatar(fx.user), info);
    const host = this.$('#alerts');
    host.replaceChildren(box);
    const showMs = this.alertQueue.length ? 2200 : 3400;
    setTimeout(() => {
      box.classList.add('out');
      setTimeout(() => {
        box.remove();
        this._nextAlert();
      }, 340);
    }, showMs);
  }

  // ───────── temblor ─────────

  shake(level) {
    const target = level >= 2 ? this.root : this.$('#arena-wrap');
    const cls = level >= 2 ? 'shake-2' : 'shake-1';
    if (target.classList.contains(cls)) return;
    target.classList.add(cls);
    target.addEventListener('animationend', () => target.classList.remove(cls), { once: true });
  }
}
