/**
 * live-harness.mjs: run one live smoke scenario.
 *
 * Real Electron window, real `atag serve` built from this checkout, real
 * tools, real clicks and real files. Only the model is scripted.
 *
 * It sits beside harness.mjs rather than inside it because harness.mjs
 * `scenario()` needs a cloud key and walks the cloud wizard. The helpers a
 * scenario uses (`ask`, `waitTurn`, `check`) still come from there.
 *
 * Nothing here reaches into the running app. The state is seeded before the
 * window opens, which the header of harness.mjs allows, and everything after
 * that is drive.mjs clicking.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DESKTOP_DIR, REPO_DIR, launch, sleep } from '../drive.mjs';
import { Failure, read, write } from '../harness.mjs';
import { startScriptedModel } from './scripted-model.mjs';

export const LIVE_PORT = Number(process.env.ATAG_LIVE_PORT || 9414);
const LIVE_ROOT = process.env.ATAG_LIVE_DIR || join(tmpdir(), 'atag-live-scenarios');
const KEEP = process.env.ATAG_LIVE_KEEP === '1';
const LEFTOVER_GRACE_MS = 5000;
const EVIDENCE_REQUESTS = 8;

const AGENT_ENTRY = join(REPO_DIR, 'dist', 'cli', 'index.js');
const AGENT_SCHEMA = join(REPO_DIR, 'dist', 'config', 'config-schema.js');

/** Why this machine cannot run the tier, or null. Reported as a SKIP. */
function standProblem() {
  if (!existsSync(AGENT_ENTRY) || !existsSync(AGENT_SCHEMA)) {
    return `the agent is not built here (no ${AGENT_ENTRY}): run npm run build at the repo root`;
  }
  if (!existsSync(join(DESKTOP_DIR, 'node_modules', '.bin', 'electron'))) return 'electron is missing: run npm install in desktop/';
  if (!existsSync(join(DESKTOP_DIR, 'out', 'main', 'main.js'))) return 'desktop/out is missing: run npm run build in desktop/';
  return null;
}

/* ------------------------------------------------------- throwaway dirs -- */
const onCaseless = (p) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);

/** Throw if `base` is, or sits inside, somewhere that holds real data. */
function assertThrowaway(base) {
  const homes = [...new Set([process.env.HOME, homedir()].filter(Boolean))];
  const real = homes.flatMap((h) => [join(h, '.atomic-agent'), join(h, '.atomic-agent-desktop'),
    join(h, 'Library', 'Application Support', 'Atomic Agent')]);
  const mine = onCaseless(resolve(base));
  for (const r of real.flatMap((p) => [p, existsSync(p) ? realpathSync(p) : p])) {
    const theirs = onCaseless(resolve(r));
    if (mine === theirs || mine.startsWith(theirs + sep)) throw new Error(`refusing to use real app data: ${base}`);
  }
  if (homes.some((h) => onCaseless(resolve(h)) === mine)) throw new Error(`refusing to use the real home directory: ${base}`);
}

/**
 * A new directory for one run. The name is unique, so nothing that existed
 * before is ever reused or removed. Symlinks are resolved up front because on
 * macOS the temp dir is itself a symlink, and the app reports real paths.
 */
function liveDirs(name) {
  mkdirSync(LIVE_ROOT, { recursive: true });
  const base = mkdtempSync(join(realpathSync(LIVE_ROOT), `${name}-`));
  assertThrowaway(base);
  const dirs = { base, stateDir: join(base, 'state'), workspace: join(base, 'workspace'), home: join(base, 'home') };
  for (const d of [dirs.stateDir, dirs.workspace, dirs.home]) mkdirSync(d, { recursive: true });
  return dirs;
}

/* --------------------------------------------------------- what is seeded -- */
/**
 * The agent's own defaults from this build, changed only as far as needed:
 * the external llama route aimed at the scripted server, so nothing managed
 * is downloaded or started, and first run marked done, so no wizard.
 * The default `llm` block is derived from localModels, as in smoke-e2e.mjs.
 */
async function liveConfig(modelUrl) {
  const { USER_CONFIG_DEFAULTS } = await import(pathToFileURL(AGENT_SCHEMA).href);
  const config = structuredClone(USER_CONFIG_DEFAULTS);
  config.localModels.mode = 'external';
  config.localModels.url = modelUrl;
  /* The agent would otherwise ask the server to render its chat template.
     Off, every prompt is the agent's own text and one fewer request exists. */
  config.localModels.useServerTemplate = 'off';
  config.localModels.embeddings.enabled = false;
  config.agent.approvalLevel = 1;
  config.analytics.enabled = false;
  /* Memory features make model calls of their own between turns. */
  for (const feature of Object.values(config.memory)) {
    if (feature && typeof feature === 'object' && 'enabled' in feature) feature.enabled = false;
  }
  config.tui = { ...config.tui, onboarding: { ...config.tui?.onboarding, completedAt: new Date().toISOString() } };
  return config;
}

/**
 * Always the agent from this checkout. The Node flag does nothing except put
 * this run's temp path on the command line of `atag serve`, because the
 * leftover sweep below finds processes by that path.
 */
function writeAgentShim(base) {
  const shim = join(base, 'atag-live.sh');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --enable-source-maps `
    + `--diagnostic-dir=${JSON.stringify(base)} ${JSON.stringify(AGENT_ENTRY)} "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

/* Secrets and agent settings the operator's shell may be carrying. */
const STRIP = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ATOMIC_|^XDG_(CONFIG|DATA|CACHE|STATE)_HOME$/i;
/* Set by drive.mjs in an earlier layer of the launch environment. */
const LEAVE = new Set(['ATOMIC_AGENT_WORKSPACE']);

/**
 * The launch environment. `undefined` removes a variable: Node's spawn drops
 * undefined values, and drive.mjs merges this over process.env.
 */
function liveEnv(dirs, shim, extra) {
  const stripped = {};
  for (const key of Object.keys(process.env)) if (STRIP.test(key) && !LEAVE.has(key)) stripped[key] = undefined;
  return {
    ...stripped,
    HOME: dirs.home,
    ATOMIC_AGENT_BIN: shim,
    ATOMIC_AGENT_ANALYTICS: 'off',
    DO_NOT_TRACK: '1', // the kill switch the desktop's own main process reads
    ATOMIC_AGENT_GRAMMARS_DIR: join(REPO_DIR, 'grammars'),
    ATOMIC_AGENT_BROWSER_ENABLED: 'false',
    ATOMIC_AGENT_LLAMA_COMPLETION_RETRIES: '0',
    ATOMIC_AGENT_LLAMA_HEALTH_RETRIES: '0',
    ...extra,
  };
}

/* -------------------------------------------------------------- process -- */
/** Live processes whose command line contains `path`, never this one. */
function processesCarrying(path) {
  if (process.platform === 'win32') return [];
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter((m) => m && m[2].includes(path))
    .map((m) => ({ pid: Number(m[1]), command: m[2] }))
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid);
}

/**
 * Give what is still running a moment to end, then kill it. Only processes
 * carrying this run's unique temp path are touched. Returns those worth
 * reporting; Chromium's crash handler exits on its own timetable and is noise.
 */
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
  return left.filter((p) => !/crashpad_handler/.test(p.command));
}

/* --------------------------------------------------------------- runner -- */
/** The window is up, the agent has reported in and a message can be sent. */
async function waitReady(app) {
  await app.waitFor(`!!document.querySelector('#entry')`, 'the composer', { timeout: 90000 });
  await app.waitFor(`!!document.querySelector('.cmodechip[data-id]:not([data-id=""])')`,
    'the Mode chip, once the agent has reported its stance', { timeout: 90000 });
  if (await app.eval(`!!document.querySelector('#onboarding')`)) {
    throw new Failure('the first-run wizard opened even though the seeded config marks it done');
  }
  await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the send button live', { timeout: 60000 });
}

function saveEvidence(app, model, dirs) {
  if (model) {
    const file = join(dirs.base, 'model-requests.json');
    writeFileSync(file, JSON.stringify({ broken: model.broken?.message ?? null, stepsLeft: model.pending,
      other: model.other, lastRequests: model.requests.slice(-EVIDENCE_REQUESTS) }, null, 2));
    console.log(`   last model requests: ${file}`);
  }
  if (app) {
    const file = join(dirs.base, 'app-output.log');
    writeFileSync(file, app.output());
    console.log(`   app output: ${file}`);
  }
}

/**
 * Run one scenario. `body` gets `{ app, model, base, stateDir, workspace,
 * home, write, read }`.
 *
 * `setup({ ...dirs, model, config })` runs before the window opens. It may
 * change `config` before it is written, drop files in the workspace, and
 * return extra environment for the launch. Returns `{ name, ok, secs }` plus
 * `skipped` or `error`.
 */
export async function liveScenario(name, body, { setup, skip = null } = {}) {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n> ${name}`);
  if (skip) return { name, ok: true, skipped: skip, secs: '0' };
  const notReady = standProblem();
  if (notReady) return { name, ok: true, skipped: notReady, notReady: true, secs: '0' };

  let dirs = null;
  let model = null;
  let app = null;
  let error = null;
  try {
    dirs = liveDirs(name);
    console.log(`   run directory ${dirs.base}`);
    model = await startScriptedModel();
    const config = await liveConfig(model.url);
    const extra = setup ? await setup({ ...dirs, model, config }) : null;
    writeFileSync(join(dirs.stateDir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
    const shim = writeAgentShim(dirs.base);
    app = await launch({ port: LIVE_PORT, stateDir: dirs.stateDir, workspace: dirs.workspace,
      env: liveEnv(dirs, shim, extra) });
    await waitReady(app);
    await Promise.race([body({ app, model, ...dirs, write, read }), model.whenBroken]);
    if (model.broken) throw model.broken;
    if (model.pending) throw new Failure(`${model.pending} scripted step(s) were never asked for`);
  } catch (e) {
    error = e;
    console.log(`   FAILED after ${secs()}s: ${e.message}`);
    if (dirs) {
      if (app) {
        try { await app.screenshot(join(dirs.base, 'failure.png')); } catch { /* the window may be gone */ }
      }
      try { saveEvidence(app, model, dirs); } catch (s) { console.log(`   could not save evidence: ${s.message}`); }
    }
  } finally {
    if (app) await app.close().catch((e) => console.log(`   closing the app: ${e.message}`));
    if (model) await model.close().catch((e) => console.log(`   closing the model: ${e.message}`));
  }

  if (dirs) {
    const left = await sweep(dirs.base);
    if (left.length) {
      const list = left.map((p) => `${p.pid} ${p.command}`).join('\n     ');
      console.log(`   still running after the app closed, now killed:\n     ${list}`);
      error ??= new Failure(`${left.length} process(es) were still running after the app closed: ${left[0].command}`);
    }
    if (error) console.log(`   kept for inspection: ${dirs.base}`);
    else if (!KEEP) rmSync(dirs.base, { recursive: true, force: true });
  }
  return error ? { name, ok: false, error: error.message, secs: secs() } : { name, ok: true, secs: secs() };
}
