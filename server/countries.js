'use strict';

// Detecta a qué país quiere unirse un espectador a partir de su comentario.
//
// Reglas (de más a menos explícita):
//  1. Comando: "!pe", "/peru", "#mx" → el primer término decide.
//  2. Mensaje que es solo un país: "pe", "PE", "Perú!!", "peru 🇵🇪", "pe pe pe".
//  3. Bandera emoji: "🇵🇪".
//  4. Nombre del país dentro de una frase: "vamos peru", "¡Arriba Bolivia!".
//     Solo si se menciona UN país (en "peru vs chile" no se decide nada).
// Los códigos de 2 letras solo cuentan en 1–3, para que frases como "ya pe causa"
// o "ve a dormir" no cambien a nadie de equipo.

const FLAG_PAIR = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const REGIONAL_A = 0x1f1e6;

function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "peruuuu" → "peru", "chiiile" → "chile"
function collapseRepeats(token) {
  return token.replace(/(.)\1+/g, '$1');
}

function flagsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(FLAG_PAIR)) {
    const [a, b] = Array.from(m[0]);
    const code = String.fromCharCode(97 + a.codePointAt(0) - REGIONAL_A, 97 + b.codePointAt(0) - REGIONAL_A);
    out.push(code);
  }
  return out;
}

function createCountryDetector(teams) {
  const codes = new Map();      // "pe" → "pe"
  const names = new Map();      // "peru" → "pe" (incluye versión sin letras repetidas)
  const multiWord = [];         // [["bandeja paisa", "co"]]

  for (const team of teams) {
    const code = String(team.code).toLowerCase();
    codes.set(code, code);
    const aliases = [team.country, ...(team.aliases || [])];
    for (const alias of aliases) {
      const n = normalize(alias || '');
      if (!n || n === code) continue;
      if (n.includes(' ')) {
        multiWord.push([n, code]);
      } else {
        names.set(n, code);
        names.set(collapseRepeats(n), code);
      }
    }
  }

  function lookupToken(token, allowCode) {
    if (!token) return null;
    if (allowCode && codes.has(token)) return codes.get(token);
    return names.get(token) || names.get(collapseRepeats(token)) || null;
  }

  function detect(text) {
    if (typeof text !== 'string' || !text.trim()) return null;

    const raw = text.trim();
    const flagCodes = flagsIn(raw).filter((c) => codes.has(c));
    const norm = normalize(raw);
    const tokens = norm ? norm.split(' ') : [];

    // 1. Comando explícito
    if (/^[!/#]/.test(raw) && tokens.length > 0) {
      const hit = lookupToken(tokens[0], true);
      if (hit) return hit;
    }

    // 2. El mensaje entero es un país (o el mismo país repetido)
    if (tokens.length > 0 && tokens.length <= 4) {
      const whole = multiWord.find(([n]) => n === norm)?.[1];
      if (whole && flagCodes.every((c) => c === whole)) return whole;
      const each = tokens.map((t) => lookupToken(t, true));
      if (each.every(Boolean) && new Set(each).size === 1 && flagCodes.every((c) => c === each[0])) {
        return each[0];
      }
    }

    // 3 y 4. Banderas y nombres completos dentro de la frase
    const found = new Set(flagCodes);
    for (const t of tokens) {
      const hit = lookupToken(t, false);
      if (hit) found.add(hit);
    }
    if (multiWord.length) {
      const padded = ` ${norm} `;
      for (const [n, code] of multiWord) if (padded.includes(` ${n} `)) found.add(code);
    }
    if (found.size === 1) return [...found][0];
    return null;
  }

  return { detect };
}

module.exports = { createCountryDetector, normalize };
