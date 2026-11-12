/* ---------------- ATO-584: the Notes graph in the Memory tab ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/memory-graph.test.mjs).

   Notes already have links (the Links channel, "Expand graph" on a note),
   but only as text. The Notes channel now has List | Graph: notes are dots,
   links are lines, a click on a dot opens that note. Hover names it, the
   wheel zooms at the pointer, a drag pans.

   No library: a small force layout of our own (repulsion between every pair,
   a spring along every link, a pull to the middle), run a few steps a frame
   until it settles, drawn on a 2D canvas in the theme's own colours. Only
   the most linked MEMGRAPH_MAX_NODES notes are drawn, so a big memory stays
   quick. The data is two read-only statements of memory-db.ts
   (graph.nodes, graph.edges) through app:memoryQuery.

   Not here (out of scope for ATO-584): a timeline slider and a share code. */

const MEMGRAPH_MAX_NODES = 300;
const MEMGRAPH_MAX_EDGES = 3000;
const MEMGRAPH = {on: false, loading: false, error: null, state: null, view: null, hover: -1, drag: null,
  canvas: null, raf: 0, dirty: true, autoFit: true, loadedAt: null, seq: 0};

/* ---- pure: data shaping ---- */

function memGraphLabel(id, content) {
  const first = String(content == null ? '' : content).split(/\r?\n/).map((l) => l.trim()).find((l) => l.length) || '';
  return '#' + id + (first ? ' ' + (first.length > 60 ? first.slice(0, 59) + '…' : first) : '');
}

/* Rows of graph.nodes / graph.edges → {nodes, edges}. Nodes keep the most
   linked `max` (the statement already orders them); edges keep the ones
   whose both ends are drawn, once per pair (the strongest), no self loops.
   `prev` (an earlier state) gives a returning note its old place. */
function memGraphShape(nodeRows, edgeRows, max, prev) {
  const cap = Math.max(1, max || MEMGRAPH_MAX_NODES);
  const old = new Map();
  if (prev && prev.nodes) prev.nodes.forEach((n) => old.set(n.id, n));
  const nodes = [];
  const index = new Map();
  for (const r of nodeRows || []) {
    if (!r || typeof r.id !== 'number' || index.has(r.id)) continue;
    if (nodes.length >= cap) break;
    const i = nodes.length;
    const seed = memGraphSeed(i);
    const was = old.get(r.id);
    nodes.push({id: r.id, label: memGraphLabel(r.id, r.content), degree: 0, archived: typeof r.consolidated_into === 'number',
      x: was ? was.x : seed.x, y: was ? was.y : seed.y, vx: 0, vy: 0});
    index.set(r.id, i);
  }
  const edges = [];
  const seen = new Set();
  for (const r of edgeRows || []) {
    if (!r) continue;
    const s = index.get(r.from_id), t = index.get(r.to_id);
    if (s === undefined || t === undefined || s === t) continue;
    const pair = s < t ? s + ':' + t : t + ':' + s;
    if (seen.has(pair)) continue;
    seen.add(pair);
    edges.push({s, t, kind: String(r.kind || ''), w: Number(r.weight) || 0});
    nodes[s].degree++; nodes[t].degree++;
  }
  return {nodes, edges, alpha: old.size ? 0.3 : 1};
}

/* A spread start: a sunflower spiral, the same every time (tests, and no jump on reload). */
function memGraphSeed(i) {
  const r = 12 * Math.sqrt(i + 0.5), a = i * 2.399963229728653;
  return {x: r * Math.cos(a), y: r * Math.sin(a)};
}

function memGraphRadius(degree) { return 3 + Math.min(9, Math.sqrt(Math.max(0, degree)) * 2); }

/* ---- pure: layout ---- */

const MEMGRAPH_FORCE = {repel: 900, spring: 0.04, length: 46, gravity: 0.012, damping: 0.82, maxSpeed: 40, decay: 0.985, minAlpha: 0.004};

/* One step of the layout; returns the new alpha (how much is still moving). */
function memGraphStep(st, f) {
  const p = f || MEMGRAPH_FORCE;
  const n = st.nodes, a = st.alpha;
  if (a < p.minAlpha) return a;
  for (let i = 0; i < n.length; i++) {
    const ni = n[i];
    for (let j = i + 1; j < n.length; j++) {
      const nj = n[j];
      let dx = ni.x - nj.x, dy = ni.y - nj.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = (i - j) * 0.1 || 0.1; dy = 0.1; d2 = dx * dx + dy * dy; } // two dots on one spot get pushed apart
      if (d2 > 250000) continue; // far apart: no push worth computing
      const k = p.repel * a / d2;
      ni.vx += dx * k; ni.vy += dy * k; nj.vx -= dx * k; nj.vy -= dy * k;
    }
  }
  for (const e of st.edges) {
    const s = n[e.s], t = n[e.t];
    const dx = t.x - s.x, dy = t.y - s.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const k = (d - p.length) * p.spring * a / d;
    s.vx += dx * k; s.vy += dy * k; t.vx -= dx * k; t.vy -= dy * k;
  }
  for (const v of n) {
    v.vx -= v.x * p.gravity * a; v.vy -= v.y * p.gravity * a;
    v.vx *= p.damping; v.vy *= p.damping;
    const sp = Math.hypot(v.vx, v.vy);
    if (sp > p.maxSpeed) { v.vx *= p.maxSpeed / sp; v.vy *= p.maxSpeed / sp; }
    v.x += v.vx; v.y += v.vy;
  }
  st.alpha = a * p.decay;
  return st.alpha;
}

/* Run the layout to rest (tests; a frame runs only a few steps). */
function memGraphSettle(st, maxSteps) {
  let i = 0;
  while (i < (maxSteps || 600) && memGraphStep(st) >= MEMGRAPH_FORCE.minAlpha) i++;
  return i;
}

/* ---- pure: view ---- */

/* The view {x, y, k} that fits every node in a w×h box with a margin. */
function memGraphFit(nodes, w, h) {
  if (!nodes.length) return {x: 0, y: 0, k: 1};
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const pad = 32;
  const k = Math.max(0.1, Math.min(3, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0))));
  return {x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k, k};
}
function memGraphToScreen(view, w, h, wx, wy) { return {x: wx * view.k + view.x + w / 2, y: wy * view.k + view.y + h / 2}; }
function memGraphToWorld(view, w, h, sx, sy) { return {x: (sx - w / 2 - view.x) / view.k, y: (sy - h / 2 - view.y) / view.k}; }

/* Zoom by `factor` keeping the world point under (sx, sy) where it is. */
function memGraphZoomAt(view, w, h, sx, sy, factor) {
  const k = Math.max(0.1, Math.min(8, view.k * factor));
  const at = memGraphToWorld(view, w, h, sx, sy);
  return {k, x: sx - w / 2 - at.x * k, y: sy - h / 2 - at.y * k};
}

/* The node under (sx, sy) on screen, or -1: the nearest whose dot (plus a few px) holds the point. */
function memGraphHit(nodes, view, w, h, sx, sy) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const p = memGraphToScreen(view, w, h, nodes[i].x, nodes[i].y);
    const d = Math.hypot(p.x - sx, p.y - sy);
    const r = memGraphRadius(nodes[i].degree) * Math.max(0.6, view.k) + 4;
    if (d <= r && d < bestD) { best = i; bestD = d; }
  }
  return best;
}

/* ---- the tab ---- */

function memGraphOn() { return MEMGRAPH.on && MEM.channel === 'notes' && MEM.mode === 'list'; }

/* The list's own keys (move, open, page): under the graph the list is not on screen, so they do nothing. */
function memGraphListKey(k) { return k === 'j' || k === 'k' || k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter'; }

function memGraphToggleHTML() {
  if (MEM.channel !== 'notes' || MEM.mode !== 'list') return '';
  const b = (v, label) => '<button class="' + (MEMGRAPH.on === v ? 'on' : '') + '" aria-pressed="' + (MEMGRAPH.on === v) + '" data-act="memory:graph:' + (v ? 'on' : 'off') + '">' + label + '</button>';
  return '<div class="tk-seg" role="group" aria-label="Notes view">' + b(false, 'List') + b(true, 'Graph') + '</div>';
}

function memGraphHTML() {
  if (memFlag('links') !== true) {
    return '<div class="tk-notice tk-notice--amber">' + ic('info') + '<span class="grow"><span class="mono">memory.links.enabled=false</span>: the agent makes no links between notes, so there is no graph to draw.</span></div>';
  }
  if (MEMGRAPH.error) return '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(MEMGRAPH.error) + '</span></div>';
  const st = MEMGRAPH.state;
  if (!st) return '<div class="tk-empty"><span class="tk-spin"></span><p>loading…</p></div>';
  if (!st.nodes.length) return '<div class="tk-empty"><span class="tk-ico tk-ico--lg">' + ic('memory') + '</span><h4>No notes yet</h4><p>Notes the agent keeps, and the links between them, show up here.</p></div>';
  const cap = st.nodes.length + ' note' + (st.nodes.length === 1 ? '' : 's') + ' · ' + st.edges.length + ' link' + (st.edges.length === 1 ? '' : 's')
    + (st.nodes.length >= MEMGRAPH_MAX_NODES ? ' · the ' + MEMGRAPH_MAX_NODES + ' most linked' : '');
  return '<div class="sd-memgraph"><canvas id="mem-graph-canvas" aria-label="Graph of notes and their links. Click a dot to open the note."></canvas>'
    + '<div class="sd-memgraph-cap"><span>' + esc(cap) + '</span><span class="grow"></span><span>Scroll to zoom · drag to move · click a dot to open</span>'
    + '<button class="btn btn-g xs" data-act="memory:graph:fit">Fit</button></div></div>';
}

async function memGraphLoad() {
  if (!BR || memFlag('links') !== true) return;
  const seq = ++MEMGRAPH.seq;
  MEMGRAPH.loading = true; MEMGRAPH.error = null;
  try {
    const [nodes, edges] = [await memQ('graph.nodes', [MEMGRAPH_MAX_NODES]), await memQ('graph.edges', [MEMGRAPH_MAX_EDGES])];
    if (seq !== MEMGRAPH.seq) return;
    const fresh = !MEMGRAPH.state;
    MEMGRAPH.state = memGraphShape(nodes, edges, MEMGRAPH_MAX_NODES, MEMGRAPH.state);
    MEMGRAPH.hover = -1;
    if (fresh) { MEMGRAPH.view = null; MEMGRAPH.autoFit = true; } // keeps fitting while it settles, until the operator zooms or pans
    MEMGRAPH.loadedAt = Date.now();
  } catch (err) {
    if (seq !== MEMGRAPH.seq) return;
    MEMGRAPH.error = err && err.message ? err.message : String(err);
  }
  MEMGRAPH.loading = false; MEMGRAPH.dirty = true;
  render();
  memGraphStart();
}

/* memoryAct's hook: `graph:on|off|fit`; a refresh of the tab reads the graph again too. */
function memGraphAct(verb, arg) {
  if (verb === 'refresh' && memGraphOn()) { memGraphLoad(); return false; }
  if (verb !== 'graph') return false;
  if (arg === 'fit') { MEMGRAPH.view = null; MEMGRAPH.autoFit = true; MEMGRAPH.dirty = true; return true; }
  MEMGRAPH.on = arg === 'on' ? true : arg === 'off' ? false : !MEMGRAPH.on;
  render();
  if (MEMGRAPH.on) memGraphLoad();
  return true;
}

function memGraphTheme(el) {
  const cs = getComputedStyle(el);
  const v = (name, dflt) => (cs.getPropertyValue(name) || '').trim() || dflt;
  return {ink: v('--ink', '#222'), ink2: v('--ink-2', '#666'), ink3: v('--ink-3', '#999'), line: v('--line', '#ccc'),
    accent: v('--accent', v('--blue', '#3b6ef5')), paper: v('--paper', v('--bg-raised', '#fff')), font: v('--font-ui', 'system-ui')};
}

function memGraphDraw(c) {
  const st = MEMGRAPH.state;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  if (!MEMGRAPH.view) MEMGRAPH.view = memGraphFit(st.nodes, w, h);
  const view = MEMGRAPH.view, th = memGraphTheme(c);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const hv = MEMGRAPH.hover;
  const near = new Set();
  g.lineWidth = 1;
  for (const e of st.edges) {
    const on = hv >= 0 && (e.s === hv || e.t === hv);
    if (on) { near.add(e.s); near.add(e.t); }
    const a = memGraphToScreen(view, w, h, st.nodes[e.s].x, st.nodes[e.s].y), b = memGraphToScreen(view, w, h, st.nodes[e.t].x, st.nodes[e.t].y);
    g.strokeStyle = on ? th.accent : th.line;
    g.globalAlpha = on ? 0.9 : 0.55;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  g.globalAlpha = 1;
  st.nodes.forEach((n, i) => {
    const p = memGraphToScreen(view, w, h, n.x, n.y);
    const r = memGraphRadius(n.degree) * Math.max(0.6, Math.min(1.6, view.k));
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fillStyle = i === hv || near.has(i) ? th.accent : n.archived ? th.ink3 : th.ink2;
    g.globalAlpha = hv >= 0 && i !== hv && !near.has(i) ? 0.45 : 1;
    g.fill();
  });
  g.globalAlpha = 1;
  if (hv >= 0 && st.nodes[hv]) {
    const n = st.nodes[hv], p = memGraphToScreen(view, w, h, n.x, n.y);
    const text = n.label + (n.archived ? ' (archived)' : '');
    g.font = '500 12px ' + th.font;
    const tw = g.measureText(text).width;
    const bx = Math.max(4, Math.min(w - tw - 16, p.x + 10)), by = Math.max(4, p.y - 30);
    g.fillStyle = th.paper; g.strokeStyle = th.line;
    g.beginPath(); g.rect(bx, by, tw + 12, 22); g.fill(); g.stroke();
    g.fillStyle = th.ink; g.textBaseline = 'middle'; g.fillText(text, bx + 6, by + 11);
  }
}

function memGraphPoint(c, e) { const r = c.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; }

function memGraphBind(c) {
  c.addEventListener('wheel', (e) => {
    if (!MEMGRAPH.view) return;
    e.preventDefault();
    const p = memGraphPoint(c, e);
    MEMGRAPH.autoFit = false;
    MEMGRAPH.view = memGraphZoomAt(MEMGRAPH.view, c.clientWidth, c.clientHeight, p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    MEMGRAPH.dirty = true;
  }, {passive: false});
  c.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !MEMGRAPH.view) return;
    const p = memGraphPoint(c, e);
    MEMGRAPH.drag = {x: p.x, y: p.y, vx: MEMGRAPH.view.x, vy: MEMGRAPH.view.y, moved: false,
      node: memGraphHit(MEMGRAPH.state.nodes, MEMGRAPH.view, c.clientWidth, c.clientHeight, p.x, p.y)};
  });
  c.addEventListener('mousemove', (e) => {
    if (!MEMGRAPH.state || !MEMGRAPH.view) return;
    const p = memGraphPoint(c, e), d = MEMGRAPH.drag;
    if (d) {
      if (Math.hypot(p.x - d.x, p.y - d.y) > 4) d.moved = true;
      if (d.moved && d.node < 0) { MEMGRAPH.autoFit = false; MEMGRAPH.view = {k: MEMGRAPH.view.k, x: d.vx + p.x - d.x, y: d.vy + p.y - d.y}; MEMGRAPH.dirty = true; }
      return;
    }
    const hit = memGraphHit(MEMGRAPH.state.nodes, MEMGRAPH.view, c.clientWidth, c.clientHeight, p.x, p.y);
    if (hit !== MEMGRAPH.hover) { MEMGRAPH.hover = hit; MEMGRAPH.dirty = true; c.style.cursor = hit >= 0 ? 'pointer' : ''; }
  });
  const up = () => {
    const d = MEMGRAPH.drag;
    MEMGRAPH.drag = null;
    if (d && !d.moved && d.node >= 0 && MEMGRAPH.state && MEMGRAPH.state.nodes[d.node]) memOpenNoteById(MEMGRAPH.state.nodes[d.node].id);
  };
  c.addEventListener('mouseup', up);
  c.addEventListener('mouseleave', () => { MEMGRAPH.drag = null; if (MEMGRAPH.hover !== -1) { MEMGRAPH.hover = -1; MEMGRAPH.dirty = true; } });
}

/* A frame loop while the graph is on screen: a pane repaint makes a new
   canvas, which is picked up and bound here; no canvas, no loop. */
function memGraphFrame() {
  MEMGRAPH.raf = 0;
  if (typeof document === 'undefined' || !MEMGRAPH.on) return;
  const c = document.getElementById('mem-graph-canvas');
  if (!c || !MEMGRAPH.state) return;
  if (c !== MEMGRAPH.canvas) { MEMGRAPH.canvas = c; memGraphBind(c); MEMGRAPH.dirty = true; }
  const st = MEMGRAPH.state;
  if (st.alpha >= MEMGRAPH_FORCE.minAlpha) {
    for (let i = 0; i < 3; i++) memGraphStep(st);
    if (!MEMGRAPH.view || MEMGRAPH.autoFit) MEMGRAPH.view = memGraphFit(st.nodes, c.clientWidth, c.clientHeight);
    MEMGRAPH.dirty = true;
  }
  if (MEMGRAPH.dirty) { MEMGRAPH.dirty = false; memGraphDraw(c); }
  MEMGRAPH.raf = requestAnimationFrame(memGraphFrame);
}
function memGraphStart() {
  if (typeof requestAnimationFrame === 'undefined' || MEMGRAPH.raf) return;
  MEMGRAPH.raf = requestAnimationFrame(memGraphFrame);
}

if (typeof window !== 'undefined') {
  // A repaint of the tab (render) makes a new canvas: pick it up on the next frame.
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => { if (MEMGRAPH.on && document.getElementById('mem-graph-canvas')) { MEMGRAPH.dirty = true; memGraphStart(); } })
      .observe(document.documentElement, {childList: true, subtree: true});
  }
  // --smoke: the graph's shape as drawn.
  window.__memGraph = () => ({on: MEMGRAPH.on, nodes: MEMGRAPH.state ? MEMGRAPH.state.nodes.length : 0, edges: MEMGRAPH.state ? MEMGRAPH.state.edges.length : 0,
    alpha: MEMGRAPH.state ? MEMGRAPH.state.alpha : null, error: MEMGRAPH.error, canvas: !!document.getElementById('mem-graph-canvas')});
}

if (typeof module !== 'undefined') {
  module.exports = {MEMGRAPH_MAX_NODES, MEMGRAPH_FORCE, memGraphListKey, memGraphLabel, memGraphShape, memGraphSeed, memGraphRadius, memGraphStep, memGraphSettle,
    memGraphFit, memGraphToScreen, memGraphToWorld, memGraphZoomAt, memGraphHit};
}
