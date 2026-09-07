/**
 * drive.mjs — a HUMAN driver for the desktop app.
 *
 * Everything in here goes through the Chrome DevTools Protocol's `Input`
 * domain, which is the same path a hand takes: `Input.dispatchMouseEvent`
 * produces a TRUSTED click that the renderer's own delegated listener sees,
 * and `Input.insertText` / `Input.dispatchKeyEvent` produce trusted typing.
 *
 * That is the whole point of the file. The `--smoke` suite drives the
 * renderer through `window.__*` hooks, which call internal functions
 * directly; a hook proves the function works and says NOTHING about whether
 * a person clicking the thing on screen reaches it. A wizard row whose click
 * handler is missing passes every hook check and is broken for every user.
 *
 * So the rule here is: `Runtime.evaluate` is for LOOKING ONLY — text,
 * classes, geometry, screenshots. If a step can only be performed by calling
 * an internal function, that is a bug in the app, not a reason to call it.
 *
 * Usage:
 *
 *   import { launch } from './drive.mjs';
 *   const app = await launch({ port: 9403, stateDir: '/tmp/...' });
 *   await app.clickText('.cfoot button', 'local');
 *   console.log(await app.snap(`document.querySelector('#composer').textContent`));
 *   await app.close();
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_DIR = resolve(HERE, '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn `electron .` on a state dir of the caller's choosing with the CDP
 * port open, then attach. NEVER defaults the state dir: the desktop's own
 * default is the operator's live app data.
 */
export async function launch({
  port = 9400,
  stateDir,
  args = [],
  env = {},
  log = null,
  timeoutMs = 60000,
} = {}) {
  if (!stateDir) throw new Error('launch(): stateDir is required — never write the operator’s own');
  // A window left over from an earlier run answers on this port, and
  // `attach` would happily talk to IT instead of the app about to start —
  // which is how a scenario ends up driving yesterday's build and reporting
  // yesterday's screen. Refuse, loudly, rather than test the wrong window.
  if (await portAnswers(port)) {
    throw new Error(
      `port ${port} already has a CDP target — an app from an earlier run is still up. ` +
      `Close it (or pick another port) before driving.`,
    );
  }
  // Detached so the whole tree is killable: `npx` → the electron shim → the
  // real Electron binary is three processes, and SIGTERM to the first kills
  // only the first.
  const child = spawn(
    'npx',
    ['electron', '.', `--remote-debugging-port=${port}`, ...args],
    {
      cwd: DESKTOP_DIR,
      env: { ...process.env, ATOMIC_AGENT_STATE_DIR: stateDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let out = '';
  child.stdout.on('data', (b) => { out += b; if (log) process.stdout.write(`[app] ${b}`); });
  child.stderr.on('data', (b) => { out += b; if (log) process.stderr.write(`[app!] ${b}`); });
  const session = await attach({ port, timeoutMs });
  session.child = child;
  session.appOutput = () => out;
  const closeCdp = session.close;
  session.close = async () => {
    await closeCdp();
    await killTree(child, port);
  };
  return session;
}

/** Is anything already speaking CDP here? */
async function portAnswers(port) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return Array.isArray(list);
  } catch {
    return false;
  }
}

/**
 * Kill the process GROUP and wait for the port to go quiet. Without the
 * wait, a `launch()` that follows immediately races the dying window and
 * either attaches to it or trips the guard above.
 */
async function killTree(child, port) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
    try { child.kill(signal); } catch { /* already gone */ }
    const deadline = Date.now() + (signal === 'SIGTERM' ? 6000 : 6000);
    while (Date.now() < deadline) {
      if (!(await portAnswers(port))) return;
      await sleep(200);
    }
  }
}

/** Attach to an already-running app on `port`. */
export async function attach({ port = 9400, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let page = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && !/devtools/.test(t.url));
      if (page) break;
    } catch { /* the app has not opened the port yet */ }
    await sleep(250);
  }
  if (!page) throw new Error(`no CDP page target on port ${port} after ${timeoutMs}ms`);
  return session(page.webSocketDebuggerUrl);
}

async function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? { __error: m.error }); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  /** LOOK ONLY. Never use this to act. */
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error(`evaluate threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`);
    return r?.result?.value;
  };

  /** Where is it, and is a real click going to land on IT and not on something on top? */
  const boxOf = (findExpr) => js(`(() => {
    const n = ${findExpr};
    if (!n) return null;
    n.scrollIntoView({block:'center'});
    const r = n.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return {hidden:true, text:(n.textContent||'').trim().slice(0,60)};
    const x = r.left + r.width/2, y = r.top + r.height/2;
    const top = document.elementFromPoint(x, y);
    return {
      x, y,
      text: (n.textContent||'').trim().replace(/\\s+/g,' ').slice(0,60),
      covered: !(top && (top === n || n.contains(top) || top.contains(n))),
      cover: top ? (top.className || top.tagName) : null,
    };
  })()`);

  async function clickBox(box, settle) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(settle);
  }

  /** Click the centre of the first match of a CSS selector. */
  async function clickSel(sel, { settle = 500 } = {}) {
    const box = await boxOf(`document.querySelector(${JSON.stringify(sel)})`);
    if (!box) return { ok: false, why: `no element matching ${sel}` };
    if (box.hidden) return { ok: false, why: `${sel} has no box (display:none?)` };
    if (box.covered) return { ok: false, why: `${sel} is covered by ${box.cover}`, text: box.text };
    await clickBox(box, settle);
    return { ok: true, clicked: box.text || sel };
  }

  /** Click the first element matching `sel` whose text contains `text`. */
  async function clickText(sel, text, { settle = 500 } = {}) {
    const box = await boxOf(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => (n.textContent||'').includes(${JSON.stringify(text)}))`);
    if (!box) return { ok: false, why: `no ${sel} whose text contains "${text}"` };
    if (box.hidden) return { ok: false, why: `"${text}" has no box` };
    if (box.covered) return { ok: false, why: `"${text}" is covered by ${box.cover}`, text: box.text };
    await clickBox(box, settle);
    return { ok: true, clicked: box.text };
  }

  /** Type into whatever has focus, character by character, as a keyboard does. */
  async function type(text, { settle = 200 } = {}) {
    for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    await sleep(settle);
  }

  /** One named key (Enter, Escape, ArrowDown, Tab…). */
  async function press(key, { settle = 300 } = {}) {
    const map = {
      Enter: { keyCode: 13, code: 'Enter', text: '\r' },
      Escape: { keyCode: 27, code: 'Escape' },
      Tab: { keyCode: 9, code: 'Tab' },
      ArrowDown: { keyCode: 40, code: 'ArrowDown' },
      ArrowUp: { keyCode: 38, code: 'ArrowUp' },
      ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
      ArrowRight: { keyCode: 39, code: 'ArrowRight' },
      Backspace: { keyCode: 8, code: 'Backspace' },
    };
    const k = map[key];
    if (!k) throw new Error(`press(): unmapped key ${key}`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, key, code: k.code });
    if (k.text) await send('Input.dispatchKeyEvent', { type: 'char', text: k.text, key, code: k.code, windowsVirtualKeyCode: k.keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, key, code: k.code });
    await sleep(settle);
  }

  /** Focus a field the way a person does — by clicking it — then type. */
  async function fill(sel, text) {
    const c = await clickSel(sel, { settle: 150 });
    if (!c.ok) return c;
    await type(text);
    return { ok: true, value: await js(`(document.querySelector(${JSON.stringify(sel)})||{}).value`) };
  }

  /** Poll a boolean expression. Looking only. */
  async function waitFor(expr, { timeoutMs = 20000, every = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let v = false;
      try { v = await js(`!!(${expr})`); } catch { v = false; }
      if (v) return true;
      await sleep(every);
    }
    return false;
  }

  /** Read the screen. `expr` must be a pure expression returning JSON. */
  const snap = (expr) => js(`(${expr})`);

  async function screenshot(path) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r || !r.data) return null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }

  const close = async () => { try { ws.close(); } catch { /* already closed */ } };

  await send('Page.enable');
  await send('Runtime.enable');
  return { send, js, snap, clickSel, clickText, type, press, fill, waitFor, screenshot, close, sleep };
}

/* ---- a tiny assertion tape, so a scenario reads as a transcript ---- */
export function tape(name) {
  const lines = [];
  let failures = 0;
  return {
    say(line) { lines.push(line); console.log(line); },
    check(label, ok, detail = '') {
      if (!ok) failures += 1;
      const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`;
      lines.push(line); console.log(line);
      return ok;
    },
    get failures() { return failures; },
    finish() {
      const line = `\n${name}: ${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`;
      lines.push(line); console.log(line);
      return failures;
    },
  };
}
