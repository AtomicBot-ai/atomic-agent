'use strict';
/* ATO-1018: draws the marks main/screen-overlay-window.ts hands over, in
   this window's own coordinates (CSS pixels = screen points). Text goes
   in through textContent only. No input of any kind is read here. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('marks');

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const k of Object.keys(attrs)) node.setAttribute(k, String(attrs[k]));
    (parent || svg).appendChild(node);
    return node;
  }

  /* A text in a pill, kept inside the window. `side` < 0 puts it to the left of x. */
  function pill(x, y, text, side) {
    const g = el('g', {});
    const t = el('text', { class: 'mk-text', x: 0, y: 0, 'dominant-baseline': 'middle' }, g);
    t.textContent = text;
    let w = 0;
    try { w = t.getComputedTextLength(); } catch (e) { w = text.length * 8; }
    const padX = 10, h = 28, bw = w + padX * 2;
    let left = side < 0 ? x - bw : x;
    let top = y - h / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - bw - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
    const r = el('rect', { class: 'mk-pill', x: left, y: top, width: bw, height: h, rx: h / 2 }, g);
    g.insertBefore(r, t);
    t.setAttribute('x', left + padX);
    t.setAttribute('y', top + h / 2 + 1);
  }

  function badge(x, y, n) {
    const cx = Math.max(14, Math.min(x, window.innerWidth - 14));
    const cy = Math.max(14, Math.min(y, window.innerHeight - 14));
    el('circle', { class: 'mk-badge', cx: cx, cy: cy, r: 13 });
    const t = el('text', { class: 'mk-badge-text', x: cx, y: cy + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    t.textContent = String(n);
  }

  function arrow(m) {
    const tx = m.tailX, ty = m.tailY;
    const dx = m.x - tx, dy = m.y - ty;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const head = 18, wing = 10;
    // The line stops at the head's base so its round cap does not poke through the tip.
    const bx = m.x - ux * head, by = m.y - uy * head;
    el('circle', { class: 'mk-pulse', cx: m.x, cy: m.y, r: 22 });
    el('line', { class: 'mk-halo', x1: tx, y1: ty, x2: bx, y2: by, 'stroke-width': 9 });
    el('line', { class: 'mk-line', x1: tx, y1: ty, x2: bx, y2: by, 'stroke-width': 5 });
    const pts = [
      [m.x, m.y],
      [bx - uy * wing, by + ux * wing],
      [bx + uy * wing, by - ux * wing],
    ].map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
    el('polygon', { class: 'mk-head', points: pts });
    if (m.step) badge(tx, ty, m.step);
    if (m.text) pill(tx + (ux > 0 ? -18 : 18), ty, m.text, ux > 0 ? -1 : 1);
  }

  function box(m) {
    el('rect', { class: 'mk-halo', x: m.x, y: m.y, width: m.width, height: m.height, rx: 6, 'stroke-width': 7 });
    el('rect', { class: 'mk-box', x: m.x, y: m.y, width: m.width, height: m.height, rx: 6 });
    if (m.step) badge(m.x, m.y, m.step);
    if (m.text) {
      const below = m.y + m.height + 22 < window.innerHeight;
      pill(m.x, below ? m.y + m.height + 20 : m.y - 20, m.text, 1);
    }
  }

  function label(m) {
    if (m.step) badge(m.x, m.y, m.step);
    pill(m.step ? m.x + 18 : m.x, m.y, m.text || '', 1);
  }

  window.__drawMarks = function (marks) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!Array.isArray(marks)) return;
    for (const m of marks) {
      if (!m || typeof m !== 'object') continue;
      if (m.kind === 'arrow' && typeof m.tailX === 'number') arrow(m);
      else if (m.kind === 'box') box(m);
      else if (m.kind === 'label') label(m);
    }
  };
})();
