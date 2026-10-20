// Utilidades de DOM. Todo texto que viene del chat se inserta con textContent (nunca innerHTML).

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function flag(code) {
  const span = el('span', `fi fi-${String(code || '').replace(/[^a-z]/g, '')}`);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function hashHue(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

function initials(name) {
  const parts = String(name || '?').replace(/[_\d]+/g, ' ').trim().split(/\s+/);
  const first = Array.from(parts[0] || '?')[0] || '?';
  const second = parts[1] ? Array.from(parts[1])[0] : '';
  return (first + second).toUpperCase();
}

/** Foto de perfil; si no hay o falla al cargar, círculo de color con iniciales. */
export function avatar(user, className = '') {
  const box = el('span', `avatar ${className}`.trim());
  const name = user && user.name;
  const fallback = () => {
    box.textContent = initials(name);
    box.style.backgroundColor = `hsl(${hashHue(name)} 65% 45%)`;
  };
  if (user && user.avatar) {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { img.remove(); fallback(); };
    img.src = user.avatar;
    box.append(img);
  } else {
    fallback();
  }
  return box;
}

export function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString('es');
}

export function hexToInt(hex) {
  return parseInt(String(hex || '#ffffff').replace('#', ''), 16) || 0xffffff;
}
