/**
 * L08: a plugin hook really guards a tool.
 *
 * The person: someone who installed a plugin whose hooks refuse writes to
 * certain files and keep a log of finished writes.
 *
 * The human result: until they allow the plugin's code in Settings › Plugins
 * its hooks do nothing. Once allowed, a forbidden write is stopped before any
 * approval card, no file appears, and the model is told why. An allowed write
 * goes through and leaves the hook's marker. Switching the PreToolUse part off
 * by clicking stops that hook and leaves the other one running.
 *
 * What would make it fail: a hook that runs without consent or after being
 * switched off; a deny that still writes the file or that the model never
 * hears about; a PostToolUse hook that never fires, or one that fires for a
 * call that was refused.
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { REPO_DIR } from '../drive.mjs';
import { Failure, SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

const run_ = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ENTRY = join(REPO_DIR, 'dist', 'cli', 'index.js');

const NAME = 'live-guard';
const CONTENT = 'guarded bytes\n';
const REASON = 'tern-gate-5521';
/* What a refused call reports (hookRefusal, src/hooks/hook-engine.ts). */
const REFUSED = 'os.fs.write was not run: a PreToolUse hook blocked it';
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500, approve: 'none' };

const write = (path) => call('os.fs.write', { path, content: CONTENT, mode: 'replace' });
const pluginRecord = (stateDir) => JSON.parse(readFileSync(join(stateDir, 'plugins', 'plugins.json'), 'utf8')).plugins[NAME];
/* One JSON document per line, exactly what the hook read on stdin. */
const logOf = (workspace, name) => {
  const file = join(workspace, '.hook-marks', name);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Failure(`gave up after ${ms}ms waiting for ${what}`);
    await sleep(150);
  }
}

async function openPluginsPane(app) {
  await app.clickSel('.sb-settings');
  await app.clickSel('button.setrow[data-act="settings:plugins"]');
  await app.waitFor(`[...document.querySelectorAll('.set-plgrow')].some((r) => r.textContent.includes(${JSON.stringify(NAME)}))`,
    'the plugin listed in Settings › Plugins', { timeout: 30000 });
}

/** One write the scripted model asks for, up to the point the app answers. */
async function askForWrite(app, model, path) {
  model.script([write(path), reply(`Finished with ${path}.`)]);
  const from = model.agentRequests.length;
  await ask(app, `Please write the note ${path}.`);
  return { from, turn: await waitTurn(app, TURN) };
}

/** Answer the card that must be up, and let the turn finish. */
async function allowCard(app) {
  await app.clickText('Allow once', { scope: '#apprcard' });
  return waitTurn(app, TURN);
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, stateDir, workspace }) => {
  const at = (file) => join(workspace, file);
  const pre = () => logOf(workspace, 'pre.log');
  const post = () => logOf(workspace, 'post.log');

  // ---- not consented: the hooks must not run -------------------------------
  const free = await askForWrite(app, model, 'forbidden-before-consent.txt');
  check(free.turn.pending, 'with the code off the write reaches the normal approval card');
  const freeDone = await allowCard(app);
  check(!freeDone.pending, 'nothing else was put to me to approve');
  check(existsSync(at('forbidden-before-consent.txt')), 'without consent the guard did not stop the write');
  check(pre().length === 0, 'the PreToolUse hook did not run without consent', JSON.stringify(pre()));
  check(post().length === 0, 'the PostToolUse hook did not run without consent', JSON.stringify(post()));

  // ---- consent, by clicking --------------------------------------------------
  await openPluginsPane(app);
  await app.clickSel(`[data-act="plugins:expand:${NAME}"]`);
  await app.clickSel(`[data-act="plugins:code:${NAME}"]`);
  await app.clickSel('[data-act="plugins:codeConfirm"]');
  await until(() => pluginRecord(stateDir).runsCodeAccepted === true, 'the consent saved in plugins.json');
  await app.clickSel('[data-act="settings:close"]');

  // ---- the deny ---------------------------------------------------------------
  const denied = await askForWrite(app, model, 'forbidden-after-consent.txt');
  check(!denied.turn.pending, 'the hook refused before any approval card came up');
  check(!existsSync(at('forbidden-after-consent.txt')), 'the refused file was not created');
  check(pre().length === 1, 'the PreToolUse hook ran once', `${pre().length} runs`);
  check(pre()[0].tool_name === 'Write' && pre()[0].atomic_tool_name === 'os.fs.write', 'the hook was told which tool', JSON.stringify(pre()[0]));
  check(pre()[0].tool_input.file_path === 'forbidden-after-consent.txt', 'the hook was told which file', JSON.stringify(pre()[0].tool_input));
  check(post().length === 0, 'PostToolUse did not fire for a call that never ran', JSON.stringify(post()));
  const [asked, told] = model.agentRequests.slice(denied.from);
  check(!String(asked.prompt).includes('forbidden-after-consent.txt was not') && !!told, 'the model was called again after the refusal');
  const toldPrompt = String(told.prompt);
  check(toldPrompt.includes(REFUSED), 'the model is told a hook blocked the call', `the prompt ended with: ${toldPrompt.slice(-600)}`);
  check(toldPrompt.includes(REASON), 'the model is told the hook\'s own reason', `the prompt ended with: ${toldPrompt.slice(-600)}`);

  // ---- an allowed write, and the marker ----------------------------------------
  const allowed = await askForWrite(app, model, 'allowed-note.txt');
  check(allowed.turn.pending, 'a hook that says nothing leaves the normal approval card in place');
  check(post().length === 0, 'PostToolUse waits for the call to finish');
  const allowedDone = await allowCard(app);
  check(!allowedDone.pending, 'nothing else was put to me to approve');
  check(readFileSync(at('allowed-note.txt'), 'utf8') === CONTENT, 'the allowed file holds what the tool was given');
  check(post().length === 1, 'the PostToolUse hook left its marker', `${post().length} lines`);
  check(post()[0].tool_name === 'Write' && post()[0].tool_input.file_path === 'allowed-note.txt', 'the marker is about this call', JSON.stringify(post()[0]));
  check(post()[0].tool_response?.status === 'ok', 'the marker carries the result', JSON.stringify(post()[0].tool_response));

  // ---- switched off, by clicking ----------------------------------------------
  const preRuns = pre().length;
  await openPluginsPane(app);
  if (!(await app.eval(`!!document.querySelector('[data-act="plugins:part:${NAME}:hook:PreToolUse"]')`))) {
    await app.clickSel(`[data-act="plugins:expand:${NAME}"]`);
  }
  await app.clickSel(`[data-act="plugins:part:${NAME}:hook:PreToolUse"]`);
  await until(() => (pluginRecord(stateDir).disabledParts ?? []).includes('hook:PreToolUse'), 'the part saved as off in plugins.json');
  await app.clickSel('[data-act="settings:close"]');

  const off = await askForWrite(app, model, 'forbidden-while-off.txt');
  check(off.turn.pending, 'with the guard off the write reaches the normal approval card');
  const offDone = await allowCard(app);
  check(!offDone.pending, 'nothing else was put to me to approve');
  check(existsSync(at('forbidden-while-off.txt')), 'the switched-off hook did not stop the write');
  check(pre().length === preRuns, 'the switched-off hook did not run', `${pre().length} runs, was ${preRuns}`);
  check(post().length === 2, 'the hook still switched on kept firing', `${post().length} lines`);
  check(model.pending === 0, 'the model was asked exactly as often as scripted', `${model.pending} step(s) left`);
}, {
  setup: async ({ base, stateDir, workspace, home }) => {
    const source = join(base, 'guard-plugin');
    cpSync(join(HERE, 'fixtures', 'plugins', NAME), source, { recursive: true });
    const STRIP = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ATOMIC_|^XDG_(CONFIG|DATA|CACHE|STATE)_HOME$/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k)));
    /* Without a terminal nobody can be asked, so the code stays off. */
    const { stdout } = await run_(process.execPath, [AGENT_ENTRY, 'plugin', 'install', source], { cwd: workspace,
      encoding: 'utf8', timeout: 60000,
      env: { ...env, HOME: home, ATOMIC_AGENT_STATE_DIR: stateDir, ATOMIC_AGENT_ANALYTICS: 'off', DO_NOT_TRACK: '1' } });
    console.log(`   atag plugin install: ${stdout.trim().replace(/\n/g, ' | ')}`);
    check(stdout.includes(`Installed ${NAME}@1.0.0`), 'the CLI installed the plugin', stdout);
    check(/Those parts are off/.test(stdout), 'the CLI says the hooks are off', stdout);
    check(pluginRecord(stateDir).runsCodeAccepted !== true, 'installing did not grant code consent');
    return null;
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
