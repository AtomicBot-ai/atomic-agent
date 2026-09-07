/**
 * drive.mjs — a HUMAN driver for the desktop app.
 *
 * Why this exists.  `npm run smoke` drives the renderer through the
 * `window.__*` hooks, which call the app's own internal functions.  A hook
 * that skips the event handler proves nothing about what a person
 * experiences: a wizard row whose click listener never fires still passes
 * every hook-driven check, because the hook called the activation function
 * the click was supposed to reach.  That is exactly how a first-run screen
 * in which clicking a row does nothing survived ~490 green assertions.
 *
 * So this module never touches app internals to ACT.  It moves a real
 * mouse and presses real keys over the Chrome DevTools Protocol —
 * `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` produce TRUSTED
 * events on the same path a hand takes.  `Runtime.evaluate` is used only
 * to OBSERVE: read text, classes, geometry.  If a step can only be
 * performed by calling an internal function, that is a bug in the app,
 * not a licence to call the function.
 *
 * Usage:
 *   import { launch } from './drive.mjs';
 *   const app = await launch({ stateDir, port: 9402 });
 *   await app.clickText('Cloud models');
 *   await app.type('#wiz-key', 'sk-...');
 *   await app.clickText('Next');
 *   console.log(await app.snapshot());
 *   await app.close();
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_DIR = join(HERE, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

/* ---------------------------------------------------------------- */
/* CDP transport                                                     */
/* ---------------------------------------------------------------- */

async function pageTarget(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      // The main window is the only `page` target that carries the app UI;
      // devtools front-ends and the speech helper never do.
      const page = list.find((t) => t.type === 'page' && !/devtools:/.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* the port is not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`no CDP page target on port ${port} after ${timeoutMs}ms`);
    await sleep(250);
  }
}

/**
 * Attach to an already-running app on `port`.  Returns the driver API.
 *
 * ONE client at a time.  Chromium hands a page target to a single debugger
 * session, so opening a second socket to peek at a run in flight silently
 * detaches the first: its `Runtime.evaluate` calls never answer again and
 * the scenario hangs at whatever line it was on, looking exactly like an
 * app freeze.  Watch a run through its own log, never by attaching.
 */
export async function attach(port, opts = {}) {
  const target = await pageTarget(port, opts.timeoutMs);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const consoleLines = [];
  let seq = 0;
  let closed = false;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('close', () => { closed = true; });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
      consoleLines.push(`[${msg.params.type}] ${text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      consoleLines.push(`[exception] ${d.text || ''} ${(d.exception && d.exception.description) || ''}`.trim());
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('CDP socket closed'));
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  /** Evaluate an expression IN THE PAGE — observation only. */
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page eval threw: ${d.text} ${(d.exception && d.exception.description) || ''}`);
    }
    return r && r.result ? r.result.value : undefined;
  };

  /* ------------------------------------------------------------ */
  /* observation                                                   */
  /* ------------------------------------------------------------ */

  /** The centre of the first element matching `selector`, in page pixels. */
  const boxOf = (selector) => js(`(() => {
    const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null;
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return {hidden: true, text: (n.textContent||'').trim().slice(0,60)};
    return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height,
            text: (n.textContent||'').trim().replace(/\\s+/g,' ').slice(0,60)};
  })()`);

  /**
   * The centre of the first element whose visible text CONTAINS `text`.
   * `within` narrows the search; `tags` limits which elements count as
   * clickable (default: anything a person could plausibly click).
   */
  const boxOfText = (text, within = '', tags = 'button,[role=button],[data-act],.modelrow,.ob-opt,.row,li,a') => js(`(() => {
    const scope = ${JSON.stringify(within)} ? document.querySelector(${JSON.stringify(within)}) : document;
    if (!scope) return null;
    const want = ${JSON.stringify(text)}.toLowerCase();
    const all = [...scope.querySelectorAll(${JSON.stringify(tags)})];
    // Innermost match wins: a row inside a matching container is the thing
    // a person aims at, not the container.
    const hits = all.filter((n) => (n.textContent||'').toLowerCase().includes(want)
      && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0);
    if (!hits.length) return null;
    hits.sort((a,b) => (a.textContent||'').length - (b.textContent||'').length);
    const n = hits[0];
    const r = n.getBoundingClientRect();
    return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height,
            tag: n.tagName.toLowerCase(), cls: n.className,
            disabled: !!n.disabled,
            text: (n.textContent||'').trim().replace(/\\s+/g,' ').slice(0,60)};
  })()`);

  /** Wait until `expression` evaluates truthy; returns its value. */
  async function waitFor(expression, { timeoutMs = 20000, everyMs = 250, label = '' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      last = await js(`(() => { try { return (${expression}); } catch (e) { return undefined; } })()`);
      if (last) return last;
      if (Date.now() > deadline) {
        throw new Error(`waitFor timed out after ${timeoutMs}ms${label ? ` (${label})` : ''}: ${expression}`);
      }
      await sleep(everyMs);
    }
  }

  /* ------------------------------------------------------------ */
  /* real input                                                    */
  /* ------------------------------------------------------------ */

  async function mouseClick(x, y, { clickCount = 1 } = {}) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
  }

  const viewport = () => js('({w: innerWidth, h: innerHeight})');

  /**
   * Bring a box inside the viewport the way a person does — WHEEL NOTCHES,
   * not `scrollIntoView()`.  A click at coordinates outside the window is
   * swallowed by the OS and looks exactly like a dead control, so every
   * click goes through here first.  `remeasure` re-reads the box after
   * each notch because scrolling moves it.
   */
  /**
   * The centre of the nearest ancestor that can actually scroll — where a
   * hand would rest the pointer to reach a row that is clipped out of a
   * pane.  `null` when nothing between the element and the body scrolls.
   */
  const scrollHostOf = (box) => js(`(() => {
    const px = ${box.x};
    const scrollers = [...document.querySelectorAll('*')].filter((e) => {
      if (e.scrollHeight <= e.clientHeight + 2) return false;
      const oy = getComputedStyle(e).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return false;
      const r = e.getBoundingClientRect();
      return r.height > 0 && r.left <= px && px <= r.right;
    });
    if (!scrollers.length) return null;
    // The innermost one: no other candidate contains it.
    const inner = scrollers.filter((e) => !scrollers.some((o) => o !== e && e.contains(o)));
    const r = (inner[0] || scrollers[0]).getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);

  async function ensureVisible(remeasure, box) {
    const vp = await viewport();
    let cur = box;
    for (let tries = 0; tries < 12; tries++) {
      if (!cur) return cur;
      const margin = 40;
      if (cur.y > margin && cur.y < vp.h - margin) return cur;
      const dy = cur.y <= margin ? -(margin - cur.y + 120) : cur.y - (vp.h - margin) + 120;
      /* The notch goes over the box that actually scrolls, the way a hand
         puts the pointer on the list before turning the wheel. A settings
         pane scrolls inside `.setbody`, and a row clipped BELOW that box
         is at a y-coordinate outside it: wheeling at the row's own
         position (or at the middle of the screen) lands on something else
         entirely and the row stays unreachable for ever. */
      const at = (await scrollHostOf(cur)) || { x: Math.min(cur.x, vp.w - 4), y: Math.round(vp.h / 2) };
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.max(4, Math.min(at.x, vp.w - 4)),
        y: Math.max(4, Math.min(at.y, vp.h - 4)),
        deltaX: 0, deltaY: dy, button: 'none',
      });
      await sleep(160);
      const next = await remeasure();
      /* A pinned strip — the wizard's hint footer sits `position:absolute;
         bottom:0` — never moves for a wheel, so scrolling at it is a dozen
         wasted notches. It is still perfectly clickable where it is: give
         up on centring it and let the viewport check below decide. */
      if (next && cur && Math.abs(next.y - cur.y) < 1) return next;
      cur = next;
    }
    return cur;
  }

  /** Click the centre of `selector`. Throws if it is not on screen. */
  async function clickSel(selector, { settleMs = 500 } = {}) {
    let box = await boxOf(selector);
    if (!box) throw new Error(`clickSel: no element matches ${selector}`);
    if (box.hidden) throw new Error(`clickSel: ${selector} has no box (hidden): "${box.text}"`);
    box = await ensureVisible(() => boxOf(selector), box);
    const vp = await viewport();
    if (box.y < 0 || box.y > vp.h) throw new Error(`clickSel: ${selector} stays outside the window (y=${box.y}, viewport ${vp.h})`);
    await mouseClick(box.x, box.y);
    await sleep(settleMs);
    return box;
  }

  /** Click the innermost clickable element whose text contains `text`. */
  async function clickText(text, { within = '', tags, settleMs = 500, optional = false } = {}) {
    const measure = () => (tags ? boxOfText(text, within, tags) : boxOfText(text, within));
    let box = await measure();
    if (!box) {
      if (optional) return null;
      throw new Error(`clickText: nothing clickable contains ${JSON.stringify(text)}${within ? ` within ${within}` : ''}`);
    }
    box = await ensureVisible(measure, box);
    const vp = await viewport();
    if (box.y < 0 || box.y > vp.h) throw new Error(`clickText: "${text}" stays outside the window (y=${box.y}, viewport ${vp.h})`);
    await mouseClick(box.x, box.y);
    await sleep(settleMs);
    return box;
  }

  /** Click at raw page coordinates (for canvas-ish surfaces). */
  async function clickAt(x, y, { settleMs = 400 } = {}) {
    await mouseClick(x, y);
    await sleep(settleMs);
    return { x, y };
  }

  /** Press a named key as a real key event. */
  async function press(key, { settleMs = 350, modifiers = 0 } = {}) {
    const MAP = {
      Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
      Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', text: '\t' },
      Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
      Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
      ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
      ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
      ArrowLeft: { windowsVirtualKeyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
      ArrowRight: { windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
      Space: { windowsVirtualKeyCode: 32, code: 'Space', key: ' ', text: ' ' },
    };
    const spec = MAP[key];
    if (!spec) throw new Error(`press: unknown key ${key}`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...spec });
    if (spec.text) await send('Input.dispatchKeyEvent', { type: 'char', modifiers, text: spec.text, key: spec.key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...spec });
    await sleep(settleMs);
  }

  /**
   * Type `text` character by character, as real `char` key events.
   * When `selector` is given the field is CLICKED first — the same way a
   * person puts the caret there — never `.focus()`d from script.
   */
  async function type(selector, text, { settleMs = 300, perCharMs = 0 } = {}) {
    if (selector) await clickSel(selector, { settleMs: 150 });
    for (const ch of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      if (perCharMs) await sleep(perCharMs);
    }
    await sleep(settleMs);
    if (selector) return js(`(document.querySelector(${JSON.stringify(selector)})||{}).value`);
    return undefined;
  }

  /**
   * Empty a field the way a person does.  Select-all first (cmd+A), and
   * then — because a synthetic cmd+A does not always reach a field the
   * way the OS accelerator does — hold Backspace down until the field is
   * actually empty.  Asserting on a field this did not really clear is
   * how a run ends up typing a good key onto the tail of a bad one.
   */
  async function clear(selector) {
    await clickSel(selector, { settleMs: 120 });
    /* `null` when the field is not in the document at all, which is NOT
       the same as empty: a repaint replaces the node, and a run that
       reads that instant as "0 characters left" stops early and then
       types its new value onto the tail of the old one. */
    const len = () => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
      return n ? String(n.value || '').length : null; })()`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 4, windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' });
    for (let guard = 0; guard < 800; guard += 1) {
      const left = await len();
      if (left === 0) return;
      if (left === null) { await sleep(100); continue; }  // mid-repaint; look again
      await press('Backspace', { settleMs: 0 });
      // A field that stopped taking keys has lost the focus to a repaint:
      // put the caret back the way a person would, by clicking it again.
      if ((await len()) === left) await clickSel(selector, { settleMs: 120 });
    }
    throw new Error(`clear: ${selector} would not empty (${await len()} left)`);
  }

  /** Scroll the element under (x,y) by `dy` px. */
  async function scroll(x, y, dy, { settleMs = 300 } = {}) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none' });
    await sleep(settleMs);
  }

  /* ------------------------------------------------------------ */
  /* screens                                                       */
  /* ------------------------------------------------------------ */

  /** A compact, printable picture of what is on screen right now. */
  const snapshot = () => js(`(() => {
    const txt = (n) => (n && n.textContent || '').trim().replace(/\\s+/g, ' ');
    const ob = document.querySelector('#onboarding');
    const dlg = document.querySelector('#settings, .sheet, .modal, .pop');
    return {
      wizard: ob ? {
        cls: ob.className || '',
        head: txt(ob.querySelector('.ob-h, .ob-title')).slice(0, 80),
        rows: [...ob.querySelectorAll('.modelrow, .ob-opt, [data-obwiz], [data-ob-choice]')].map((n) => txt(n).slice(0, 60)),
        buttons: [...ob.querySelectorAll('button')].map((n) => txt(n).slice(0, 34)),
        inputs: [...ob.querySelectorAll('input')].map((n) => ({ id: n.id, type: n.type, len: (n.value || '').length })),
        error: txt(ob.querySelector('.ob-err')).slice(0, 160),
        explain: [...ob.querySelectorAll('.ob-explain')].map((n) => txt(n).slice(0, 120)),
      } : null,
      overlay: dlg ? { sel: dlg.id || dlg.className, head: txt(dlg.querySelector('h1,h2,.ob-h,.hd')).slice(0, 80) } : null,
      chips: [...document.querySelectorAll('#chips *, .chip, [data-act^="sel:"]')].map((n) => txt(n).slice(0, 44)).filter(Boolean).slice(0, 14),
      composer: !!document.querySelector('#entry'),
      // The transcript is '#scroller .col720 > .turn' — there is no '#log'
      // in this renderer, and a snapshot that silently matched nothing was
      // how a working reply on screen read as "the model never answered".
      lastLines: [...document.querySelectorAll('#scroller .col720 > .turn')].slice(-4).map((n) => txt(n).slice(0, 120)),
    };
  })()`);

  /** Write a PNG of the window to `path`. */
  async function screenshot(path) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }

  return {
    send, js, waitFor,
    boxOf, boxOfText,
    clickSel, clickText, clickAt, press, type, clear, scroll,
    snapshot, screenshot,
    consoleLines,
    close: () => { try { ws.close(); } catch { /* already gone */ } },
  };
}

/* ---------------------------------------------------------------- */
/* launching                                                         */
/* ---------------------------------------------------------------- */

/**
 * Launch the built app against `stateDir` with CDP on `port`, then attach.
 * The returned object is the driver API plus `proc`, `stdout`, and `quit()`.
 */
export async function launch({ stateDir, port, args = [], env = {}, timeoutMs = 90000, cwd = DESKTOP_DIR } = {}) {
  if (!stateDir) throw new Error('launch: stateDir is required — never drive the operator’s real state dir');
  /* A leftover app from an earlier run keeps the debugging port bound, and
     the second Electron then silently loses the race for it: `attach`
     latches onto the CORPSE, whose `/json/list` is empty or stale, and the
     run stalls for the whole timeout with nothing on screen to explain it.
     Cheaper to refuse the port than to debug that a second time. */
  const squatter = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
  if (squatter) {
    throw new Error(`port ${port} already has a CDP endpoint on it (${squatter.Browser || 'unknown browser'}). `
      + 'An app from an earlier run is still up — quit it (pkill -f desktop) before driving.');
  }
  const out = [];
  const proc = spawn('npx', ['electron', '.', `--remote-debugging-port=${port}`, ...args], {
    cwd,
    env: { ...process.env, ATOMIC_AGENT_STATE_DIR: stateDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (b) => out.push(String(b)));
  proc.stderr.on('data', (b) => out.push(String(b)));
  let exited = null;
  proc.on('exit', (code) => { exited = code; });

  const app = await (async () => {
    try {
      return await attach(port, { timeoutMs });
    } catch (err) {
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
      throw new Error(`${err.message}\n--- app output ---\n${out.join('')}`);
    }
  })();

  return {
    ...app,
    proc,
    stateDir,
    stdout: out,
    exited: () => exited,
    async quit() {
      app.close();
      try { proc.kill('SIGTERM'); } catch { /* gone */ }
      await sleep(400);
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
    },
  };
}

/* ---------------------------------------------------------------- */
/* tiny assertion helpers for scenario scripts                       */
/* ---------------------------------------------------------------- */

let passed = 0;
const failures = [];

export function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}

export function step(n, text) { console.log(`\n${n}. ${text}`); }

export function report(name) {
  console.log(`\n${name}: ${passed} ok, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAILED: ${f}`));
  return failures.length;
}
