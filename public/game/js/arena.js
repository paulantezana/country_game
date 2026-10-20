/* global Phaser */
// Arena con Phaser 3 + Matter.js. Solo dibuja: el daño real lo decide el servidor.
//
// - Platos: imagen + cuerpo circular estático (los proyectiles rebotan en ellos y en las paredes).
// - Proyectiles chicos/grandes: cuerpos Matter que "persiguen" a su objetivo y llegan más o menos
//   cuando el servidor aplica el golpe. Se reutilizan (pool) y hay un tope simultáneo.
// - Lluvia de ají y olla gigante: sprites con tweens (sin física) para que pesen poco.

import { hexToInt } from './util.js';

export const ARENA_W = 1080;
export const ARENA_H = 1010;
const CELL_W = ARENA_W / 3;
const CELL_H = ARENA_H / 3;
const DISH_SIZE = 200;
const DISH_RADIUS = 80;
const DISH_Y = 165;
const STEP_MS = 1000 / 60;

export function cellCenter(index) {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: col * CELL_W + CELL_W / 2, y: row * CELL_H + DISH_Y };
}

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class ArenaScene extends Phaser.Scene {
  constructor(opts) {
    super('arena');
    this.opts = opts;
  }

  preload() {
    for (const t of this.opts.teams) {
      const url = `/assets/dishes/${t.image}`;
      if (/\.svg$/i.test(t.image)) this.load.svg(`dish-${t.code}`, url, { width: 220, height: 220 });
      else this.load.image(`dish-${t.code}`, url);
    }
    this.load.svg('chili', '/assets/fx/chili.svg', { width: 46, height: 92 });
    this.load.svg('pot', '/assets/fx/pot.svg', { width: 420, height: 336 });
    this.load.on('loaderror', (file) => console.warn('[arena] no se pudo cargar', file.src));
  }

  create() {
    this._makeTextures();
    this.matter.world.setBounds(0, 0, ARENA_W, ARENA_H, 120);
    this.catDish = this.matter.world.nextCategory();
    this.catProj = this.matter.world.nextCategory();

    this.dishes = new Map();
    this.opts.teams.forEach((t, i) => this._addDish(t, i));

    this.projectiles = new Set();
    this.pools = { small: [], big: [] };
    this.chiliPool = [];
    this.chiliActive = 0;
    this.potsActive = 0;
    this.drawn = new Set();
    this.hitQueue = [];
    this.emitters = new Map();
    this.textPool = [];

    this.matter.world.on('collisionstart', (event) => {
      for (const pair of event.pairs) this._onPair(pair.bodyA, pair.bodyB);
    });

    this.opts.onReady(this);
  }

  _makeTextures() {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1).fillCircle(16, 16, 16);
    g.generateTexture('dot', 32, 32).clear();
    g.fillStyle(0x000000, 1).fillCircle(24, 24, 24);
    g.fillStyle(0xffffff, 1).fillCircle(24, 24, 19);
    g.generateTexture('blob', 48, 48).clear();
    g.fillStyle(0x000000, 1).fillCircle(40, 40, 40);
    g.fillStyle(0xffffff, 1).fillCircle(40, 40, 33);
    g.fillStyle(0x000000, 0.18).fillCircle(48, 48, 18);
    g.generateTexture('blobBig', 80, 80).clear();
    g.fillStyle(0xffffff, 0.14).fillCircle(125, 125, 120);
    g.lineStyle(12, 0xffffff, 1).strokeCircle(125, 125, 116);
    g.generateTexture('ring', 250, 250).clear();
    g.destroy();
  }

  _placeholder(t) {
    const key = `ph-${t.code}`;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x000000, 1).fillCircle(110, 110, 100);
    g.fillStyle(hexToInt(t.color), 1).fillCircle(110, 110, 92);
    g.generateTexture(key, 220, 220);
    g.destroy();
    return key;
  }

  _addDish(t, index) {
    const { x, y } = cellCenter(index);
    const key = this.textures.exists(`dish-${t.code}`) ? `dish-${t.code}` : this._placeholder(t);
    const img = this.add.image(x, y, key).setDepth(1);
    const scale = DISH_SIZE / Math.max(img.width, img.height);
    img.setScale(scale);
    const body = this.matter.add.circle(x, y, DISH_RADIUS, {
      isStatic: true,
      restitution: 1,
      label: 'dish',
      collisionFilter: { category: this.catDish },
    });
    body.teamCode = t.code;
    const shield = this.add.image(x, y, 'ring').setDepth(2).setTint(0x4fd8ff).setVisible(false);
    this.dishes.set(t.code, {
      code: t.code,
      x,
      y,
      img,
      body,
      shield,
      baseScale: scale,
      color: hexToInt(t.color),
      alive: true,
      shieldUntil: 0,
      wobbling: false,
      dmgSum: 0,
      dmgTimer: null,
    });
  }

  // ───────── proyectiles ─────────

  get activeCount() {
    return this.projectiles.size + this.chiliActive;
  }

  launch(fx) {
    if (fx.attack === 'chili') return this._chiliRain(fx);
    if (fx.attack === 'pot') return this._potSweep(fx);
    const from = this.dishes.get(fx.from);
    const to = this.dishes.get(fx.targets[0]);
    if (!from || !to) return;
    if (this.activeCount >= this.opts.maxProjectiles()) return; // tope: el daño llega igual

    const kind = fx.attack === 'big' ? 'big' : 'small';
    const sprite = this._acquire(kind);
    const base = Math.atan2(to.y - from.y, to.x - from.x);
    const ang = base + rand(0.35, 0.85) * (Math.random() < 0.5 ? -1 : 1);
    const sx = from.x + Math.cos(ang) * (DISH_RADIUS + (kind === 'big' ? 40 : 26));
    const sy = from.y + Math.sin(ang) * (DISH_RADIUS + (kind === 'big' ? 40 : 26));
    const dist = Math.hypot(to.x - sx, to.y - sy);
    const speed = clamp((dist / (fx.flightMs / STEP_MS)) * 1.25, 6, 34);

    sprite.setPosition(sx, sy);
    sprite.setVelocity(Math.cos(ang) * speed, Math.sin(ang) * speed);
    sprite.setTint(from.color);
    sprite.setAngularVelocity(rand(-0.3, 0.3));
    const now = this.time.now;
    sprite.proj = { id: fx.id, kind, target: to.code, from: from.code, dueAt: now + fx.flightMs, born: now, sprite };
    this.projectiles.add(sprite.proj);
    this.drawn.add(fx.id);
  }

  _acquire(kind) {
    const pool = this.pools[kind];
    let sprite = pool.pop();
    if (!sprite) {
      sprite = this.matter.add.image(0, 0, kind === 'big' ? 'blobBig' : 'blob', null, {
        shape: { type: 'circle', radius: kind === 'big' ? 36 : 21 },
        frictionAir: 0,
        friction: 0,
        restitution: 0.9,
        label: 'proj',
        collisionFilter: { category: this.catProj, mask: 0x0001 | this.catDish },
      });
      sprite.setDepth(3);
    } else {
      this.matter.world.add(sprite.body);
      sprite.setActive(true).setVisible(true);
    }
    return sprite;
  }

  _release(proj) {
    if (!this.projectiles.delete(proj)) return;
    const s = proj.sprite;
    s.proj = null;
    s.setActive(false).setVisible(false);
    s.setVelocity(0, 0);
    this.matter.world.remove(s.body);
    this.pools[proj.kind].push(s);
  }

  _onPair(a, b) {
    const pa = a.gameObject && a.gameObject.proj;
    const pb = b.gameObject && b.gameObject.proj;
    const proj = pa || pb;
    if (!proj || proj.hit) return;
    const other = pa ? b : a;
    // No se quita el cuerpo dentro del evento de colisión: se procesa en update().
    if (other.teamCode && other.teamCode === proj.target) {
      proj.hit = true;
      this.hitQueue.push(proj);
    }
  }

  _impact(proj) {
    const s = proj.sprite;
    const dish = this.dishes.get(proj.target);
    const big = proj.kind === 'big';
    this.splash(s.x, s.y, this.dishes.get(proj.from)?.color ?? 0xffffff, big ? 34 : 14);
    if (dish) this._wobble(dish, big ? 1.18 : 1.08);
    this.opts.onImpact(big ? 'bigHit' : 'hit', big);
    this._release(proj);
  }

  update(time) {
    if (this.hitQueue.length) {
      const q = this.hitQueue;
      this.hitQueue = [];
      for (const p of q) if (this.projectiles.has(p)) this._impact(p);
    }
    for (const p of this.projectiles) {
      const s = p.sprite;
      const to = this.dishes.get(p.target);
      if (!to) { this._release(p); continue; }
      if (time > p.dueAt + 700) { this._impact(p); continue; }
      const dx = to.x - s.x;
      const dy = to.y - s.y;
      const dist = Math.hypot(dx, dy) || 1;
      const stepsLeft = Math.max(4, (p.dueAt - time) / STEP_MS);
      const want = clamp(dist / stepsLeft, 7, 38);
      const k = time - p.born < 180 ? 0.02 : 0.09;
      const v = s.body.velocity;
      s.setVelocity(v.x + ((dx / dist) * want - v.x) * k, v.y + ((dy / dist) * want - v.y) * k);
    }

    for (const d of this.dishes.values()) {
      const on = d.alive && d.shieldUntil > performance.now();
      if (on !== d.shield.visible) d.shield.setVisible(on);
      if (on) {
        d.shield.setAlpha(0.55 + 0.3 * Math.sin(time / 120));
        d.shield.setScale(0.96 + 0.03 * Math.sin(time / 200));
      }
    }
  }

  // ───────── lluvia de ají ─────────

  _chiliRain(fx) {
    const to = this.dishes.get(fx.targets[0]);
    if (!to) return;
    const drops = clamp(Math.round(6 + 2 * (fx.mult || 1)), 6, 16);
    const window = fx.flightMs * 0.6;
    for (let i = 0; i < drops; i++) {
      if (this.chiliActive >= this.opts.maxProjectiles()) break;
      const last = i === drops - 1;
      this.time.delayedCall((i / drops) * window, () => this._dropChili(to, last));
    }
    this.drawn.add(fx.id);
  }

  _dropChili(to, last) {
    let img = this.chiliPool.pop();
    if (!img) img = this.add.image(0, 0, 'chili').setDepth(4);
    const x = to.x + rand(-110, 110);
    const endY = to.y + rand(-50, 30);
    img.setPosition(x, -80).setAngle(rand(-40, 40)).setVisible(true).setActive(true);
    this.chiliActive += 1;
    const dur = rand(480, 650);
    this.tweens.add({
      targets: img,
      y: endY,
      angle: img.angle + rand(-200, 200),
      duration: dur,
      ease: 'Quad.easeIn',
      onComplete: () => {
        this.splash(img.x, img.y, 0xff2a1a, 12);
        img.setVisible(false).setActive(false);
        this.chiliPool.push(img);
        this.chiliActive -= 1;
        this._wobble(to, 1.06);
        this.opts.onImpact(last ? 'bigHit' : 'hit', last);
      },
    });
  }

  // ───────── olla gigante ─────────

  _potSweep(fx) {
    this.drawn.add(fx.id);
    const targets = fx.targets.map((c) => this.dishes.get(c)).filter(Boolean);
    if (this.potsActive >= 2) {
      // Muchas ollas a la vez: solo salpicaduras, para no saturar.
      this.time.delayedCall(fx.flightMs * 0.6, () => targets.forEach((d) => this.splash(d.x, d.y, 0xff7a1a, 20)));
      return;
    }
    this.potsActive += 1;
    const pot = this.add.image(-300, ARENA_H / 2, 'pot').setDepth(6).setScale(1.25);
    const wave = this.add.rectangle(0, 0, ARENA_W, ARENA_H, 0xff8a2a, 0.28).setOrigin(0, 0).setDepth(0.5);
    wave.scaleX = 0.001;
    this.opts.onImpact('pot', true);
    const hitCols = new Set();
    this.tweens.add({
      targets: pot,
      x: ARENA_W + 300,
      duration: fx.flightMs,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        pot.setAngle(Math.sin(pot.x / 60) * 10);
        pot.y = ARENA_H / 2 + Math.sin(pot.x / 90) * 60;
        wave.scaleX = clamp(pot.x / ARENA_W, 0.001, 1);
        for (const d of targets) {
          if (pot.x >= d.x && !hitCols.has(d.code)) {
            hitCols.add(d.code);
            this.splash(d.x, d.y, 0xff7a1a, 30);
            this._wobble(d, 1.22);
          }
        }
      },
      onComplete: () => {
        pot.destroy();
        this.tweens.add({ targets: wave, alpha: 0, duration: 400, onComplete: () => wave.destroy() });
        this.potsActive -= 1;
      },
    });
  }

  // ───────── efectos ─────────

  splash(x, y, color, count) {
    let em = this.emitters.get(color);
    if (!em) {
      em = this.add.particles(0, 0, 'dot', {
        lifespan: { min: 300, max: 750 },
        speed: { min: 120, max: 520 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.62, end: 0 },
        gravityY: 800,
        tint: color,
        emitting: false,
        maxAliveParticles: 260,
      }).setDepth(4);
      this.emitters.set(color, em);
    }
    em.explode(count, x, y);
  }

  _wobble(d, amount) {
    if (d.wobbling) return;
    d.wobbling = true;
    this.tweens.add({
      targets: d.img,
      scale: d.baseScale * amount,
      angle: rand(-8, 8),
      duration: 90,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => {
        d.wobbling = false;
        d.img.setScale(d.baseScale);
        d.img.setAngle(d.alive ? 0 : 14);
      },
    });
  }

  /** Daño (o curación) que confirma el servidor. Se agrupa por plato para no llenar de números. */
  showNumber(code, amount, kind = 'damage') {
    const d = this.dishes.get(code);
    if (!d) return;
    if (kind === 'damage') {
      d.dmgSum += amount;
      if (d.dmgTimer) return;
      d.dmgTimer = this.time.delayedCall(180, () => {
        d.dmgTimer = null;
        const sum = d.dmgSum;
        d.dmgSum = 0;
        if (sum > 0) this._floatText(d, `-${sum}`, '#ff4040', sum >= 100 ? 76 : 56);
      });
    } else if (kind === 'heal') {
      this._floatText(d, `+${amount}`, '#3ddc84', 64);
      this.splash(d.x, d.y, 0x3ddc84, 16);
    } else if (kind === 'blocked') {
      this._floatText(d, 'BLOQUEADO', '#4fd8ff', 40);
    }
  }

  _floatText(d, text, color, size) {
    let t = this.textPool.pop();
    if (!t) {
      t = this.add.text(0, 0, '', {
        fontFamily: '"Segoe UI Black", "Arial Black", Impact, sans-serif',
        fontSize: '56px',
        color: '#fff',
        stroke: '#000',
        strokeThickness: 10,
      }).setOrigin(0.5).setDepth(7);
    }
    t.setStyle({ color, fontSize: `${size}px` }).setText(text);
    t.setPosition(d.x + rand(-30, 30), d.y - 60).setAlpha(1).setScale(0.6).setVisible(true);
    this.tweens.add({ targets: t, scale: 1, duration: 120, ease: 'Back.easeOut' });
    this.tweens.add({
      targets: t,
      y: t.y - 90,
      alpha: 0,
      delay: 380,
      duration: 650,
      onComplete: () => { t.setVisible(false); this.textPool.push(t); },
    });
  }

  /** Golpe confirmado por el servidor de un proyectil que no se dibujó (por el tope). */
  hitUndrawn(fx) {
    if (fx.attack !== 'small' && fx.attack !== 'big') return;
    if (this.drawn.delete(fx.id)) return;
    if (this.drawn.size > 2000) this.drawn.clear();
    const d = this.dishes.get(fx.to);
    if (d) this.splash(d.x + rand(-40, 40), d.y + rand(-40, 40), 0xffffff, 6);
  }

  setShield(code, ms) {
    const d = this.dishes.get(code);
    if (d) d.shieldUntil = performance.now() + ms;
  }

  setAlive(code, alive) {
    const d = this.dishes.get(code);
    if (!d || d.alive === alive) return;
    d.alive = alive;
    if (alive) {
      d.img.clearTint().setAlpha(1).setAngle(0).setScale(d.baseScale);
    } else {
      this.splash(d.x, d.y, 0x888888, 40);
      d.img.setTint(0x555555);
      this.tweens.add({ targets: d.img, alpha: 0.45, angle: 14, duration: 400 });
    }
  }

  resetRound() {
    for (const p of [...this.projectiles]) this._release(p);
    this.drawn.clear();
    for (const d of this.dishes.values()) {
      d.shieldUntil = 0;
      this.setAlive(d.code, true);
    }
  }

  get fps() {
    return this.game.loop.actualFps;
  }
}

/**
 * Crea la arena. Devuelve una promesa con la escena lista.
 * @param {{ parent: HTMLElement, teams: object[], maxProjectiles: () => number, onImpact: Function }} opts
 */
export function createArena(opts) {
  return new Promise((resolve) => {
    const scene = new ArenaScene({ ...opts, onReady: resolve });
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: opts.parent,
      width: ARENA_W,
      height: ARENA_H,
      transparent: true,
      banner: false,
      scale: { mode: Phaser.Scale.NONE },
      fps: { target: 60 },
      render: { antialias: true, powerPreference: 'high-performance' },
      physics: {
        default: 'matter',
        matter: { gravity: { x: 0, y: 0 }, enableSleeping: false, debug: false },
      },
      scene,
    });
    if (new URLSearchParams(location.search).has('debug')) window.__bdcGame = game;
  });
}
