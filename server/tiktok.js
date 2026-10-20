'use strict';

// Adaptador de tiktok-live-connector 2.5.0 → eventos normalizados (ver events.js).
//
// Basado en el README y en los tipos de la versión instalada:
//  - new TikTokLiveConnection(usuario, { signApiKey, processInitialData, ... })
//  - connect() rechaza con UserOfflineError, SignatureRateLimitError (retryAfter en ms), etc.
//  - 'disconnected' cuando se cae el WebSocket; la librería NO reconecta sola.
//  - Los mensajes siguen el protobuf v3: chat.content, like.count, gift.gift.diamondCount,
//    gift.repeatEnd (0/1), user.nickname / user.displayId / user.avatarThumb.urlList.
//    El README todavía muestra nombres antiguos (comment, likeCount, giftDetails, uniqueId),
//    así que se leen ambos por si cambian entre versiones.
//
// La librería es ESM; se carga con import() solo cuando hace falta conectar.

const { EventEmitter } = require('node:events');
const { GiftStreakTracker } = require('./gifts');
const { createLogger } = require('./logger');

const log = createLogger('tiktok');

let libPromise = null;
function loadLib() {
  libPromise ??= import('tiktok-live-connector');
  return libPromise;
}

function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '')
    .replace(/\/live\/?$/i, '')
    .replace(/^@/, '')
    .replace(/[^\w.]/g, '');
}

class TikTokSource extends EventEmitter {
  /**
   * @param {object} o
   * @param {(payload: object) => void} o.onEvent
   * @param {object} o.config
   */
  constructor({ onEvent, config }) {
    super();
    this.onEvent = onEvent;
    this.cfg = config;
    this.conn = null;
    this.generation = 0;
    this.attempt = 0;
    this.retryTimer = null;
    this.wanted = false;           // el usuario pidió estar conectado
    this.streamEnded = false;
    this.seen = new Set();
    this.tracker = new GiftStreakTracker({ timeoutMs: config.gifts.streakTimeoutSec * 1000 });
    this.sweepTimer = setInterval(() => {
      for (const g of this.tracker.sweep()) {
        log.warn(`Racha de ${g.giftName} de ${g.user.name} sin cierre; se cuenta con x${g.repeat}`);
        this._emitGift(g);
      }
    }, 1000);
    this.sweepTimer.unref?.();
    this.state = {
      state: 'disconnected',
      username: config.tiktok.username || '',
      reason: '',
      roomId: '',
      attempt: 0,
      nextRetryAt: 0,
      connectedAt: 0,
      lastEventAt: 0,
      viewers: 0,
      events: 0,
      signKey: !!process.env.SIGN_API_KEY,
    };
  }

  setConfig(config) {
    this.cfg = config;
  }

  get status() {
    return { ...this.state, pendingStreaks: this.tracker.pendingCount };
  }

  async connect(username) {
    const user = normalizeUsername(username);
    if (!user) throw new Error('Escribe el usuario de TikTok (sin @).');
    this.wanted = true;
    this.attempt = 0;
    this.streamEnded = false;
    this.state.username = user;
    await this._teardown();
    this._open();
    return user;
  }

  async disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this._teardown();
    this._set('disconnected', { reason: '', nextRetryAt: 0, roomId: '' });
    log.info('Desconectado por el usuario');
  }

  async _teardown() {
    this.generation += 1;            // invalida eventos y promesas de la conexión anterior
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      try {
        await conn.disconnect();
      } catch (err) {
        log.debug(`Error al cerrar la conexión anterior: ${err.message}`);
      }
      conn.removeAllListeners();
    }
  }

  async _open() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const gen = ++this.generation;
    const username = this.state.username;
    this._set(this.attempt === 0 ? 'connecting' : 'reconnecting', { nextRetryAt: 0, attempt: this.attempt });
    log.info(`Conectando a @${username}${this.attempt ? ` (intento ${this.attempt + 1})` : ''}…`);

    let lib;
    try {
      lib = await loadLib();
    } catch (err) {
      this._set('error', { reason: `No se pudo cargar tiktok-live-connector: ${err.message}` });
      log.error(this.state.reason);
      return;
    }
    if (gen !== this.generation) return;

    let conn;
    try {
      conn = new lib.TikTokLiveConnection(username, {
        signApiKey: process.env.SIGN_API_KEY || undefined,
        processInitialData: !!this.cfg.tiktok.processInitialData,
        fetchRoomInfoOnConnect: true,
        enableExtendedGiftInfo: false,
      });
    } catch (err) {
      this._set('error', { reason: `Usuario inválido: ${err.message}` });
      log.error(this.state.reason);
      this.wanted = false;
      return;
    }
    this.conn = conn;
    this._attach(conn, gen, lib);

    try {
      const state = await conn.connect();
      if (gen !== this.generation) {
        conn.disconnect().catch(() => {});
        return;
      }
      this.attempt = 0;
      this.streamEnded = false;
      this._set('connected', { roomId: String(state.roomId || ''), reason: '', connectedAt: Date.now(), attempt: 0 });
      log.info(`Conectado a @${username} (sala ${state.roomId})`);
    } catch (err) {
      if (gen !== this.generation) return;
      this.conn = null;
      conn.removeAllListeners();
      this._onFailure(err, lib);
    }
  }

  _onFailure(err, lib) {
    const rc = this.cfg.tiktok.reconnect;
    const msg = (err && err.message) || String(err);
    let reason;
    let waitMs;
    let state = 'reconnecting';

    if (lib && err instanceof lib.SignatureRateLimitError) {
      waitMs = Math.max(err.retryAfter || 0, rc.rateLimitMinSec * 1000);
      reason = 'El servidor de firma (Euler Stream) limitó las conexiones'
        + (process.env.SIGN_API_KEY ? '' : '. Una SIGN_API_KEY en .env sube el límite');
    } else if (lib && err instanceof lib.UserOfflineError) {
      waitMs = rc.offlineRetrySec * 1000;
      reason = `@${this.state.username} no está en vivo ahora`;
      state = 'offline';
    } else if (lib && err instanceof lib.InvalidUniqueIdError) {
      this.wanted = false;
      this._set('error', { reason: 'Usuario de TikTok inválido' });
      log.error(this.state.reason);
      return;
    } else if (lib && err instanceof lib.SignAPIError) {
      waitMs = this._backoff();
      reason = `Error del servidor de firma: ${msg}`;
    } else if (lib && err instanceof lib.ConnectTimeoutError) {
      waitMs = this._backoff();
      reason = 'Tiempo de espera agotado al conectar';
    } else {
      waitMs = this._backoff();
      reason = msg.includes('room id') || msg.includes('roomId')
        ? `No se encontró la sala de @${this.state.username} (¿el usuario existe y está en vivo?)`
        : `Error al conectar: ${msg}`;
    }
    log.warn(`${reason}. Reintento en ${Math.round(waitMs / 1000)} s`);
    this._scheduleRetry(waitMs, state, reason);
  }

  _backoff() {
    const rc = this.cfg.tiktok.reconnect;
    const base = rc.baseDelaySec * 1000 * 2 ** Math.min(this.attempt, 10);
    const capped = Math.min(rc.maxDelaySec * 1000, base);
    return Math.round(capped * (0.8 + Math.random() * 0.4));
  }

  _scheduleRetry(waitMs, state, reason) {
    if (!this.wanted) return;
    this.attempt += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._open(), waitMs);
    this._set(state, { reason, nextRetryAt: Date.now() + waitMs, attempt: this.attempt });
  }

  _attach(conn, gen, lib) {
    const { WebcastEvent: W, ControlEvent: C } = lib;
    const live = (fn) => (data) => {
      if (gen !== this.generation) return;
      try {
        fn(data);
      } catch (err) {
        log.error(`Error procesando evento de TikTok: ${err.stack || err.message}`);
      }
    };

    conn.on(W.CHAT, live((d) => this._emit('comment', d, { text: d.content ?? d.comment ?? '' })));
    conn.on(W.MEMBER, live((d) => this._emit('join', d)));
    conn.on(W.LIKE, live((d) => this._emit('like', d, { count: d.count ?? d.likeCount ?? 0 })));
    conn.on(W.FOLLOW, live((d) => this._emit('follow', d)));
    conn.on(W.SHARE, live((d) => this._emit('share', d)));
    conn.on(W.GIFT, live((d) => this._onGift(d)));
    conn.on(W.ROOM_USER, live((d) => {
      const v = Number(d.viewerCount ?? d.total ?? 0);
      if (Number.isFinite(v) && v > 0) this.state.viewers = v;
    }));
    conn.on(W.STREAM_END, live(() => {
      this.streamEnded = true;
      log.warn(`El LIVE de @${this.state.username} terminó`);
    }));
    conn.on(C.DISCONNECTED, live(({ code, reason } = {}) => {
      this.conn = null;
      if (!this.wanted) return;
      if (this.streamEnded) {
        log.warn('Se esperará a que vuelva a estar en vivo');
        this._scheduleRetry(this.cfg.tiktok.reconnect.offlineRetrySec * 1000, 'offline', 'El LIVE terminó; esperando a que vuelva');
      } else {
        const waitMs = this._backoff();
        const why = `Se cayó la conexión${code ? ` (código ${code}${reason ? `: ${reason}` : ''})` : ''}`;
        log.warn(`${why}. Reintento en ${Math.round(waitMs / 1000)} s`);
        this._scheduleRetry(waitMs, 'reconnecting', why);
      }
    }));
    conn.on(C.ERROR, (payload = {}) => {
      if (gen !== this.generation) return;
      const ex = payload.exception;
      const text = `${payload.info || 'Error'}: ${(ex && ex.message) || ex || ''}`;
      // Los errores al conectar ya se reportan en _onFailure; aquí solo se registran.
      if (this.state.state === 'connected') log.warn(text);
      else log.debug(text);
    });
  }

  _user(u) {
    if (!u) return null;
    const handle = u.displayId || u.uniqueId || '';
    const id = u.id || u.userId || handle;
    if (!id || id === '0') return null;
    const pic = (img) => (img && Array.isArray(img.urlList) ? img.urlList.find((x) => /^https:/.test(x)) : null);
    const avatar = pic(u.avatarThumb) || pic(u.avatarMedium)
      || (u.profilePicture && (u.profilePicture.url?.[0] || u.profilePicture.urls?.[0])) || null;
    return { id: String(id), name: u.nickname || handle || 'Anónimo', avatar };
  }

  _dedupe(msgId) {
    if (!msgId) return false;
    if (this.seen.has(msgId)) return true;
    this.seen.add(msgId);
    if (this.seen.size > 5000) {
      const it = this.seen.values();
      for (let i = 0; i < 1000; i++) this.seen.delete(it.next().value);
    }
    return false;
  }

  _emit(type, d, data = {}) {
    const user = this._user(d && d.user);
    if (!user) return;
    const msgId = d.common && d.common.msgId;
    if (this._dedupe(msgId)) return;
    this._count();
    this.onEvent({ id: msgId || undefined, type, source: 'tiktok', user, data });
  }

  _onGift(d) {
    const user = this._user(d.user);
    if (!user) return;
    const gift = d.gift || {};
    const details = d.giftDetails || {};
    const ext = d.extendedGiftInfo || {};
    const giftType = gift.type ?? details.giftType ?? ext.type;
    const streakable = giftType === 1 || (giftType === undefined && gift.combo === true);
    const coins = Number(gift.diamondCount ?? details.diamondCount ?? ext.diamond_count ?? 0) || 0;
    const final = this.tracker.push({
      msgId: d.common && d.common.msgId,
      user,
      giftId: String(d.giftId || gift.id || 'gift'),
      giftName: gift.name || details.giftName || ext.name || 'Regalo',
      coins,
      streakable,
      repeatEnd: !!d.repeatEnd,
      repeatCount: d.repeatCount,
      groupId: d.groupId ? String(d.groupId) : '',
    });
    if (final) this._emitGift(final);
  }

  _emitGift(g) {
    this._count();
    log.info(`Regalo: ${g.user.name} → ${g.giftName} x${g.repeat} (${g.coins * g.repeat} monedas)`);
    this.onEvent({
      id: g.msgId || undefined,
      type: 'gift',
      source: 'tiktok',
      user: g.user,
      data: { giftId: g.giftId, giftName: g.giftName, coins: g.coins, repeat: g.repeat },
    });
  }

  _count() {
    this.state.events += 1;
    this.state.lastEventAt = Date.now();
  }

  _set(state, extra = {}) {
    Object.assign(this.state, extra, { state });
    this.emit('status', this.status);
  }

  async stop() {
    clearInterval(this.sweepTimer);
    this.wanted = false;
    clearTimeout(this.retryTimer);
    await this._teardown();
  }
}

module.exports = { TikTokSource, normalizeUsername };
