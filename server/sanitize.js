'use strict';

// Limpieza de textos que vienen del chat antes de mostrarlos o guardarlos.
// El navegador además los pinta con textContent, nunca como HTML.

// Caracteres invisibles o que cambian la dirección del texto (se usan para "trollear" overlays).
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-︎﻿ﾠ￰-￻]/g;
// Control (excepto espacios normales, que se colapsan después).
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
// Más de 2 marcas combinantes seguidas = "texto zalgo".
const ZALGO = /(\p{M}{2})\p{M}+/gu;
// Etiquetas HTML sueltas (por si algún cliente futuro olvida escapar).
const ANGLE = /[<>]/g;

function cleanText(value, maxLen = 80) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.normalize('NFC')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(ZALGO, '$1')
    .replace(ANGLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length > maxLen) s = chars.slice(0, Math.max(1, maxLen - 1)).join('') + '…';
  return s;
}

function cleanName(value, maxLen = 20) {
  const s = cleanText(value, maxLen);
  return s || 'Anónimo';
}

function maskBannedWords(text, bannedWords) {
  if (!text || !Array.isArray(bannedWords) || bannedWords.length === 0) return text;
  let out = text;
  for (const word of bannedWords) {
    const w = String(word || '').trim();
    if (!w) continue;
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'giu'), '*'.repeat(Math.min(w.length, 6)));
  }
  return out;
}

// Solo URLs https para fotos de perfil. Cualquier otra cosa se descarta.
function cleanAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function cleanId(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[^\w.@:-]/g, '').slice(0, 64);
}

module.exports = { cleanText, cleanName, cleanAvatarUrl, cleanId, maskBannedWords };
