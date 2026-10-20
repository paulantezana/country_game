'use strict';

// Formato propio de eventos. El juego SOLO conoce esto, nunca el formato de la librería de TikTok.
//
// {
//   id:     'tt-123' | 'sim-45'      identificador único del evento
//   type:   'join' | 'comment' | 'like' | 'gift' | 'follow' | 'share'
//   source: 'tiktok' | 'sim'
//   ts:     1729400000000            hora de recepción (ms)
//   user:   { id, name, avatar }     avatar = URL https o null
//   data:   comment → { text }
//           like    → { count }                       likes de ESTE evento
//           gift    → { giftId, giftName, coins, repeat, totalCoins }
//           join / follow / share → {}
// }

const { cleanText, cleanName, cleanAvatarUrl, cleanId, maskBannedWords } = require('./sanitize');

const TYPES = new Set(['join', 'comment', 'like', 'gift', 'follow', 'share']);

let seq = 0;

function toPositiveInt(value, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

/**
 * Crea un evento normalizado y saneado. Devuelve null si no es válido.
 * @param {object} p
 * @param {object} [opts] { maxNameLength, maxCommentLength, bannedWords }
 */
function createEvent(p, opts = {}) {
  if (!p || !TYPES.has(p.type)) return null;
  const userId = cleanId(p.user && p.user.id);
  if (!userId) return null;

  const source = p.source === 'tiktok' ? 'tiktok' : 'sim';
  const evt = {
    id: p.id ? `${source}-${cleanId(p.id)}` : `${source}-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    type: p.type,
    source,
    ts: Number.isFinite(p.ts) ? p.ts : Date.now(),
    user: {
      id: userId,
      name: cleanName(p.user.name, opts.maxNameLength || 20),
      avatar: cleanAvatarUrl(p.user.avatar),
    },
    data: {},
  };

  const d = p.data || {};
  switch (p.type) {
    case 'comment': {
      const text = maskBannedWords(cleanText(d.text, opts.maxCommentLength || 80), opts.bannedWords);
      if (!text) return null;
      evt.data = { text };
      break;
    }
    case 'like': {
      const count = toPositiveInt(d.count, 10000);
      if (count === 0) return null;
      evt.data = { count };
      break;
    }
    case 'gift': {
      const coins = toPositiveInt(d.coins, 1000000);
      const repeat = Math.max(1, toPositiveInt(d.repeat, 100000));
      evt.data = {
        giftId: cleanId(d.giftId) || 'gift',
        giftName: cleanText(d.giftName, 30) || 'Regalo',
        coins,
        repeat,
        totalCoins: coins * repeat,
      };
      break;
    }
    default:
      evt.data = {};
  }
  return evt;
}

module.exports = { createEvent, TYPES };
