// Sonidos con ganchos: play('hit' | 'bigHit' | 'gift' | 'pot' | 'win' | 'join').
// Si existe /assets/sounds/<nombre>.mp3 (hit.mp3, gift.mp3, win.mp3…) se usa ese archivo;
// si no, se genera con Web Audio. El volumen viene de config.json (sección "sound").

const FILES = ['hit', 'bigHit', 'gift', 'pot', 'win', 'join'];
// Qué volumen de config usa cada sonido.
const GROUP = { hit: 'hit', bigHit: 'hit', gift: 'gift', pot: 'gift', win: 'win', join: 'gift' };
// Tiempo mínimo entre repeticiones (evita una cacofonía en el modo carga).
const MIN_GAP_MS = { hit: 70, bigHit: 120, gift: 150, pot: 400, win: 1000, join: 120 };

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = {};
    this.last = {};
    this.volumes = { volume: 0.6, hit: 0.5, gift: 0.8, win: 1 };
    this.noise = null;
  }

  setVolumes(v) {
    if (v) Object.assign(this.volumes, v);
    if (this.master) this.master.gain.value = this.volumes.volume;
  }

  /** Crea el AudioContext. Los navegadores lo dejan "suspendido" hasta que haya un clic. */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volumes.volume;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    this._loadFiles();
  }

  get suspended() {
    return !this.ctx || this.ctx.state !== 'running';
  }

  resume() {
    this.init();
    return this.ctx ? this.ctx.resume() : Promise.resolve();
  }

  async _loadFiles() {
    let available = [];
    try {
      available = await (await fetch('/api/sounds', { cache: 'no-cache' })).json();
    } catch {
      return;
    }
    await Promise.all(FILES.filter((n) => available.includes(`${n}.mp3`)).map(async (name) => {
      try {
        const res = await fetch(`/assets/sounds/${name}.mp3`, { cache: 'no-cache' });
        if (!res.ok) return;
        const data = await res.arrayBuffer();
        this.buffers[name] = await this.ctx.decodeAudioData(data);
        console.info(`[sonido] usando archivo ${name}.mp3`);
      } catch {
        /* sin archivo: se usa el sonido generado */
      }
    }));
  }

  play(name, intensity = 1) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = performance.now();
    if (now - (this.last[name] || 0) < (MIN_GAP_MS[name] || 60)) return;
    this.last[name] = now;

    const vol = (this.volumes[GROUP[name]] ?? 1) * Math.min(1.5, Math.max(0.2, intensity));
    if (vol <= 0) return;
    const out = this.ctx.createGain();
    out.gain.value = vol;
    out.connect(this.master);

    if (this.buffers[name]) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers[name];
      src.connect(out);
      src.start();
      return;
    }
    const t = this.ctx.currentTime;
    switch (name) {
      case 'hit': this._splat(out, t, 0.18, 900); this._thump(out, t, 140, 0.12, 0.5); break;
      case 'bigHit': this._splat(out, t, 0.3, 600); this._thump(out, t, 90, 0.25, 0.9); break;
      case 'pot': this._thump(out, t, 55, 0.7, 1); this._splat(out, t + 0.05, 0.7, 400); break;
      case 'gift': this._arp(out, t, [660, 880, 1320], 0.07, 'triangle', 0.35); break;
      case 'join': this._arp(out, t, [523, 784], 0.05, 'sine', 0.2); break;
      case 'win': this._fanfare(out, t); break;
      default: break;
    }
  }

  _noiseBuffer() {
    if (this.noise) return this.noise;
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  // Salpicadura: ruido filtrado que cae rápido.
  _splat(out, t, dur, freq) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq * 2, t);
    filter.frequency.exponentialRampToValueAtTime(freq / 3, t + dur);
    filter.Q.value = 1.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(out);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  // Golpe grave.
  _thump(out, t, freq, dur, level) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2.2, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  _arp(out, t, notes, step, type, level) {
    notes.forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      const st = t + i * step;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(level, st + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, st + 0.3);
      osc.connect(g).connect(out);
      osc.start(st);
      osc.stop(st + 0.32);
    });
  }

  _fanfare(out, t) {
    const seq = [[523, 0], [659, 0.14], [784, 0.28], [1047, 0.42], [784, 0.62], [1047, 0.76]];
    for (const [f, d] of seq) {
      for (const detune of [-6, 6]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = detune;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2400;
        const g = this.ctx.createGain();
        const st = t + d;
        const len = d >= 0.76 ? 0.9 : 0.2;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(0.18, st + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, st + len);
        osc.connect(filter).connect(g).connect(out);
        osc.start(st);
        osc.stop(st + len + 0.05);
      }
    }
  }
}
