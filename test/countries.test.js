'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCountryDetector } = require('../server/countries');
const { loadTestConfig } = require('./helpers');

const { detect } = createCountryDetector(loadTestConfig().teams);

test('código del país, sin importar mayúsculas', () => {
  for (const [text, code] of [['pe', 'pe'], ['PE', 'pe'], ['Pe', 'pe'], ['mx', 'mx'], ['CO', 'co'], ['ar', 'ar'],
    ['cl', 'cl'], ['ve', 've'], ['ec', 'ec'], ['bo', 'bo'], ['BR', 'br']]) {
    assert.equal(detect(text), code, text);
  }
});

test('nombre del país con o sin tildes', () => {
  for (const [text, code] of [['Perú', 'pe'], ['peru', 'pe'], ['PERU', 'pe'], ['México', 'mx'], ['mexico', 'mx'],
    ['Colombia', 'co'], ['argentina', 'ar'], ['Chile', 'cl'], ['venezuela', 've'], ['Ecuador', 'ec'],
    ['bolivia', 'bo'], ['Brasil', 'br'], ['brazil', 'br']]) {
    assert.equal(detect(text), code, text);
  }
});

test('comandos con signo: !pe, /mx, #peru', () => {
  assert.equal(detect('!pe'), 'pe');
  assert.equal(detect('!PE'), 'pe');
  assert.equal(detect('/mx'), 'mx');
  assert.equal(detect('#peru'), 'pe');
  assert.equal(detect('!co vamos'), 'co');
});

test('puntuación, emojis y letras repetidas', () => {
  assert.equal(detect('Perú!!!'), 'pe');
  assert.equal(detect('  peru  '), 'pe');
  assert.equal(detect('¡¡Chile!!'), 'cl');
  assert.equal(detect('peruuuu'), 'pe');
  assert.equal(detect('Colombiaaaa 🔥'), 'co');
  assert.equal(detect('pe pe pe'), 'pe');
  assert.equal(detect('peru 🇵🇪'), 'pe');
});

test('bandera emoji', () => {
  assert.equal(detect('🇵🇪'), 'pe');
  assert.equal(detect('🇲🇽🇲🇽'), 'mx');
  assert.equal(detect('vamos 🇦🇷'), 'ar');
  assert.equal(detect('🇺🇸'), null); // país que no juega
});

test('nombre dentro de una frase', () => {
  assert.equal(detect('vamos peru'), 'pe');
  assert.equal(detect('¡Arriba Bolivia!'), 'bo');
  assert.equal(detect('soy de venezuela 😄'), 've');
  assert.equal(detect('los ecuatorianos ganan'), 'ec');
});

test('los códigos cortos dentro de frases NO cuentan (evita falsos positivos)', () => {
  assert.equal(detect('ya pe causa'), null);
  assert.equal(detect('ve a dormir'), null);
  assert.equal(detect('hola como estas'), null);
  assert.equal(detect('jajaja'), null);
});

test('dos países distintos en el mismo mensaje no deciden nada', () => {
  assert.equal(detect('peru vs chile'), null);
  assert.equal(detect('🇵🇪 o 🇨🇱'), null);
  assert.equal(detect('pe cl'), null);
});

test('entradas vacías o raras', () => {
  assert.equal(detect(''), null);
  assert.equal(detect('   '), null);
  assert.equal(detect(null), null);
  assert.equal(detect(undefined), null);
  assert.equal(detect(123), null);
  assert.equal(detect('!'), null);
  assert.equal(detect('!zz'), null);
});
