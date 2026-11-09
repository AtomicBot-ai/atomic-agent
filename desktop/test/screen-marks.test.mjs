import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../out/main/screen-marks.js');

// ATO-1018: the agent's os.screen.point marks, drawn by a click-through overlay.

/* A Retina laptop as the primary display (1512x982 points, whatever its
   pixels) and an external monitor to its LEFT and slightly higher, so its
   points are negative — the arrangement that breaks naive placement. */
const LAPTOP = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } };
const LEFT = { id: 2, bounds: { x: -1920, y: -200, width: 1920, height: 1080 } };
const DISPLAYS = [LAPTOP, LEFT];

test('the frame is checked like the agent checks it: kinds, numbers, sizes, text, steps, count, seconds', () => {
  assert.equal(M.parseScreenMarks(null), null);
  assert.equal(M.parseScreenMarks({ marks: [] }), null);
  const p = M.parseScreenMarks({
    marks: [
      { kind: 'arrow', x: 10, y: 20, text: '  Save \n now ', step: 1 },
      { kind: 'box', x: 1, y: 2, width: 0, height: 5 },          // no size
      { kind: 'circle', x: 1, y: 2 },                           // unknown kind
      { kind: 'label', x: 1, y: 2 },                            // label without text
      { kind: 'arrow', x: 'a', y: 2 },                          // not a number
      { kind: 'arrow', x: 1e9, y: 2 },                          // off every screen
      { kind: 'label', x: 5, y: 6, text: 'x'.repeat(200), step: 1.5 },
    ],
    seconds: 99999,
  });
  assert.deepEqual(p.marks, [
    { kind: 'arrow', x: 10, y: 20, text: 'Save now', step: 1 },
    { kind: 'label', x: 5, y: 6, text: 'x'.repeat(M.MARK_TEXT_MAX) },
  ]);
  assert.equal(p.seconds, M.MAX_SECONDS, 'nothing stays past two minutes');
  assert.equal(M.parseScreenMarks({ marks: [{ kind: 'arrow', x: 1, y: 1 }] }).seconds, M.DEFAULT_SECONDS);
  const many = Array.from({ length: 20 }, () => ({ kind: 'arrow', x: 1, y: 1 }));
  assert.equal(M.parseScreenMarks({ marks: many }).marks.length, M.MAX_MARKS);
});

test('a mark goes to the display it is on, in that window\'s coordinates (negative origins included)', () => {
  const plan = M.planOverlay([
    { kind: 'arrow', x: 700, y: 400 },
    { kind: 'box', x: -1800, y: -150, width: 200, height: 40, step: 2 },
  ], DISPLAYS);
  assert.deepEqual([...plan.keys()].sort(), [1, 2]);
  const laptop = plan.get(1).marks;
  assert.equal(laptop.length, 1);
  assert.equal(laptop[0].x, 700);
  assert.equal(laptop[0].y, 400);
  const left = plan.get(2).marks;
  assert.deepEqual(left, [{ index: 1, kind: 'box', x: 120, y: 50, width: 200, height: 40, step: 2 }]);
});

test('Retina needs no factor: the window is in points, and so are the marks', () => {
  // The same mark on a 2x display and a 1x display of the same point size lands on the same window spot.
  const retina = { id: 7, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
  const [a] = M.planOverlay([{ kind: 'box', x: 720, y: 450, width: 100, height: 30 }], [retina]).get(7).marks;
  assert.equal(a.x, 720);
  assert.equal(a.width, 100);
});

test('a box across two displays is drawn on both, each part where it is', () => {
  const plan = M.planOverlay([{ kind: 'box', x: -50, y: 100, width: 120, height: 30 }], DISPLAYS);
  assert.equal(plan.get(1).marks[0].x, -50);
  assert.equal(plan.get(2).marks[0].x, 1870);
  assert.equal(plan.get(2).marks[0].y, 300);
});

test('an arrow\'s tail points from the middle of its display, so the arrow stays on that screen', () => {
  for (const [x, y] of [[2, 2], [1510, 980], [1510, 2], [2, 980]]) {
    const tail = M.arrowTail(x, y, LAPTOP.bounds);
    assert.ok(tail.x >= 0 && tail.x <= 1512 && tail.y >= 0 && tail.y <= 982, `${x},${y} → ${tail.x},${tail.y}`);
    assert.ok(Math.abs(Math.hypot(tail.x - x, tail.y - y) - M.ARROW_LENGTH) < 0.5);
  }
  const mid = M.arrowTail(756, 491, LAPTOP.bounds);
  assert.ok(mid.x > 756 && mid.y > 491, 'from the lower right at the very middle');
});

test('a point in a gap between displays goes to the nearest one', () => {
  assert.equal(M.displayFor(DISPLAYS, 3000, 100).id, 1);
  assert.equal(M.displayFor(DISPLAYS, -3000, 100).id, 2);
});

function harness(over = {}) {
  const log = [];
  const timers = new Map();
  let next = 1;
  let cursor = { x: -500, y: -500 };
  let escape = null;
  const windows = [];
  const deps = {
    displays: () => DISPLAYS,
    openWindow: (display) => {
      const w = { display, drawn: [], closed: false, draw(m) { this.drawn.push(m); }, close() { this.closed = true; } };
      windows.push(w);
      return w;
    },
    cursor: () => cursor,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = next++; timers.set(id, { fn, ms, kind: 'interval' }); return id; },
    clearInterval: (id) => timers.delete(id),
    grabEscape: (fn) => { escape = fn; return true; },
    releaseEscape: () => { escape = null; },
    log: (line) => log.push(line),
    ...over,
  };
  const overlay = new M.ScreenMarksOverlay(deps);
  const fire = (kind) => { for (const [id, t] of [...timers]) if (t.kind === kind) { if (kind === 'timeout') timers.delete(id); t.fn(); } };
  return {
    overlay, windows, timers, log,
    moveTo: (x, y) => { cursor = { x, y }; fire('interval'); },
    timeout: () => fire('timeout'),
    pressEscape: () => escape && escape(),
    get escapeHeld() { return escape !== null; },
  };
}

const ARROW_SET = { marks: [{ kind: 'arrow', x: 700, y: 400, step: 1 }, { kind: 'arrow', x: -1000, y: 300, step: 2 }], seconds: 15 };
const result = (marks) => ({ kind: 'tool_result', payload: { tool: 'os.screen.point', status: 'ok', screen_marks: marks } });

test('lifecycle: an os.screen.point result opens one window per display with marks, with a timeout and Esc', () => {
  const h = harness();
  h.overlay.observe(result(ARROW_SET));
  assert.equal(h.windows.length, 2);
  assert.ok(h.overlay.showing);
  assert.ok(h.escapeHeld);
  const timeout = [...h.timers.values()].find((t) => t.kind === 'timeout');
  assert.equal(timeout.ms, 15_000);
  h.timeout();
  assert.ok(!h.overlay.showing, 'gone after its timeout');
  assert.ok(h.windows.every((w) => w.closed));
  assert.equal(h.timers.size, 0, 'no timer left behind');
  assert.ok(!h.escapeHeld, 'Esc is given back');
});

test('lifecycle: Esc clears and gives the key back', () => {
  const h = harness();
  h.overlay.observe(result(ARROW_SET));
  h.pressEscape();
  assert.ok(!h.overlay.showing);
  assert.ok(!h.escapeHeld);
  assert.equal(h.timers.size, 0);
});

test('lifecycle: the next turn clears; a failed, foreign or other tool\'s result draws nothing', () => {
  const h = harness();
  h.overlay.observe({ kind: 'tool_result', payload: { tool: 'os.screen.point', status: 'error', screen_marks: ARROW_SET } });
  h.overlay.observe({ kind: 'tool_result', payload: { tool: 'os.screen.click', status: 'ok', screen_marks: ARROW_SET } });
  assert.equal(h.windows.length, 0);
  h.overlay.observe(result(ARROW_SET));
  assert.ok(h.overlay.showing);
  h.overlay.observe({ kind: 'session_id', payload: { session_id: 's' } });
  assert.ok(!h.overlay.showing, 'a new turn starts clean');
  assert.equal(h.timers.size, 0);
});

test('lifecycle: a new set replaces the old one, never piles up windows', () => {
  const h = harness();
  h.overlay.observe(result(ARROW_SET));
  h.overlay.observe(result({ marks: [{ kind: 'box', x: 10, y: 10, width: 50, height: 20 }] }));
  assert.equal(h.windows.filter((w) => !w.closed).length, 1);
  assert.equal([...h.timers.values()].filter((t) => t.kind === 'timeout').length, 1);
});

test('lifecycle: the pointer reaching a spot and leaving it takes that mark away; the last one clears all', () => {
  const h = harness();
  h.overlay.observe(result(ARROW_SET));
  h.moveTo(705, 395);                  // on step 1's tip
  assert.ok(h.overlay.showing);
  h.moveTo(900, 700);                  // left it: found
  assert.ok(h.overlay.showing, 'step 2 is still to do');
  const laptop = h.windows.find((w) => w.display.id === 1);
  const left = h.windows.find((w) => w.display.id === 2);
  assert.deepEqual(laptop.drawn.at(-1), [], 'step 1 is gone from its screen');
  assert.equal(left.drawn.at(-1).length, 1);
  assert.equal(left.drawn.at(-1)[0].index, 1, 'step 2 keeps its own index');
  h.moveTo(-1000, 300);
  h.moveTo(-600, 600);
  assert.ok(!h.overlay.showing);
  assert.equal(h.timers.size, 0);
});

test('lifecycle: a display that cannot open does not take the others down; nothing to draw opens nothing', () => {
  let n = 0;
  const h = harness({ openWindow: (display) => { if (n++ === 0) throw new Error('no window'); return { display, drawn: [], draw() {}, close() {} }; } });
  assert.equal(h.overlay.show(ARROW_SET), 2);
  assert.ok(h.overlay.showing);
  const none = harness({ displays: () => [] });
  assert.equal(none.overlay.show(ARROW_SET), 0);
  assert.equal(none.timers.size, 0);
  assert.ok(!none.escapeHeld);
});

test('the overlay window takes no click, no focus and no key, and stays out of screenshots', () => {
  const src = readFileSync(new URL('../main/screen-overlay-window.ts', import.meta.url), 'utf8');
  for (const needle of [
    'focusable: false',
    'transparent: true',
    'setIgnoreMouseEvents(true)',
    'showInactive()',
    'type: "panel"',
    'setContentProtection(true)',
    'setAlwaysOnTop(true, "screen-saver")',
  ]) assert.ok(src.includes(needle), needle);
  assert.ok(!/\.focus\(\)|\.show\(\)/.test(src), 'never focus() or show() — only showInactive()');
  assert.ok(src.includes('overlayWindows.add(win)') && /export function appWindows/.test(src), 'overlays are not app windows');
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.ok(!/getAllWindows()/.test(main), 'main.ts counts app windows through appWindows()');
  const page = readFileSync(new URL('../renderer/screen-overlay.js', import.meta.url), 'utf8');
  assert.ok(!/addEventListener|onclick|onkey|innerHTML/.test(page), 'the page reads no input and parses no HTML');
});

test('only the window\'s own agent is told it can draw marks', () => {
  const src = readFileSync(new URL('../main/agent-client.ts', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.\(this\.remote \? \{\} : \{ "x-atomic-screen-overlay": "1" \}\)/);
});
