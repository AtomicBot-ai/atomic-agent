/**
 * drive.mjs — drive the real desktop app the way a hand does.
 *
 * Everything in here goes through the Chrome DevTools Protocol's INPUT
 * domain: `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` produce
 * TRUSTED events, indistinguishable to the page from a real mouse and a real
 * keyboard. Nothing in this file may call into the app to make something
 * happen. `Runtime.evaluate` appears exactly twice in spirit — to LOOK at the
 * screen (text, classes, geometry) and to find where to click — and never to
 * act. If a step cannot be performed by clicking or typing, that is a defect
 * in the app, not a licence to reach for `window.__something`.
 *
 * Why this exists: `npm run smoke` drives the renderer through `window.__*`
 * hooks that call the internal functions directly. Those hooks proved 490
 * things about functions and nothing about the app: a wizard row whose click
 * handler was wired to the wrong element passed every one of them. A driver
 * that clicks pixels cannot be fooled that way.
 *
 * Usage from a scenario:
 *
 *   import { launch } from '../drive.mjs';
 *   const app = await launch({ port: 9404, stateDir, workspace });
 *   try {
 *     await app.waitFor('!!document.querySelector("#onboarding")', 'the wizard');
 *     await app.clickText('Cloud models');
 *     await app.clickSel('#wiz-key');
 *     await app.type('sk-...');
 *     await app.press('Enter');
 *     await app.screenshot('/tmp/after.png');
 *   } finally {
 *     await app.close();
 *   }
 *
 * Or interactively, from a node REPL / one-off script — same API.
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_DIR = resolve(HERE, '..');
/** The agent repo this desktop lives in. */
export const REPO_DIR = resolve(DESKTOP_DIR, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where the agent binary is, resolved the way the app resolves it
 * (main/agent-client.ts `candidateBinaries`). A scenario needs this to
 * arrange the machine — wrapping the binary in a slow shim, say — before
 * the window opens.
 */
export function resolveBinary() {
  const home = process.env.HOME || '';
  const candidates = [
    ...(process.env.ATOMIC_AGENT_BIN ? [process.env.ATOMIC_AGENT_BIN] : []),
    join(home, 'atag-agent', 'bin', 'atag'),
    join(home, '.local', 'bin', 'atag'),
    join(home, '.local', 'bin', 'atomic-agent'),
    '/usr/local/bin/atag',
    '/opt/homebrew/bin/atag',
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

/* Every app this process launched, so an unhandled throw still tears the
   Electron process down instead of leaving a window on the operator's
   screen and a port bound. */
const LIVE = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const bye = () => { for (const a of LIVE) a.kill(); };
  process.on('exit', bye);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { bye(); process.exit(1); });
  process.on('uncaughtException', (e) => { bye(); console.error(e); process.exit(1); });
}

/* ---------------------------------------------------------------- keys ---
   `Input.dispatchKeyEvent` wants the native codes, not just a name; a
   keyDown with no windowsVirtualKeyCode arrives as a dead key and Enter
   silently does nothing. Only the keys a person actually presses in this
   app are listed, and an unknown name throws rather than no-ops. */
const KEYS = {
  Enter:      { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab:        { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape:     { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace:  { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete:     { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp:    { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown:  { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft:  { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space:      { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  y:          { key: 'y', code: 'KeyY', keyCode: 89, text: 'y' },
  n:          { key: 'n', code: 'KeyN', keyCode: 78, text: 'n' },
};
const MOD = { alt: 1, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

/* The elements a person can click. `clickText` searches these and nothing
   else, so a stray <div> carrying the same words never wins over the button. */
const CLICKABLE = [
  'button', '[role="button"]', 'a', 'input[type="checkbox"]', 'input[type="radio"]',
  '.ob-opt', '.ob-row', '[data-act]', '[data-appr]', '[data-wiz-kind]', '[data-sel-open]',
  '[data-toggle]', '[data-open]', '[data-tab]', '[data-nav]', 'li[tabindex]', '[tabindex="0"]',
].join(',');

class App {
  constructor(proc, opts) {
    this.proc = proc;
    this.opts = opts;
    this.port = opts.port;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this._out = [];
    this.transcript = [];
    this.verbose = opts.verbose !== false;
    this.closed = false;
  }

  /* --- narration -------------------------------------------------- */
  log(line) {
    this.transcript.push(line);
    if (this.verbose) console.log('   ' + line);
    return line;
  }

  /** Whatever Electron wrote to stdout/stderr — the first place to look when
      a click "did nothing" because the main process threw. */
  output() { return this._out.join(''); }

  /* --- CDP plumbing ----------------------------------------------- */
  async connect(timeoutMs = 40000) {
    const until = Date.now() + timeoutMs;
    let target = null;
    while (Date.now() < until) {
      if (this.proc.exitCode !== null) {
        throw new Error(`electron exited with code ${this.proc.exitCode} before the window appeared\n${this.output().slice(-4000)}`);
      }
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
      } catch { /* debugger not listening yet */ }
      if (target && target.webSocketDebuggerUrl) break;
      await sleep(250);
    }
    if (!target) throw new Error(`no page target on port ${this.port} within ${timeoutMs}ms\n${this.output().slice(-4000)}`);
    await this._attach(target.webSocketDebuggerUrl);
    return this;
  }

  async _attach(url) {
    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP websocket refused')), { once: true });
    });
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this._pending.has(m.id)) {
        const { res, rej } = this._pending.get(m.id);
        this._pending.delete(m.id);
        if (m.error) rej(new Error(`${m.error.message} (CDP)`)); else res(m.result);
      }
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP socket is closed'));
    const id = ++this._id;
    return new Promise((res, rej) => {
      this._pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }
      }, 30000);
    });
  }

  /** LOOK at the page. Never used to make something happen. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw while observing: ${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }

  /* --- finding things --------------------------------------------- */
  /** Geometry + identity of one element, or null. `where` is a CSS selector. */
  _boxOf(sel, nth = 0) {
    return this.eval(`(() => {
      const ns = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).pointerEvents !== 'none';
      });
      const n = ns[${nth}];
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom,
               vh: innerHeight, disabled: !!n.disabled,
               label: (n.getAttribute('aria-label') || n.textContent || n.id || n.tagName).trim().replace(/\\s+/g, ' ').slice(0, 44) };
    })()`);
  }

  /** The deepest clickable element whose own text contains `text`. */
  _boxOfText(text, scope) {
    const root = scope ? JSON.stringify(scope) : 'null';
    return this.eval(`(() => {
      const want = ${JSON.stringify(text)};
      const root = ${root} ? document.querySelector(${root}) : document;
      if (!root) return null;
      const all = [...root.querySelectorAll(${JSON.stringify(CLICKABLE)})].filter((n) => {
        if (!(n.textContent || '').includes(want) && (n.getAttribute('aria-label') || '') !== want) return false;
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
      });
      // deepest first: a button inside a row beats the row
      all.sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length);
      const n = all[all.length - 1];
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom,
               vh: innerHeight, disabled: !!n.disabled,
               label: (n.textContent || n.tagName).trim().replace(/\\s+/g, ' ').slice(0, 44) };
    })()`);
  }

  /** Scroll `box` into view the way a person does — with the wheel. */
  async _wheelInto(getBox) {
    let box = await getBox();
    for (let i = 0; box && (box.top < 8 || box.bottom > box.vh - 8) && i < 24; i++) {
      const down = box.bottom > box.vh - 8;
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.min(Math.max(box.x, 4), 1200), y: Math.round(box.vh / 2),
        deltaX: 0, deltaY: down ? 120 : -120, button: 'none',
      });
      await sleep(60);
      box = await getBox();
    }
    return box;
  }

  /* --- acting ------------------------------------------------------ */
  async _clickBox(box, what) {
    if (box.disabled) throw new Error(`"${what}" is disabled — a person could not click it`);
    // Hit test: a click lands on whatever is on top at that point. If an
    // overlay covers the control, say so instead of pretending we clicked it.
    const covered = await this.eval(`(() => {
      const t = document.elementFromPoint(${box.x}, ${box.y});
      return t ? (t.tagName + (t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : '')) : 'nothing';
    })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(24);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(this.opts.settle ?? 260);
    this.log(`click "${what}" at ${Math.round(box.x)},${Math.round(box.y)} (top element there: ${covered})`);
  }

  /** Click the visible thing whose text contains `text`. Waits for it. */
  async clickText(text, { scope, timeout = 8000, scroll = true } = {}) {
    const box = await this._await(() => this._boxOfText(text, scope), timeout,
      `something clickable saying "${text}"`);
    const placed = (scroll ? await this._wheelInto(() => this._boxOfText(text, scope)) : null) || box;
    await this._clickBox(placed, placed.label);
    return placed.label;
  }

  /**
   * Click a CSS selector. Waits for it.
   *
   * `scroll: false` suppresses the scroll-into-view wheel, and there is one
   * screen in this app that needs it. `_wheelInto` sends a real
   * `mouseWheel` before the press, and the first-run splash answers a wheel
   * notch the same way it answers a key or a press — "press any key" is
   * kept on four channels (renderer.js:7634-7640, intro-input.ts:26-41).
   * So `clickSel('#ob-sky')` was not one click on the splash, it was two
   * inputs, and the intro is two-stage: the wheel finished the typewriter,
   * the press dismissed the splash, and the caller's next check found a
   * screen one further on than the one it clicked for. Nothing about the
   * app is wrong there — it is the driver spending an input the operator
   * never made. Use `scroll: false` for anything that counts inputs; the
   * box is already on screen in that case, which is why skipping the wheel
   * costs nothing.
   */
  async clickSel(sel, { nth = 0, timeout = 8000, scroll = true } = {}) {
    const box = await this._await(() => this._boxOf(sel, nth), timeout, sel);
    const placed = (scroll ? await this._wheelInto(() => this._boxOf(sel, nth)) : null) || box;
    await this._clickBox(placed, `${sel}${nth ? `[${nth}]` : ''} — ${placed.label}`);
    return placed.label;
  }

  /** Type into whatever has focus. Refuses if nothing editable is focused —
      typing into the void is the commonest way a fake test passes. */
  async type(text, { perChar = 6 } = {}) {
    const focused = await this.eval(`(() => { const a = document.activeElement;
      if (!a) return null;
      const ed = a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable;
      return ed ? (a.id || a.tagName.toLowerCase()) : null; })()`);
    if (!focused) throw new Error('type(): nothing editable has focus — click the field first');
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, key: ch });
      if (perChar) await sleep(perChar);
    }
    await sleep(120);
    this.log(`type ${JSON.stringify(text.length > 70 ? text.slice(0, 67) + '…' : text)} into #${focused}`);
    return focused;
  }

  /** Type a secret. Identical keystrokes; the narration says only how many.
      Never let an API key reach a log, a screenshot caption or a report. */
  async typeSecret(text, label = 'a secret') {
    const before = this.verbose;
    this.verbose = false;
    let field;
    try { field = await this.type(text, { perChar: 2 }); }
    finally { this.verbose = before; this.transcript.pop(); }
    this.log(`type ${label} (${text.length} characters, not shown) into #${field}`);
    return field;
  }

  /** Press one key, optionally with modifiers: press('Enter'), press('n', ['ctrl']). */
  async press(name, mods = []) {
    const k = KEYS[name];
    if (!k) throw new Error(`press(): unknown key "${name}" — add it to KEYS in drive.mjs`);
    const modifiers = mods.reduce((a, m) => a | (MOD[m] || 0), 0);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (k.text && !modifiers) await this.send('Input.dispatchKeyEvent', { type: 'char', text: k.text, ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(this.opts.settle ?? 260);
    this.log(`press ${mods.concat(name).join('+')}`);
  }

  /* --- waiting ------------------------------------------------------ */
  async _await(fn, timeout, what) {
    const until = Date.now() + timeout;
    let last = null;
    for (;;) {
      last = await fn();
      if (last) return last;
      if (Date.now() > until) throw new Error(`gave up after ${timeout}ms waiting for ${what}`);
      await sleep(150);
    }
  }

  /** Wait until a JS expression observed on the page is truthy. */
  async waitFor(expression, label = expression, { timeout = 20000, quiet = false } = {}) {
    const v = await this._await(async () => {
      try { return await this.eval(`(() => (${expression}))()`); } catch { return null; }
    }, timeout, label);
    if (!quiet) this.log(`saw: ${label}`);
    return v;
  }

  /* --- observing ---------------------------------------------------- */
  /** A human-readable picture of what is on screen right now. */
  snap() {
    return this.eval(`(() => {
      const txt = (n, k = 60) => (n ? (n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, k) : null);
      const ob = document.querySelector('#onboarding');
      const q = (s) => [...document.querySelectorAll(s)];
      return {
        screen: ob ? 'onboarding' : 'app',
        heading: txt(document.querySelector('#onboarding .ob-title, #onboarding h2, #toolbar .wtitle')),
        buttons: q((ob ? '#onboarding ' : '') + 'button').map((b) => txt(b, 34)).filter(Boolean).slice(0, 24),
        rows: q('#onboarding .ob-opt').map((n) => txt(n, 60)),
        fields: q('input, textarea').map((i) => i.id || i.className).filter(Boolean).slice(0, 10),
        status: txt(document.querySelector('.statusstrip')),
        error: txt(document.querySelector('.ob-err, .errline')),
        toast: txt(document.querySelector('#toasts')),
        messages: q('#content .turn').slice(-4).map((n) => ({
          who: n.classList.contains('usr') ? 'you' : (n.querySelector('.card') ? 'tool' : n.querySelector('.appr') ? 'approval' : 'agent'),
          text: txt(n, 220),
        })),
        approvalOpen: !!document.querySelector('#apprcard'),
      };
    })()`);
  }

  /** The last agent reply, as text. */
  lastReply() {
    return this.eval(`(() => {
      const rows = [...document.querySelectorAll('#content .turn')].filter((n) => !n.classList.contains('usr') && n.querySelector('.prose'));
      const n = rows[rows.length - 1];
      return n ? (n.querySelector('.prose').innerText || '').trim() : '';
    })()`);
  }

  /** Every agent reply in the open chat, oldest first. */
  replies() {
    return this.eval(`(() => [...document.querySelectorAll('#content .turn')]
      .filter((n) => !n.classList.contains('usr') && n.querySelector('.prose'))
      .map((n) => (n.querySelector('.prose').innerText || '').trim()))()`);
  }

  async screenshot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    this.log(`screenshot → ${path}`);
    return path;
  }

  /* --- teardown ------------------------------------------------------ */
  /** Synchronous, last-resort kill — the one the exit hooks call.
      Electron is spawned detached, so the whole process GROUP goes: the
      node shim, the browser process, the GPU and network helpers and the
      `atag serve` child. Killing the shim alone leaves the browser holding
      the debugging port, which is how the next run fails to launch. */
  kill(signal = 'SIGKILL') {
    const pid = this.proc?.pid;
    if (pid) {
      try { process.kill(-pid, signal); } catch { /* group already reaped */ }
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
    LIVE.delete(this);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch { /* socket already gone */ }
    this.kill('SIGTERM');
    // Wait for the process to actually go, then insist. A scenario that
    // returns while the port is still bound breaks the NEXT scenario.
    for (let i = 0; i < 30 && this.proc.exitCode === null && this.proc.signalCode === null; i++) await sleep(100);
    this.kill('SIGKILL');
    for (let i = 0; i < 40 && (await portBusy(this.port)); i++) await sleep(100);
    await sleep(200);
  }
}

/** True while something is still listening on the debugging port. */
async function portBusy(port) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 400);
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: c.signal });
    clearTimeout(t);
    return true;
  } catch { return false; }
}

/**
 * CLOUD LANE — point the app at the agent built FROM THIS CHECKOUT when
 * there is one.
 *
 * `resolveBinary` otherwise prefers `~/atag-agent/bin/atag` and then the
 * released install, so a driven run silently exercises whatever agent
 * happens to be installed on the machine — which makes it useless for
 * proving a change to `src/`. A cloud turn is mostly agent code: the
 * provider client, the fallback chain and the message the operator reads
 * when a provider refuses all live there, so a scenario that drives the
 * window but talks to a stranger's agent proves only half of itself.
 *
 * `npm run build` at the repo root produces `dist/cli/index.js`; when it
 * is there this writes a one-line shim inside the run's own state
 * directory and names it in `ATOMIC_AGENT_BIN`, which `candidateBinaries()`
 * honours above everything else. Nothing on the machine is repointed — a
 * terminal `atag` keeps running whatever was installed. An explicit
 * `ATOMIC_AGENT_BIN` from the caller always wins, and with no local build
 * the run falls back to the installed agent exactly as before.
 */
function agentBinEnv(stateDir) {
  if (process.env.ATOMIC_AGENT_BIN) return {};
  const entry = join(REPO_DIR, 'dist', 'cli', 'index.js');
  if (!existsSync(entry)) return {};
  const shim = join(stateDir, 'atag-from-this-checkout.sh');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --enable-source-maps ${JSON.stringify(entry)} "$@"\n`);
  chmodSync(shim, 0o755);
  return { ATOMIC_AGENT_BIN: shim };
}

/**
 * Launch the app against a throwaway state dir with remote debugging on.
 *
 * @param {object} o
 * @param {number} o.port            remote debugging port (one per lane!)
 * @param {string} o.stateDir        ATOMIC_AGENT_STATE_DIR — NEVER the operator's
 * @param {string} [o.workspace]     ATOMIC_AGENT_WORKSPACE — the agent's cwd
 * @param {object} [o.env]           extra environment
 * @param {boolean} [o.verbose=true] narrate every click to stdout
 * @param {number} [o.settle=260]    ms to let the renderer repaint after input
 */
export async function launch(o) {
  if (!o || !o.port) throw new Error('launch(): a port is required (one per lane)');
  if (!o.stateDir) throw new Error('launch(): a stateDir is required — never run against the operator’s');
  const real = join(process.env.HOME || '', '.atomic-agent');
  const live = join(process.env.HOME || '', '.atomic-agent-desktop');
  if (resolve(o.stateDir) === resolve(real) || resolve(o.stateDir) === resolve(live)) {
    throw new Error(`launch(): refusing to run against ${o.stateDir} — that is real app data`);
  }
  mkdirSync(o.stateDir, { recursive: true });
  if (o.workspace) mkdirSync(o.workspace, { recursive: true });

  const electron = join(DESKTOP_DIR, 'node_modules', '.bin', 'electron');
  if (!existsSync(electron)) throw new Error(`electron missing at ${electron} — run npm install in desktop/`);
  if (!existsSync(join(DESKTOP_DIR, 'out', 'main', 'main.js'))) {
    throw new Error('desktop/out is missing — run `npm run build` in desktop/ first');
  }

  if (await portBusy(o.port)) {
    throw new Error(`port ${o.port} is already listening — another app is still up. `
      + `Find it with \`lsof -ti :${o.port}\` and kill it, or use a different port.`);
  }

  hookExit();
  /* `--user-data-dir` is NOT optional. Electron's default on macOS is
     ~/Library/Application Support/<productName>, which every checkout of
     this app shares: two driven runs (or a driven run and the operator's
     own window) then fight over one Chromium profile, and the loser's
     renderer dies with "sandboxed_renderer.bundle.js script failed to run".
     A throwaway profile inside the throwaway state dir keeps a test run
     from touching anything real, cookies and localStorage included. */
  const proc = spawn(electron, [
    '.',
    `--remote-debugging-port=${o.port}`,
    `--user-data-dir=${join(o.stateDir, '.chromium-profile')}`,
  ], {
    cwd: DESKTOP_DIR,
    detached: true,
    env: {
      ...process.env,
      ATOMIC_AGENT_STATE_DIR: o.stateDir,
      ...(o.workspace ? { ATOMIC_AGENT_WORKSPACE: o.workspace } : {}),
      ...agentBinEnv(o.stateDir),
      ...(o.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = new App(proc, o);
  LIVE.add(app);
  proc.stdout.on('data', (b) => app._out.push(String(b)));
  proc.stderr.on('data', (b) => app._out.push(String(b)));
  proc.on('exit', () => LIVE.delete(app));

  await app.connect(o.launchTimeout ?? 60000);
  app.log(`launched: state=${o.stateDir}${o.workspace ? ` workspace=${o.workspace}` : ''} cdp=${o.port}`);
  return app;
}

export { sleep };
