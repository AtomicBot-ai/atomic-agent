/**
 * drive-ux.mjs — the r6-ux lane's CDP driver, kept beside drive.mjs.
 *
 * INTEGRATION NOTE (r6). Four lanes each wrote a driver against the same
 * protocol and arrived at four different shapes: this one hands back a plain
 * object of closures whose `waitFor` takes a SELECTOR, whose `press` takes an
 * options object, and whose `snap` describes the onboarding surface
 * specifically. `drive.mjs` (the r6-human driver, now the canonical one)
 * hands back a class whose `waitFor` takes an EXPRESSION, whose `press` takes
 * an array of modifiers, and whose `snap` describes the whole app.
 *
 * The two cannot be folded into one exported name without silently changing
 * what the other lane's scenarios assert, so both are kept and the scenario
 * files import the one they were written and driven against. New scenarios
 * should use `drive.mjs`; this file exists so `test/onboarding-mouse.mjs`
 * keeps running exactly as it was proved to run.
 *
 * Everything below is the r6-ux lane's file, unchanged.
 */
/**
 * drive.mjs — a hand, not a hook.
 *
 * The desktop's own `--smoke` suite drives the renderer through the
 * `window.__*` hooks, which CALL INTERNAL FUNCTIONS DIRECTLY. That is a
 * fine way to assert what a reducer computes and a useless way to assert
 * that a person can click a button: a hook that calls the activation
 * function never touches the event handler, so a row whose click path is
 * broken still passes. It happened — 490 green checks alongside a wizard
 * in which one click on a row did nothing.
 *
 * This module drives the SAME running app over the Chrome DevTools
 * Protocol with real, trusted input events: `Input.dispatchMouseEvent`
 * for a click, `Input.dispatchKeyEvent` / `Input.insertText` for typing.
 * `Runtime.evaluate` is used ONLY to look — geometry, text, classes.
 * Never to act. If a step cannot be performed with the mouse and the
 * keyboard alone, that is a defect in the app, not a reason to reach for
 * a hook.
 *
 * Usage:
 *
 *   import { launch } from './drive.mjs';
 *   const app = await launch({ port: 9401, stateDir: '/tmp/lane' });
 *   await app.waitFor('#onboarding');
 *   await app.clickText('Cloud models');
 *   console.log(await app.snap());
 *   await app.close();
 *
 * Every helper resolves to a short, printable description of what it did
 * so a scenario reads as a transcript.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_DIR = resolve(HERE, '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns something truthy, or give up. */
export async function until(probe, { timeout = 15000, every = 200, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

/**
 * Connect to an Electron app that is already listening on `port`.
 * Returns the driver; the caller owns the process.
 */
export async function attach(port, { child = null } = {}) {
  const target = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => t.type === 'page' && !/devtools:/.test(t.url)) || null;
    } catch {
      return null;
    }
  }, { timeout: 60000, what: `a CDP page target on ${port}` });

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.error ? { __cdpError: m.error } : m.result); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  /** Look at the page. Observation only — never call this to act. */
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r && r.__cdpError) throw new Error('evaluate failed: ' + JSON.stringify(r.__cdpError));
    if (r && r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r?.result?.value;
  };

  /* --- looking ------------------------------------------------------ */

  /** The centre of an element, in viewport pixels, plus what it says. */
  const boxOf = (selector, { text = null, index = 0 } = {}) => js(`(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const want = ${JSON.stringify(text)};
    const hits = want === null ? all : all.filter((n) => (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').includes(want));
    const n = hits[${index}];
    if (!n) return null;
    const r = n.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const cs = getComputedStyle(n);
    return {
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      label: (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 46),
      cls: n.className && n.className.baseVal !== undefined ? n.className.baseVal : String(n.className || ''),
      disabled: n.disabled === true || cs.pointerEvents === 'none',
      tag: n.tagName,
    };
  })()`);

  const text = (selector = 'body') => js(
    `((document.querySelector(${JSON.stringify(selector)}) || {}).innerText || '').replace(/\\s+/g, ' ').trim()`,
  );

  /** A compact picture of the onboarding surface: what a person sees. */
  const snap = () => js(`(() => {
    const ob = document.querySelector('#onboarding');
    if (!ob) return { present: false };
    const t = (n) => (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      present: true,
      subtitle: t(ob.querySelector('.ob-sub2') || document.createElement('i')),
      heads: [...ob.querySelectorAll('.ob-h')].map(t).slice(0, 3),
      rows: [...ob.querySelectorAll('[data-obrow]')].map((n) => (n.classList.contains('on') ? '> ' : '  ') + t(n).slice(0, 58)),
      wizRows: [...ob.querySelectorAll('[data-obwiz]')].map((n) => (n.classList.contains('on') ? '> ' : '  ') + t(n).slice(0, 40)),
      acts: [...ob.querySelectorAll('[data-obact]')].map((n) => n.dataset.obact + ':' + t(n).slice(0, 30)),
      buttons: [...ob.querySelectorAll('.ob-foot button, button.btn')].map((n) => t(n) + (n.disabled ? ' (disabled)' : '')),
      inputs: [...ob.querySelectorAll('input')].map((n) => (n.id || n.className) + '=' + (n.type === 'password' ? '*'.repeat(n.value.length) : n.value)),
      error: t(ob.querySelector('.ob-err') || document.createElement('i')),
      hints: t(ob.querySelector('.ob-hints') || document.createElement('i')).slice(0, 90),
    };
  })()`);

  const waitFor = (selector, opts = {}) => until(
    () => js(`!!document.querySelector(${JSON.stringify(selector)})`),
    { what: `selector ${selector}`, ...opts },
  );

  /** Wait until the onboarding subtitle/step actually changes. */
  const waitStep = (want, opts = {}) => until(async () => {
    const s = await snap();
    return s.present && (s.subtitle === want || (s.heads || []).some((h) => h.includes(want))) ? s : null;
  }, { what: `step "${want}"`, ...opts });

  /* --- acting: real events only ------------------------------------- */

  async function clickAt(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /** Click the first element matching `selector`. */
  async function clickSel(selector, { index = 0, settle = 350 } = {}) {
    const box = await boxOf(selector, { index });
    if (!box) throw new Error(`nothing to click for selector ${selector}`);
    await clickAt(box.x, box.y);
    await sleep(settle);
    return `clicked ${selector} ("${box.label}")`;
  }

  /** Click the first element matching `selector` whose text contains `txt`. */
  async function clickText(txt, { selector = '#onboarding button, #onboarding [data-obrow], #onboarding [data-obwiz], #onboarding [data-obact], button', settle = 350 } = {}) {
    const box = await boxOf(selector, { text: txt });
    if (!box) throw new Error(`no clickable element containing "${txt}"`);
    await clickAt(box.x, box.y);
    await sleep(settle);
    return `clicked "${box.label}" (${box.w}x${box.h}px)`;
  }

  /** Turn the wheel over an element, the way a hand scrolls a list. */
  async function wheel(selector, deltaY = 400) {
    const box = await boxOf(selector);
    if (!box) throw new Error(`nothing to scroll for ${selector}`);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: box.x, y: box.y, button: 'none', buttons: 0, deltaX: 0, deltaY,
    });
    await sleep(250);
    return `wheeled ${deltaY > 0 ? 'down' : 'up'} over ${selector}`;
  }

  /** Hover, so a :hover rule can be observed. */
  async function hover(selector, { index = 0 } = {}) {
    const box = await boxOf(selector, { index });
    if (!box) throw new Error(`nothing to hover for ${selector}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 });
    await sleep(120);
    return `hovered ${selector}`;
  }

  /**
   * Take the pointer off whatever it is sitting on.
   *
   * Anything asserted about a control's RESTING look has to be read with
   * the mouse elsewhere — a click leaves the pointer on the button it
   * pressed, so `:hover` is still applying and a border that only exists
   * on hover reads as a border that is always there.
   */
  async function moveAway() {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', buttons: 0 });
    await sleep(120);
    return 'moved the pointer off the controls';
  }

  /** Type into whatever has focus, one trusted char event at a time. */
  async function type(str) {
    for (const ch of str) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await sleep(150);
    return `typed ${str.length} characters`;
  }

  const KEYS = {
    Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
    Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
    Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', text: '\t' },
    ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
    ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
    Space: { windowsVirtualKeyCode: 32, code: 'Space', key: ' ', text: ' ' },
    Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
  };

  /**
   * Press a named key (or a single character) as a real keystroke.
   *
   * `keyDown` rather than `rawKeyDown` for every key: rawKeyDown carries
   * no editing command, so a Backspace sent that way moves nothing in a
   * text field and a scenario that "cleared" one would be lying. A
   * printable key carries its `text` on the keyDown, which is what
   * inserts it — a separate `char` event on top of that types it twice.
   */
  async function press(name, { settle = 300, shift = false } = {}) {
    const spec = KEYS[name] || { key: name, text: name, unmodifiedText: name };
    const modifiers = shift ? 8 : 0;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...spec });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...spec });
    await sleep(settle);
    return `pressed ${name}`;
  }

  /** Empty the focused text field the way a hand does: select all, delete. */
  async function clearField(selector) {
    await clickSel(selector, { settle: 60 });
    const n = await js(`(document.querySelector(${JSON.stringify(selector)}) || {value: ''}).value.length`);
    for (let i = 0; i < n + 1; i += 1) await press('Backspace', { settle: 8 });
    await sleep(120);
    return `cleared ${selector} (${n} characters)`;
  }

  /** What the page thinks has focus, and whether it draws a focus ring. */
  const focusInfo = () => js(`(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { tag: 'BODY', label: '', ring: false };
    const cs = getComputedStyle(a);
    return {
      tag: a.tagName, id: a.id || null,
      cls: String(a.className || ''),
      label: (a.innerText || a.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
      visible: a.matches(':focus-visible'),
    };
  })()`);

  async function screenshot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r || !r.data) throw new Error('no screenshot');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return `screenshot → ${file}`;
  }

  /**
   * Put the app away. The whole process GROUP, not the child: `npx` is
   * the child, Electron is its grandchild, and a SIGTERM to npx alone
   * leaves an Electron holding the debugging port — which the next run
   * then attaches to, driving a stale build and passing on it.
   */
  async function close() {
    try { ws.close(); } catch { /* already gone */ }
    if (!child || child.killed) return;
    const stop = (signal) => {
      try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
      try { child.kill(signal); } catch { /* already gone */ }
    };
    stop('SIGTERM');
    await Promise.race([once(child, 'exit'), sleep(4000)]);
    stop('SIGKILL');
  }

  return {
    send, js, boxOf, text, snap, waitFor, waitStep,
    clickAt, clickSel, clickText, hover, moveAway, wheel, type, press, clearField, focusInfo, screenshot, close,
    child,
  };
}

/**
 * Launch the desktop app on its own state directory with the DevTools
 * protocol open, and attach. `npm run build` is the caller's business.
 */
export async function launch({ port = 9401, stateDir, args = [], env = {}, cwd = DESKTOP_DIR, quiet = true } = {}) {
  if (!stateDir) throw new Error('launch() needs an explicit stateDir — never the operator\'s own');
  /* Refuse to start on a port somebody else is already listening on. The
     alternative is worse than a crash: the new Electron cannot bind, and
     `attach` finds the OLD app's page target and drives that instead —
     a whole scenario passing against a build nobody has just made. */
  try {
    const squatter = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (squatter.ok) {
      throw new Error(`port ${port} already has a debuggable app on it — close it first `
        + `(lsof -nP -iTCP:${port}), or pass a different --port`);
    }
  } catch (e) {
    if (/already has a debuggable app/.test(e.message)) throw e;   // ours
    /* anything else means nothing answered, which is what we want */
  }
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron', '.', `--remote-debugging-port=${port}`, ...args],
    {
      cwd,
      // Its own process group, so `close` can take the whole tree down.
      detached: process.platform !== 'win32',
      env: { ...process.env, ATOMIC_AGENT_STATE_DIR: stateDir, ...env },
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    },
  );
  if (quiet) {
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
  }
  /* However this process dies — a thrown scenario, Ctrl+C, the alarm a
     CI wrapper sets — the app it started dies with it. An orphan holding
     the debugging port is how the NEXT run ends up driving a stale
     build. */
  const reap = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
  process.on('exit', reap);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGALRM']) {
    process.on(signal, () => { reap(); process.exit(1); });
  }
  const app = await attach(port, { child });
  return app;
}

export default { launch, attach, until, sleep, DESKTOP_DIR };
