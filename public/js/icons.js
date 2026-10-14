/* Hand-drawn SVG icon set. No copyrighted artwork is shipped with OpenICQ -
   the flower is an original approximation of the "status flower" idea. */

(function (global) {
  'use strict';

  const PALETTE = {
    online: { petal: '#2fb43a', deep: '#167a1d', core: '#d8f7b0', label: 'Online' },
    ffc: { petal: '#9bd62f', deep: '#5e9612', core: '#f4ffd0', label: 'Free For Chat' },
    away: { petal: '#e8c53a', deep: '#a8860c', core: '#fff4c8', label: 'Away' },
    na: { petal: '#e8922f', deep: '#aa5c08', core: '#ffe4bd', label: 'N/A' },
    occupied: { petal: '#e0582f', deep: '#9e2f0c', core: '#ffd6c6', label: 'Occupied' },
    dnd: { petal: '#cf2020', deep: '#8c0000', core: '#ffd0d0', label: 'Do Not Disturb' },
    invisible: { petal: '#f2f2f2', deep: '#8d8d8d', core: '#ffffff', label: 'Invisible', ghost: true },
    offline: { petal: '#b4b4b4', deep: '#6e6e6e', core: '#eaeaea', label: 'Offline' },
  };

  const STATUS_ORDER = ['online', 'ffc', 'away', 'na', 'occupied', 'dnd', 'invisible', 'offline'];

  function flower(status, size) {
    const c = PALETTE[status] || PALETTE.offline;
    const dash = c.ghost ? ' stroke-dasharray="1.6 1.4"' : '';
    const px = size ? ` width="${size}" height="${size}"` : '';

    return (
      `<svg viewBox="0 0 16 16"${px} role="img" aria-label="${c.label}">` +
      `<g stroke="${c.deep}" stroke-width="0.9"${dash}>` +
      `<path d="M10.2 10.6 Q12.6 12.2 13 15.2" fill="none" stroke="${c.deep}" stroke-width="1.5" stroke-linecap="round"/>` +
      `<ellipse cx="8" cy="4.2" rx="3" ry="3.1" fill="${c.petal}"/>` +
      `<ellipse cx="4.1" cy="8.1" rx="3.1" ry="3" fill="${c.petal}"/>` +
      `<ellipse cx="11.9" cy="8.1" rx="3.1" ry="3" fill="${c.petal}"/>` +
      `<ellipse cx="6.3" cy="11.9" rx="2.8" ry="2.8" fill="${c.petal}"/>` +
      `<circle cx="8" cy="8.2" r="2.2" fill="${c.core}"/>` +
      `</g></svg>`
    );
  }

  const GLYPHS = {
    message:
      '<svg viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" fill="#fffbd0" stroke="#806000"/>' +
      '<path d="M1 3 L8 9 L15 3" fill="none" stroke="#806000"/></svg>',
    'message-new':
      '<svg viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" fill="#ffe14a" stroke="#806000"/>' +
      '<path d="M1 3 L8 9 L15 3" fill="none" stroke="#806000"/>' +
      '<circle cx="13" cy="4" r="3" fill="#d00000" stroke="#600000"/></svg>',
    user:
      '<svg viewBox="0 0 16 16"><circle cx="8" cy="5" r="3.2" fill="#f0c89a" stroke="#6b4a26"/>' +
      '<path d="M2.2 14.5c0-3.4 2.6-5.3 5.8-5.3s5.8 1.9 5.8 5.3z" fill="#4a6ea8" stroke="#243a5e"/></svg>',
    'user-add':
      '<svg viewBox="0 0 16 16"><circle cx="6.3" cy="5" r="3.1" fill="#f0c89a" stroke="#6b4a26"/>' +
      '<path d="M1 14.5c0-3.3 2.4-5.1 5.3-5.1 1.3 0 2.5.4 3.4 1" fill="#4a6ea8" stroke="#243a5e"/>' +
      '<path d="M12.5 8.5v6M9.5 11.5h6" stroke="#006000" stroke-width="2" stroke-linecap="round"/></svg>',
    search:
      '<svg viewBox="0 0 16 16"><circle cx="6.8" cy="6.8" r="4.4" fill="#cfe4ff" stroke="#243a5e"/>' +
      '<path d="M10.2 10.2 L14.5 14.5" stroke="#243a5e" stroke-width="2.2" stroke-linecap="round"/></svg>',
    info:
      '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#2050c0" stroke="#102860"/>' +
      '<rect x="7" y="6.5" width="2" height="5.5" fill="#fff"/><rect x="7" y="3.6" width="2" height="2" fill="#fff"/></svg>',
    key:
      '<svg viewBox="0 0 16 16"><circle cx="5" cy="5.5" r="3.4" fill="none" stroke="#a88000" stroke-width="2"/>' +
      '<path d="M7.2 7.8 L14 14.6M11 11l-1.8 1.8M13 13l-1.6 1.6" stroke="#a88000" stroke-width="2" stroke-linecap="round"/></svg>',
    trash:
      '<svg viewBox="0 0 16 16"><rect x="4" y="4.5" width="8" height="10" fill="#b8b8b8" stroke="#404040"/>' +
      '<rect x="2.5" y="2.5" width="11" height="2" fill="#909090" stroke="#404040"/>' +
      '<path d="M6.5 6.5v6M9.5 6.5v6" stroke="#404040"/></svg>',
    exit:
      '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="7" height="12" fill="#c8a06a" stroke="#5a3c14"/>' +
      '<circle cx="7.3" cy="8" r="0.9" fill="#403000"/>' +
      '<path d="M10 8h5M12.5 5.5 15 8l-2.5 2.5" fill="none" stroke="#008000" stroke-width="1.6" stroke-linecap="round"/></svg>',
    check:
      '<svg viewBox="0 0 16 16"><path d="M2.5 8.5 6.5 12.5 13.5 3.5" fill="none" stroke="#108010" stroke-width="2.6" stroke-linecap="round"/></svg>',
    cross:
      '<svg viewBox="0 0 16 16"><path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" stroke="#b00000" stroke-width="2.6" stroke-linecap="round"/></svg>',
    gear:
      '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="#b0b0b0" stroke="#404040"/>' +
      '<circle cx="8" cy="8" r="2.4" fill="#f0f0f0" stroke="#404040"/>' +
      '<path d="M8 .6v2.4M8 13v2.4M.6 8h2.4M13 8h2.4" stroke="#404040" stroke-width="1.8"/></svg>',
    history:
      '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.6" fill="#fff" stroke="#303030"/>' +
      '<path d="M8 4v4.4l3 1.8" fill="none" stroke="#303030" stroke-width="1.5" stroke-linecap="round"/></svg>',
    room:
      '<svg viewBox="0 0 16 16"><rect x="1" y="2.5" width="11" height="8" fill="#fffbd0" stroke="#806000"/>' +
      '<path d="M3.5 9.5 3 13.5 6.5 10.5" fill="#fffbd0" stroke="#806000"/>' +
      '<path d="M3.5 5h6M3.5 7.2h4" stroke="#806000"/>' +
      '<rect x="8" y="6" width="7" height="5.5" fill="#cfe4ff" stroke="#243a5e"/>' +
      '<path d="M13 10.8 13.6 14 11 12" fill="#cfe4ff" stroke="#243a5e"/></svg>',
    'room-new':
      '<svg viewBox="0 0 16 16"><rect x="1" y="2.5" width="11" height="8" fill="#ffe14a" stroke="#806000"/>' +
      '<path d="M3.5 9.5 3 13.5 6.5 10.5" fill="#ffe14a" stroke="#806000"/>' +
      '<circle cx="12.5" cy="4" r="3.3" fill="#d00000" stroke="#600000"/></svg>',
    mesh:
      '<svg viewBox="0 0 16 16"><path d="M8 11.5V6" stroke="#243a5e" stroke-width="1.6"/>' +
      '<path d="M4.6 5.4a4.8 4.8 0 0 1 6.8 0M2.4 3.2a7.9 7.9 0 0 1 11.2 0" fill="none" stroke="#2fb43a" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="8" cy="7.2" r="1.7" fill="#2fb43a" stroke="#167a1d"/>' +
      '<rect x="5.5" y="11.5" width="5" height="3" fill="#b0b0b0" stroke="#404040"/></svg>',
  };

  function glyph(name) {
    return GLYPHS[name] || GLYPHS.info;
  }

  /** Replace every [data-flower] / [data-glyph] placeholder with its SVG. */
  function hydrate(root) {
    (root || document).querySelectorAll('[data-flower]').forEach((el) => {
      el.innerHTML = flower(el.dataset.flower);
    });
    (root || document).querySelectorAll('[data-glyph]').forEach((el) => {
      el.innerHTML = glyph(el.dataset.glyph);
    });
  }

  function statusLabel(status) {
    return (PALETTE[status] || PALETTE.offline).label;
  }

  global.ICQIcons = { flower, glyph, hydrate, statusLabel, PALETTE, STATUS_ORDER };
})(window);
