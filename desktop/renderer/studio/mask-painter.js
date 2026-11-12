/* Studio › Images › Inpaint: paint the mask on the picture itself (ATO-807).

   A dialog over the window: the source picture, a painting layer on top of
   it, a brush, an eraser, a brush size and Clear. "Use mask" turns the layer
   into a black and white PNG the size of the source (white = redraw), the
   same thing a mask file is, and hands it back as a data URL; images.js puts
   it in the mask slot and it goes to Core as `maskImage`.

   The layer is a canvas at the source's own pixel size, shown scaled down:
   a pointer position is mapped back to source pixels (smaskPoint) and the
   brush is sized in screen pixels, so it feels the same at any zoom
   (smaskBrushPx). Globals read when a function runs: esc, ic (renderer.js). */

const SMASK_MIN = 4;
const SMASK_MAX = 160;
const SMASK_DEFAULT = 40;
/* What a painted stroke looks like on screen. The saved mask is white on black. */
const SMASK_TINT = [255, 64, 112];

/** A pointer at (clientX, clientY) over a box `rect` showing a w × h picture → source pixels, clamped. */
function smaskPoint(clientX, clientY, rect, w, h) {
  const rw = rect.width || 1, rh = rect.height || 1;
  const x = ((clientX - rect.left) / rw) * w;
  const y = ((clientY - rect.top) / rh) * h;
  return {x: Math.min(w, Math.max(0, x)), y: Math.min(h, Math.max(0, y))};
}

/** A brush `size` screen pixels wide over a picture `w` pixels wide shown `shownWidth` pixels wide → source pixels. */
function smaskBrushPx(size, shownWidth, w) {
  const s = Math.min(SMASK_MAX, Math.max(SMASK_MIN, Number(size) || SMASK_DEFAULT));
  return Math.max(1, s * (w / (shownWidth || w || 1)));
}

/** One step of the size keys ([ and ]): about 15 % either way, inside the range. */
function smaskStep(size, dir) {
  const s = Number(size) || SMASK_DEFAULT;
  const next = dir > 0 ? Math.ceil(s * 1.15 + 1) : Math.floor(s / 1.15 - 1);
  return Math.min(SMASK_MAX, Math.max(SMASK_MIN, next));
}

/**
 * What Enter does in the dialog, by what has focus: a button does what it
 * says ('button': Cancel cancels, Clear clears), a text field keeps it
 * ('typing'), anywhere else it is "Use mask" ('done').
 */
function smaskEnterAction(target) {
  if (target && typeof target.closest === 'function' && target.closest('button')) return 'button';
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '') && target.type !== 'range') return 'typing';
  return 'done';
}

/** True when any pixel of RGBA `data` is painted (alpha above a hair). */
function smaskAnyPainted(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) return true;
  return false;
}

/** Turn a black and white mask's pixels (RGBA, in place) into the tinted layer: alpha from brightness. */
function smaskMaskToLayer(data) {
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(data[i], data[i + 1], data[i + 2]) * (data[i + 3] / 255);
    data[i] = SMASK_TINT[0]; data[i + 1] = SMASK_TINT[1]; data[i + 2] = SMASK_TINT[2]; data[i + 3] = v;
  }
  return data;
}

/**
 * Open the painter. opts: {src: data URL of the source picture, mask?: data
 * URL of a mask to keep painting on, onDone(dataUrl, w, h), onCancel?()}.
 * Returns a close function. Only one painter is open at a time.
 */
function smaskOpen(opts) {
  if (typeof document === 'undefined') return () => {};
  const prev = document.querySelector('.st-mask-dlg');
  if (prev && prev._close) prev._close(false);

  const st = {tool: 'brush', size: SMASK_DEFAULT, drawing: false, last: null, w: 0, h: 0};
  const wrap = document.createElement('div');
  wrap.className = 'st-mask-dlg';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', 'Paint the mask');
  const A = (v) => 'data-mask="' + v + '"';
  wrap.innerHTML = '<div class="st-mask-box">'
    + '<div class="st-mask-top"><b>Paint what to change</b><span class="st-dim">Painted areas get redrawn, the rest stays.</span><span class="st-sp"></span>'
      + '<button class="iconbtn" ' + A('cancel') + ' title="Cancel (Esc)" aria-label="Cancel">' + ic('x') + '</button></div>'
    + '<div class="st-mask-stage"><div class="st-mask-pic"><img alt="" draggable="false"><canvas></canvas><div class="st-mask-cursor"></div></div>'
      + '<div class="st-mask-wait">Loading the picture…</div></div>'
    + '<div class="st-mask-bar">'
      + '<div class="st-seg"><button ' + A('brush') + ' class="on" aria-pressed="true" title="Brush (B)">' + ic('edit') + 'Brush</button>'
      + '<button ' + A('eraser') + ' aria-pressed="false" title="Eraser (E)">Eraser</button></div>'
      + '<label class="st-slider st-mask-size"><span class="t">Size</span><input type="range" min="' + SMASK_MIN + '" max="' + SMASK_MAX + '" value="' + SMASK_DEFAULT + '" title="Brush size ([ and ])">'
        + '<span class="v mono">' + SMASK_DEFAULT + '</span></label>'
      + '<button class="btn" ' + A('clear') + '>Clear</button>'
      + '<span class="st-sp"></span><span class="st-mask-msg st-dim" role="status"></span>'
      + '<button class="btn" ' + A('cancel') + '>Cancel</button>'
      + '<button class="btn st-mask-done" ' + A('done') + ' disabled>Use mask</button>'
    + '</div></div>';
  document.body.appendChild(wrap);

  const img = wrap.querySelector('.st-mask-pic img');
  const canvas = wrap.querySelector('.st-mask-pic canvas');
  const cursor = wrap.querySelector('.st-mask-cursor');
  const range = wrap.querySelector('.st-mask-size input');
  const sizeVal = wrap.querySelector('.st-mask-size .v');
  const msg = wrap.querySelector('.st-mask-msg');
  const doneBtn = wrap.querySelector('[data-mask="done"]');
  const ctx = canvas.getContext('2d');

  /* The picture and the layer get one exact box, the picture fitted into the stage: no
     object-fit letterboxing, so a pointer over the layer is over the same pixel of the picture. */
  function fit() {
    if (!st.w) return;
    const stage = wrap.querySelector('.st-mask-stage').getBoundingClientRect();
    const k = Math.min(1, (stage.width || st.w) / st.w, (stage.height || st.h) / st.h);
    const pic = wrap.querySelector('.st-mask-pic');
    pic.style.width = Math.max(1, Math.floor(st.w * k)) + 'px';
    pic.style.height = Math.max(1, Math.floor(st.h * k)) + 'px';
  }
  window.addEventListener('resize', fit);

  function close(used) {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', fit);
    wrap.remove();
    if (!used && typeof opts.onCancel === 'function') opts.onCancel();
  }
  wrap._close = close;

  function setTool(t) {
    st.tool = t;
    wrap.querySelectorAll('[data-mask="brush"],[data-mask="eraser"]').forEach((b) => {
      const on = b.dataset.mask === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    cursor.classList.toggle('erase', t === 'eraser');
  }
  function setSize(n) {
    st.size = Math.min(SMASK_MAX, Math.max(SMASK_MIN, Math.round(Number(n) || SMASK_DEFAULT)));
    range.value = String(st.size);
    sizeVal.textContent = String(st.size);
    cursor.style.width = cursor.style.height = st.size + 'px';
  }

  function stroke(from, to) {
    const r = canvas.getBoundingClientRect();
    ctx.save();
    ctx.globalCompositeOperation = st.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = 'rgb(' + SMASK_TINT.join(',') + ')';
    ctx.lineWidth = smaskBrushPx(st.size, r.width, st.w);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    if (from.x === to.x && from.y === to.y) ctx.arc(to.x, to.y, ctx.lineWidth / 2, 0, Math.PI * 2), ctx.fill();
    else { ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); }
    ctx.restore();
  }
  const at = (e) => smaskPoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), st.w, st.h);
  function moveCursor(e) {
    const box = canvas.parentElement.getBoundingClientRect();
    cursor.style.left = (e.clientX - box.left) + 'px';
    cursor.style.top = (e.clientY - box.top) + 'px';
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!st.w || e.button !== 0) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* a pointer the page does not track: paint without capture */ }
    st.drawing = true;
    const p = at(e);
    stroke(p, p);
    st.last = p;
    msg.textContent = '';
  });
  canvas.addEventListener('pointermove', (e) => {
    moveCursor(e);
    if (!st.drawing) return;
    const p = at(e);
    stroke(st.last, p);
    st.last = p;
  });
  const end = () => { st.drawing = false; st.last = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerenter', () => cursor.classList.add('on'));
  canvas.addEventListener('pointerleave', () => cursor.classList.remove('on'));
  range.addEventListener('input', () => setSize(range.value));

  /** The layer as the mask Core takes: white where painted, black elsewhere, the source's size. */
  function exportMask() {
    if (!smaskAnyPainted(ctx.getImageData(0, 0, st.w, st.h).data)) return null;
    const out = document.createElement('canvas');
    out.width = st.w; out.height = st.h;
    const o = out.getContext('2d');
    o.fillStyle = '#000';
    o.fillRect(0, 0, st.w, st.h);
    const white = document.createElement('canvas');
    white.width = st.w; white.height = st.h;
    const t = white.getContext('2d');
    t.drawImage(canvas, 0, 0);
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = '#fff';
    t.fillRect(0, 0, st.w, st.h);
    o.drawImage(white, 0, 0);
    return out.toDataURL('image/png');
  }

  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mask]');
    if (!b) { if (e.target === wrap) close(false); return; }
    switch (b.dataset.mask) {
      case 'brush': case 'eraser': setTool(b.dataset.mask); return;
      case 'clear': if (st.w) ctx.clearRect(0, 0, st.w, st.h); return;
      case 'cancel': close(false); return;
      case 'done': {
        if (!st.w) return;
        const url = exportMask();
        if (!url) { msg.textContent = 'Paint over the part to change first.'; return; }
        close(true);
        opts.onDone(url, st.w, st.h);
      }
    }
  });
  function onKey(e) {
    if (!document.body.contains(wrap)) return;
    const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range';
    const enter = smaskEnterAction(e.target);
    let handled = true;
    if (e.key === 'Escape') close(false);
    // A focused button (Cancel, Clear, a tool) does what it says: the browser clicks it; the page under the dialog never sees the key.
    else if (e.key === 'Enter' && enter === 'button') { handled = false; e.stopImmediatePropagation(); }
    else if (e.key === 'Enter' && enter === 'done') doneBtn.click();
    else if (typing) handled = false;
    else if (e.key === 'b' || e.key === 'B') setTool('brush');
    else if (e.key === 'e' || e.key === 'E') setTool('eraser');
    else if (e.key === '[') setSize(smaskStep(st.size, -1));
    else if (e.key === ']') setSize(smaskStep(st.size, 1));
    else handled = false;
    // The dialog is modal: its keys do not reach the page under it (⌘↵ would start a generation).
    if (handled || (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  window.addEventListener('keydown', onKey, true);

  img.onload = () => {
    st.w = img.naturalWidth; st.h = img.naturalHeight;
    if (!st.w || !st.h) { msg.textContent = 'This picture could not be read.'; return; }
    canvas.width = st.w; canvas.height = st.h;
    fit();
    wrap.querySelector('.st-mask-wait').remove();
    doneBtn.disabled = false;
    if (opts.mask) {
      // Keep painting on the mask made before: its white comes back as the tint.
      const m = new Image();
      m.onload = () => {
        if (m.naturalWidth !== st.w || m.naturalHeight !== st.h) return;
        ctx.drawImage(m, 0, 0);
        const d = ctx.getImageData(0, 0, st.w, st.h);
        smaskMaskToLayer(d.data);
        ctx.putImageData(d, 0, 0);
      };
      m.src = opts.mask;
    }
  };
  img.onerror = () => { const w = wrap.querySelector('.st-mask-wait'); if (w) w.textContent = 'This picture could not be read.'; };
  img.src = opts.src;
  setSize(SMASK_DEFAULT);
  setTool('brush');
  return () => close(false);
}

if (typeof module !== 'undefined') module.exports = {smaskEnterAction, smaskPoint, smaskBrushPx, smaskStep, smaskAnyPainted, smaskMaskToLayer, SMASK_MIN, SMASK_MAX, SMASK_DEFAULT};
