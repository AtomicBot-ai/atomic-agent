/**
 * L15: the terminal interface does a real job in a real terminal.
 *
 * The person: someone who runs `atag` in a terminal rather than the desktop.
 * The human result: they type a request, the agent stops and asks before
 * writing, they answer with Ctrl+Y, the file is on disk, the reply is on the
 * screen, and /quit gives their shell back in a sane state.
 * The bug it catches: the TUI not drawing on a real tty, keystrokes not
 * reaching the composer, the approval not gating the write or not answering
 * to its chord, the write not landing, or the terminal left in the alternate
 * screen with mouse reporting on.
 *
 * No Electron here. `dist/cli/index.js tui` runs on a pseudo-terminal
 * (pseudo-terminal.mjs), whose stdin and stdout are the keyboard and the
 * screen. The terminal starts with no size, so the inner shell sets one before
 * the agent starts.
 *
 * The model is `startScriptedModel`, set up as live-harness.mjs does for the
 * desktop. That file's config and environment helpers are private to it, so
 * the few lines that build them are repeated below and must follow it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_DIR, sleep } from '../drive.mjs';
import { Failure, SCENARIO_NAME, check, main } from '../harness.mjs';
import { assertThrowawayStateDir } from '../state-guard.mjs';
import { SCRIPT_BIN, spawnOnPseudoTerminal } from './pseudo-terminal.mjs';
import { call, reply, startScriptedModel } from './scripted-model.mjs';

const AGENT_ENTRY = join(REPO_DIR, 'dist', 'cli', 'index.js');
const AGENT_SCHEMA = join(REPO_DIR, 'dist', 'config', 'config-schema.js');
const LIVE_ROOT = process.env.ATAG_LIVE_DIR || join(tmpdir(), 'atag-live-scenarios');
const KEEP = process.env.ATAG_LIVE_KEEP === '1';

const COLS = 130;
const ROWS = 45;
const FILE = 'live-tui-note.txt';
const FIRST_LINE = 'heron-quay-tui-4418';
const CONTENT = `${FIRST_LINE}\nsecond line\n`;
const PROMPT = `Please save a note called ${FILE} here.`;
const REPLY = 'The terminal note is saved.';
/* What os.fs.write reports back (src/tools/os/fs/fs-write.ts). */
const WROTE = `wrote ${CONTENT.length} bytes to`;
/* Ctrl+Y: APPROVAL_CHORDS.approve in src/tui/app-key-bindings.ts. */
const CTRL_Y = '\x19';
const ENTER = '\r';
const LEFTOVER_GRACE_MS = 5000;

/* ------------------------------------------------------- reading output -- */
/** The raw byte stream as plain text: every escape sequence removed. */
export function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => (c === '\r' ? '' : ' '));
}

/**
 * What a person sees right now. Ink redraws by moving the cursor and erasing
 * lines, so text with the escapes stripped is every frame ever drawn run
 * together, and "the card is gone" could never be asserted on it. This keeps
 * the character grid those moves produce. Wide glyphs count as one column,
 * which only shifts what comes after them on that row.
 */
class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.rest = '';
    this.clear();
  }

  clear() {
    this.grid = Array.from({ length: this.rows }, () => new Array(this.cols).fill(' '));
    this.x = 0;
    this.y = 0;
  }

  lineFeed() {
    if (this.y < this.rows - 1) { this.y += 1; return; }
    this.grid.shift();
    this.grid.push(new Array(this.cols).fill(' '));
  }

  put(ch) {
    if (/\p{M}|‍|️/u.test(ch)) return;
    if (this.x >= this.cols) { this.x = 0; this.lineFeed(); }
    this.grid[this.y][this.x] = ch;
    this.x += 1;
  }

  move(x, y) {
    this.x = Math.max(0, Math.min(this.cols - 1, x));
    this.y = Math.max(0, Math.min(this.rows - 1, y));
  }

  erase(rows, from, to) {
    for (const r of rows) this.grid[r].fill(' ', from, to);
  }

  csi(params, final) {
    const nums = params.replace(/^[?>=]/, '').split(';').map((p) => (p === '' ? NaN : Number(p)));
    const n = Number.isNaN(nums[0]) || nums[0] === undefined ? 1 : nums[0];
    const zero = Number.isNaN(nums[0]) ? 0 : nums[0];
    const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
    switch (final) {
      case 'A': this.move(this.x, this.y - n); break;
      case 'B': this.move(this.x, this.y + n); break;
      case 'C': this.move(this.x + n, this.y); break;
      case 'D': this.move(this.x - n, this.y); break;
      case 'E': this.move(0, this.y + n); break;
      case 'F': this.move(0, this.y - n); break;
      case 'G': this.move(n - 1, this.y); break;
      case 'd': this.move(this.x, n - 1); break;
      case 'H': case 'f': this.move((Number.isNaN(nums[1]) || nums[1] === undefined ? 1 : nums[1]) - 1, n - 1); break;
      case 'J':
        if (zero === 0) { this.erase([this.y], this.x, this.cols); this.erase(range(this.y + 1, this.rows), 0, this.cols); }
        else if (zero === 1) { this.erase(range(0, this.y), 0, this.cols); this.erase([this.y], 0, this.x + 1); }
        else this.erase(range(0, this.rows), 0, this.cols);
        break;
      case 'K':
        if (zero === 0) this.erase([this.y], this.x, this.cols);
        else if (zero === 1) this.erase([this.y], 0, this.x + 1);
        else this.erase([this.y], 0, this.cols);
        break;
      case 'h': case 'l':
        if (params === '?1049') this.clear();
        break;
      default: break; // colours and modes do not move text
    }
  }

  feed(chunk) {
    const text = this.rest + chunk;
    this.rest = '';
    let at = 0;
    while (at < text.length) {
      const c = text[at];
      if (c !== '\x1b') {
        const point = String.fromCodePoint(text.codePointAt(at));
        at += point.length;
        if (point === '\r') this.x = 0;
        else if (point === '\n') this.lineFeed();
        else if (point === '\b') this.x = Math.max(0, this.x - 1);
        else if (point >= ' ' && point !== '\x7f') this.put(point);
        continue;
      }
      const tail = text.slice(at);
      const seq = /^\x1b\[([0-?]*)[ -/]*([@-~])/.exec(tail);
      if (seq) { this.csi(seq[1], seq[2]); at += seq[0].length; continue; }
      const other = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(tail) ?? /^\x1b[ -/]*[0-Z\\^-~]/.exec(tail);
      if (other) { at += other[0].length; continue; }
      this.rest = tail; // cut off mid-sequence: the next chunk has the end
      return;
    }
  }

  text() {
    return this.grid.map((row) => row.join('').trimEnd()).join('\n');
  }

  /** The text with spaces, line breaks and box borders gone, for matching
      something the layout may have wrapped. */
  flat() {
    return flat(this.text());
  }
}

const flat = (s) => s.replace(/[\s─-╿]/g, '');

/* ------------------------------------------------------------- terminal -- */
class Terminal {
  constructor(child, screen) {
    this.child = child;
    this.screen = screen;
    this.raw = '';
    this.exited = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { this.raw += d; screen.feed(d); });
    child.stderr.on('data', (d) => { this.raw += d; });
    child.stdin.on('error', () => { /* the terminal went away; the waits report it */ });
    child.once('close', () => { this.exited = true; });
  }

  async until(test, what, timeout = 30000) {
    const stop = Date.now() + timeout;
    for (;;) {
      if (test()) return;
      if (this.exited) throw new Failure(`the terminal program ended while waiting for ${what}\n${this.screen.text()}`);
      if (Date.now() > stop) throw new Failure(`gave up after ${timeout}ms waiting for ${what}\n     the screen says:\n${this.screen.text()}`);
      await sleep(50);
    }
  }

  /** One key at a time, so the app reads keystrokes and not a paste. */
  async type(text) {
    for (const ch of text) {
      this.child.stdin.write(ch);
      await sleep(8);
    }
    await sleep(250);
  }

  press(key) {
    this.child.stdin.write(key);
  }

  async kill() {
    if (this.exited) return;
    const group = (sig) => { try { process.kill(-this.child.pid, sig); } catch { /* already gone */ } };
    group('SIGTERM');
    for (let i = 0; i < 30 && !this.exited; i += 1) await sleep(100);
    group('SIGKILL');
    for (let i = 0; i < 20 && !this.exited; i += 1) await sleep(100);
  }
}

/* ----------------------------------------------------------------- stand -- */
function standProblem() {
  if (process.platform !== 'darwin') return 'this scenario gets its pseudo-terminal from the macOS script(1)';
  if (!existsSync(SCRIPT_BIN)) return `${SCRIPT_BIN} is missing`;
  if (!existsSync(AGENT_ENTRY) || !existsSync(AGENT_SCHEMA)) {
    return `the agent is not built here (no ${AGENT_ENTRY}): run npm run build at the repo root`;
  }
  return null;
}

function liveDirs(name) {
  mkdirSync(LIVE_ROOT, { recursive: true });
  const base = mkdtempSync(join(realpathSync(LIVE_ROOT), `${name}-`));
  const dirs = { base, stateDir: join(base, 'state'), workspace: join(base, 'workspace'), home: join(base, 'home') };
  assertThrowawayStateDir(dirs.stateDir);
  for (const d of [dirs.stateDir, dirs.workspace, dirs.home]) mkdirSync(d, { recursive: true });
  return dirs;
}

/** Keep in step with liveConfig in live-harness.mjs. */
async function liveConfig(modelUrl) {
  const { USER_CONFIG_DEFAULTS } = await import(pathToFileURL(AGENT_SCHEMA).href);
  const config = structuredClone(USER_CONFIG_DEFAULTS);
  config.localModels.mode = 'external';
  config.localModels.url = modelUrl;
  config.localModels.useServerTemplate = 'off';
  config.localModels.embeddings.enabled = false;
  config.agent.approvalLevel = 1;
  config.analytics.enabled = false;
  for (const feature of Object.values(config.memory)) {
    if (feature && typeof feature === 'object' && 'enabled' in feature) feature.enabled = false;
  }
  config.tui = { ...config.tui, onboarding: { ...config.tui?.onboarding, completedAt: new Date().toISOString() } };
  return config;
}

/* Same list as liveEnv, plus what would change how the terminal is drawn:
   Ink stops drawing frames when it believes it is in CI. */
const STRIP = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ATOMIC_|^XDG_(CONFIG|DATA|CACHE|STATE)_HOME$|^CI$|^CI_|^CONTINUOUS_INTEGRATION$|^TMUX|^HERDR/i;

function terminalEnv(dirs) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !STRIP.test(key)));
  return {
    ...env,
    HOME: dirs.home,
    TERM: 'xterm-256color',
    ATOMIC_AGENT_STATE_DIR: dirs.stateDir,
    ATOMIC_AGENT_ANALYTICS: 'off',
    DO_NOT_TRACK: '1',
    ATOMIC_AGENT_GRAMMARS_DIR: join(REPO_DIR, 'grammars'),
    ATOMIC_AGENT_BROWSER_ENABLED: 'false',
    ATOMIC_AGENT_LLAMA_COMPLETION_RETRIES: '0',
    ATOMIC_AGENT_LLAMA_HEALTH_RETRIES: '0',
  };
}

/** Start the TUI. The exit code goes to a file because what script(1) itself
    exits with is not something to rely on. */
function openTerminal(dirs) {
  const q = JSON.stringify;
  const inner = join(dirs.base, 'tui.sh');
  const exitFile = join(dirs.base, 'tui-exit-code');
  /* --diagnostic-dir does nothing except put this run's temp path on the
     command line, so the sweep below can find the process. */
  writeFileSync(inner, `#!/bin/sh\nstty rows ${ROWS} cols ${COLS}\n`
    + `${q(process.execPath)} --enable-source-maps --diagnostic-dir=${q(dirs.base)} ${q(AGENT_ENTRY)} tui --cwd ${q(dirs.workspace)}\n`
    + `echo $? > ${q(exitFile)}\n`);
  const child = spawnOnPseudoTerminal(['/bin/sh', inner], { cwd: dirs.workspace, env: terminalEnv(dirs) });
  return { term: new Terminal(child, new Screen(COLS, ROWS)), exitFile };
}

function processesCarrying(path) {
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter((m) => m && m[2].includes(path))
    .map((m) => ({ pid: Number(m[1]), command: m[2] }))
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid);
}

async function sweep(base) {
  const until = Date.now() + LEFTOVER_GRACE_MS;
  let left = processesCarrying(base);
  while (left.length && Date.now() < until) {
    await sleep(200);
    left = processesCarrying(base);
  }
  for (const p of left) {
    try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return left;
}

/* -------------------------------------------------------------- the story -- */
async function story({ term, exitFile }, model, { workspace }) {
  const screen = term.screen;
  const target = join(workspace, FILE);
  model.script([
    call('os.fs.write', { path: FILE, content: CONTENT, mode: 'replace' }),
    reply(REPLY),
  ]);

  // ---- it draws, and it takes typing ---------------------------------------
  await term.until(() => screen.flat().includes('send→'), 'the composer to be drawn', 60000);
  check(term.raw.includes('\x1b[?1049h'), 'the interface took over the terminal with the alternate screen');
  check(!/needs an interactive terminal/.test(stripAnsi(term.raw)), 'the agent accepted this as a real terminal');

  await term.type(PROMPT);
  await term.until(() => screen.flat().includes(flat(PROMPT)), 'what I typed to show in the composer');
  term.press(ENTER);

  // ---- the question comes up and holds the write back ----------------------
  await term.until(() => /approval required/.test(screen.text()), 'the approval prompt');
  const asked = screen.text();
  const askedFlat = screen.flat();
  console.log(`   the prompt on screen:\n${asked.split('\n').filter((l) => l.trim()).map((l) => `     ${l}`).join('\n')}`);
  check(askedFlat.includes('os.fs.write'), 'the prompt names the tool', asked);
  check(askedFlat.includes(FILE), 'the prompt names the file it is asking about', asked);
  check(askedFlat.includes(FIRST_LINE), 'the prompt shows what would be written', asked);
  check(askedFlat.includes('ctrl+y') && askedFlat.includes('ctrl+d'), 'the prompt says how to approve and how to deny', asked);

  await sleep(1200);
  check(!existsSync(target), 'the file does not exist while the prompt is up', `${target} already exists`);
  check(model.agentRequests.length === 1, 'the model is not called again while the prompt is up',
    `${model.agentRequests.length} agent requests so far`);

  // ---- a real chord releases it --------------------------------------------
  term.press(CTRL_Y);
  await term.until(() => screen.flat().includes(flat(REPLY)), 'the reply on the screen');
  check(!/approval required/.test(screen.text()), 'the prompt is gone once answered', screen.text());

  // ---- the world ------------------------------------------------------------
  check(existsSync(target), 'the file exists after I approved it', `${target} is missing`);
  const body = readFileSync(target, 'utf8');
  check(body === CONTENT, `${FILE} holds exactly what the tool was given`, JSON.stringify(body));
  const [first, second] = model.agentRequests;
  check(!!second, 'the model was called again after the tool ran');
  check(String(first.prompt).includes(FILE), 'what I typed reached the model');
  check(!String(first.prompt).includes(WROTE), 'the first request has no tool result yet');
  check(String(second.prompt).includes(WROTE), 'the tool result came back to the model',
    `the follow-up prompt ended with: ${String(second.prompt).slice(-600)}`);
  check(model.pending === 0, 'the model was asked exactly as often as scripted', `${model.pending} step(s) left`);

  // ---- it gives the terminal back -------------------------------------------
  /* The session title request goes out when the turn ends. */
  for (let i = 0; i < 30 && model.inFlight > 0; i += 1) await sleep(100);
  await term.type('/quit');
  term.press(ENTER);
  await term.until(() => term.exited, 'the program to end after /quit', 30000);
  const code = existsSync(exitFile) ? readFileSync(exitFile, 'utf8').trim() : '(no exit code recorded)';
  check(code === '0', '/quit exits cleanly', `exit code ${code}`);
  check(term.raw.lastIndexOf('\x1b[?1049l') > term.raw.lastIndexOf('\x1b[?1049h'), 'the alternate screen was left');
  check(term.raw.lastIndexOf('\x1b[?1006l') > term.raw.lastIndexOf('\x1b[?1006h'), 'mouse reporting was turned off');
}

/* --------------------------------------------------------------- runner -- */
function saveEvidence(term, model, dirs) {
  if (model) {
    writeFileSync(join(dirs.base, 'model-requests.json'), JSON.stringify({
      broken: model.broken?.message ?? null, stepsLeft: model.pending, lastRequests: model.requests.slice(-8),
    }, null, 2));
  }
  if (term) {
    writeFileSync(join(dirs.base, 'terminal-raw.log'), term.raw);
    writeFileSync(join(dirs.base, 'terminal-plain.log'), stripAnsi(term.raw));
    writeFileSync(join(dirs.base, 'terminal-last-screen.txt'), term.screen.text());
  }
}

export async function run() {
  const name = SCENARIO_NAME(import.meta.url);
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n> ${name}`);
  const notReady = standProblem();
  if (notReady) return { name, ok: true, skipped: notReady, notReady: true, secs: '0' };

  let dirs = null;
  let model = null;
  let opened = null;
  let error = null;
  try {
    dirs = liveDirs(name);
    console.log(`   run directory ${dirs.base}`);
    model = await startScriptedModel();
    writeFileSync(join(dirs.stateDir, 'config.json'), JSON.stringify(await liveConfig(model.url), null, 2), { mode: 0o600 });
    opened = openTerminal(dirs);
    await Promise.race([story(opened, model, dirs), model.whenBroken]);
    if (model.broken) throw model.broken;
  } catch (e) {
    error = e;
    console.log(`   FAILED after ${secs()}s: ${e.message}`);
    if (dirs) {
      try { saveEvidence(opened?.term, model, dirs); } catch (s) { console.log(`   could not save evidence: ${s.message}`); }
    }
  } finally {
    if (opened) await opened.term.kill();
    if (model) await model.close().catch((e) => console.log(`   closing the model: ${e.message}`));
  }

  if (dirs) {
    const left = await sweep(dirs.base);
    if (left.length) {
      const list = left.map((p) => `${p.pid} ${p.command.slice(0, 120)}`).join('\n     ');
      console.log(`   still running after the terminal closed, now killed:\n     ${list}`);
      error ??= new Failure(`${left.length} process(es) were still running after /quit: ${left[0].command.slice(0, 120)}`);
    }
    if (error) console.log(`   kept for inspection: ${dirs.base}`);
    else if (!KEEP) rmSync(dirs.base, { recursive: true, force: true });
  }
  return error ? { name, ok: false, error: error.message, secs: secs() } : { name, ok: true, secs: secs() };
}

if (import.meta.url === `file://${process.argv[1]}`) main(run());
