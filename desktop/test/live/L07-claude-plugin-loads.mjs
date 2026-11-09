/**
 * L07: a Claude-format plugin really loads, and really goes away.
 *
 * The person: someone who has a plugin folder written for Claude Code, with a
 * skill, a slash command and a local MCP server.
 *
 * The human result: they install it with `atag plugin install`, the program
 * inside it stays off until they say yes in Settings › Plugins, the model is
 * offered the skill, `/a-live-kit:shout words` sends the model the template
 * with the words filled in, and the trash button takes all of it away.
 *
 * What would make it fail: the skill never reaching the prompt; the MCP server
 * starting before consent, or not starting after it; `$ARGUMENTS` going to the
 * model unfilled; Remove leaving the files, the record, the skill, the tool or
 * the running server behind.
 *
 * The command is typed into the real terminal app. The desktop does not run
 * plugin commands (src/plugins/docs/plugin-format.md), so the terminal is the
 * only place a person can run one today.
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { REPO_DIR } from '../drive.mjs';
import { Failure, SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { spawnOnPseudoTerminal } from './pseudo-terminal.mjs';
import { reply } from './scripted-model.mjs';

const run_ = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ENTRY = join(REPO_DIR, 'dist', 'cli', 'index.js');

/* The catalog is sorted and cut off by a budget, so the name sorts first. */
const NAME = 'a-live-kit';
const SKILL = `${NAME}:moray-check`;
const SKILL_MARK = 'heron-slate-2208';
const TOOL = 'live_ping_4471';
const COMMAND_ARGS = 'pelican-ledger-903 second-word';
const RENDERED = 'Run the shout check on: pelican-ledger-903 second-word (first word: pelican-ledger-903).';
const FRONTMATTER_MARK = 'quiet-frontmatter-6120';
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500, approve: 'none' };

/* The environment the app gets: nothing secret, nothing pointing at real data. */
const STRIP = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ATOMIC_|^XDG_(CONFIG|DATA|CACHE|STATE)_HOME$|^CI$|^CI_|^CONTINUOUS_INTEGRATION$/i;
function cliEnv({ stateDir, home }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return { ...env, HOME: home, ATOMIC_AGENT_STATE_DIR: stateDir, ATOMIC_AGENT_ANALYTICS: 'off', DO_NOT_TRACK: '1',
    ATOMIC_AGENT_GRAMMARS_DIR: join(REPO_DIR, 'grammars'), ATOMIC_AGENT_BROWSER_ENABLED: 'false',
    ATOMIC_AGENT_LLAMA_COMPLETION_RETRIES: '0', ATOMIC_AGENT_LLAMA_HEALTH_RETRIES: '0' };
}

/** The real CLI, asynchronously so the scripted model keeps answering. */
const atag = (dirs, args) => run_(process.execPath, [AGENT_ENTRY, ...args],
  { cwd: dirs.workspace, env: cliEnv(dirs), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });

const pluginRecord = (stateDir) => JSON.parse(readFileSync(join(stateDir, 'plugins', 'plugins.json'), 'utf8')).plugins?.[NAME];
const installedDir = (stateDir) => join(stateDir, 'plugins', 'installed', NAME);
const probeLog = (stateDir) => join(stateDir, 'plugins', 'data', NAME, 'probe.log');
const bodyOf = (request) => JSON.stringify(request.body);

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Failure(`gave up after ${ms}ms waiting for ${typeof what === 'function' ? what() : what}`);
    await sleep(200);
  }
}

async function processes(pattern) {
  const { stdout } = await run_('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').map((l) => l.match(/^\s*(\d+)\s+(.*)$/)).filter((m) => m && pattern(m[2])).map((m) => Number(m[1]));
}
const serveProcesses = (base) => processes((c) => c.includes(base) && /index\.js serve\b/.test(c));

/* ---------------------------------------------------------------- window -- */
async function openPluginsPane(app) {
  await app.clickSel('.sb-settings');
  await app.clickSel('button.setrow[data-act="settings:plugins"]');
  await app.waitFor(`[...document.querySelectorAll('.set-plgrow')].some((r) => r.textContent.includes(${JSON.stringify(NAME)}))`,
    'the plugin listed in Settings › Plugins', { timeout: 30000 });
}
const rowText = (app) => app.eval(`(document.querySelector('.set-plgrow') || { innerText: '' }).innerText.replace(/\\s+/g, ' ')`);
const closeSettings = (app) => app.clickSel('[data-act="settings:close"]');

/** The Restart button in the Plugins pane, then a new `atag serve` really running. */
async function restartAgent(app, base) {
  const before = await serveProcesses(base);
  await app.clickSel('.set-plugins [data-act="agent:restart"]');
  await until(async () => {
    const now = await serveProcesses(base);
    return now.length > 0 && now.every((pid) => !before.includes(pid));
  }, 'a new agent process after the restart', 60000);
  await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the send button live after the restart', { timeout: 60000 });
}

/**
 * Just after a restart the app answers "still starting, send it again" and
 * keeps the words in the box, so a person presses Send again. Same here.
 */
async function sendOnceAgentIsUp(app, text) {
  app.repliesBefore = (await app.replies()).length;
  await app.clickSel('#entry');
  await app.type(text, { perChar: 1 });
  for (let i = 0; i < 40; i++) {
    await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the send button', { timeout: 30000, quiet: true });
    await app.clickSel('.sendbtn');
    await sleep(500);
    if ((await app.eval(`(document.querySelector('#entry') || {}).value`)) === '') return;
    await sleep(1000);
  }
  throw new Failure('the agent never took the message after the restart');
}

/* -------------------------------------------------------------- terminal -- */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P^_][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?/g;

/**
 * `atag tui` in a real pseudo-terminal. The window size is set before the app
 * starts because the terminal begins with none.
 * The temp path on the command line is what lets the harness sweep find it.
 */
function openTerminal(dirs) {
  const inner = 'stty rows 40 cols 120 2>/dev/null; exec "$0" "$@"';
  const proc = spawnOnPseudoTerminal(['/bin/sh', '-c', inner, process.execPath,
    `--diagnostic-dir=${dirs.base}`, AGENT_ENTRY, 'tui', '--cwd', dirs.workspace, '--skip-llama-setup'],
  { cwd: dirs.workspace, env: { ...cliEnv(dirs), TERM: 'xterm-256color' } });
  const t = { proc, raw: '', changedAt: Date.now() };
  const take = (chunk) => { t.raw += chunk; t.changedAt = Date.now(); };
  proc.stdout.setEncoding('utf8').on('data', take);
  proc.stderr.setEncoding('utf8').on('data', take);
  t.tail = (n = 800) => t.raw.replace(ANSI, '').slice(-n);
  t.typeSlowly = async (text) => { for (const ch of text) { proc.stdin.write(ch); await sleep(15); } };
  return t;
}

async function closeTerminal(t) {
  const signal = (s) => { try { process.kill(-t.proc.pid, s); } catch { /* already gone */ } };
  signal('SIGTERM');
  for (let i = 0; i < 30 && t.proc.exitCode === null && t.proc.signalCode === null; i++) await sleep(100);
  signal('SIGKILL');
}

/* -------------------------------------------------------------- scenario -- */
export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, base, stateDir, workspace, home }) => {
  const dirs = { base, stateDir, workspace, home };
  // ---- installed, code off ----------------------------------------------------
  model.script([reply('Noted, nothing to do.')]);
  await ask(app, 'Say hello.');
  const first = await waitTurn(app, TURN);
  check(!first.pending, 'nothing was put to me to approve');
  const before = bodyOf(model.agentRequests.at(-1));
  check(before.includes(SKILL) && before.includes(SKILL_MARK), 'the model is offered the plugin skill by its plugin:skill name',
    `the prompt ended with: ${String(model.agentRequests.at(-1).prompt).slice(-400)}`);
  check(!existsSync(probeLog(stateDir)), 'the local MCP server did not start before I agreed', probeLog(stateDir));
  check(!before.includes(TOOL), 'the model has no tool from a server that may not run');

  // ---- the consent step, by clicking --------------------------------------
  await openPluginsPane(app);
  check((await rowText(app)).includes('Code off'), 'the row says the code is off', await rowText(app));
  await app.clickSel(`[data-act="plugins:expand:${NAME}"]`);
  await app.clickSel(`[data-act="plugins:code:${NAME}"]`);
  const question = await app.waitFor(`(document.querySelector('.set-overlay') || { innerText: '' }).innerText.replace(/\\s+/g, ' ')`,
    'the Allow code question');
  app.log(`the question says: ${JSON.stringify(question)}`);
  check(/probe/.test(question), 'the question names what would run', question);
  check(pluginRecord(stateDir).runsCodeAccepted !== true, 'opening the question grants nothing');
  await app.clickSel('[data-act="plugins:codeConfirm"]');
  await until(() => pluginRecord(stateDir).runsCodeAccepted === true, 'the consent saved in plugins.json');
  await restartAgent(app, base);

  const tools = await until(() => {
    const text = existsSync(probeLog(stateDir)) ? readFileSync(probeLog(stateDir), 'utf8') : '';
    return text.includes('tools/list') ? text : null;
  }, 'the MCP server started and asked for its tools', 45000);
  app.log(`the MCP server wrote: ${JSON.stringify(tools)}`);
  await closeSettings(app);

  model.script([reply('The tool is there.')]);
  await sendOnceAgentIsUp(app, 'Anything new available?');
  const second = await waitTurn(app, TURN);
  check(!second.pending, 'nothing was put to me to approve after the restart');
  check(bodyOf(model.agentRequests.at(-1)).includes(TOOL), 'once allowed, the server\'s tool reaches the model',
    `tool ${TOOL} is in neither the prompt nor the grammar`);

  // ---- the slash command, typed in the terminal ------------------------------
  const countBefore = model.agentRequests.length;
  model.script([reply('Shout check done.')]);
  const terminal = openTerminal(dirs);
  try {
    await until(() => terminal.raw.includes('\u001b[?1049h') && Date.now() - terminal.changedAt > 1500,
      () => `the terminal app on screen; it showed: ${terminal.tail(300)}`, 60000);
    await terminal.typeSlowly('/');
    /* Opening the palette is what refreshes the plugin command list. */
    await sleep(1500);
    await terminal.typeSlowly(`${NAME}:shout ${COMMAND_ARGS}`);
    await sleep(500);
    terminal.proc.stdin.write('\r');
    await until(() => model.agentRequests.length > countBefore && model.inFlight === 0,
      () => `the model to be called by the command; the terminal showed: ${terminal.tail()}`, 45000);
  } finally {
    await closeTerminal(terminal);
  }
  const sent = String(model.agentRequests.at(-1).prompt);
  check(sent.includes(RENDERED), 'the prompt the model received has my words in the template',
    `the prompt ended with: ${sent.slice(-600)}`);
  check(!sent.includes(FRONTMATTER_MARK), 'the template\'s frontmatter is not sent to the model');

  // ---- removal ----------------------------------------------------------------
  await openPluginsPane(app);
  await app.clickSel(`[data-act="plugins:remove:${NAME}"]`);
  await app.clickSel('[data-act="plugins:removeConfirm"]');
  await until(() => !existsSync(installedDir(stateDir)), 'the plugin folder deleted');
  await until(() => pluginRecord(stateDir) === undefined, 'the plugin record gone');
  const { stdout } = await atag(dirs, ['plugin', 'list', '--json']);
  check(JSON.parse(stdout.trim().split('\n').pop()).plugins.length === 0, 'the CLI lists no plugins', stdout);

  await restartAgent(app, base);
  await closeSettings(app);
  await until(async () => (await processes((c) => c.includes(base) && c.includes('probe.mjs'))).length === 0,
    'the removed plugin\'s MCP server stopped');

  model.script([reply('Back to normal.')]);
  await sendOnceAgentIsUp(app, 'And now?');
  const last = await waitTurn(app, TURN);
  check(!last.pending, 'nothing was put to me to approve after removal');
  const after = bodyOf(model.agentRequests.at(-1));
  check(!after.includes(SKILL_MARK), 'the removed skill is no longer offered to the model');
  check(!after.includes(TOOL), 'the removed server\'s tool is no longer offered to the model');
}, {
  skip: process.platform === 'darwin' ? null : 'driving the terminal app needs the macOS script(1) pseudo-terminal',
  setup: async ({ base, stateDir, workspace, home }) => {
    /* A person's own folder, with this run's Node so the server can start
       whatever PATH the stand has. */
    const source = join(base, 'my-plugin');
    cpSync(join(HERE, 'fixtures', 'plugins', NAME), source, { recursive: true });
    const mcpFile = join(source, '.mcp.json');
    const mcp = JSON.parse(readFileSync(mcpFile, 'utf8'));
    mcp.mcpServers.probe.command = process.execPath;
    writeFileSync(mcpFile, JSON.stringify(mcp, null, 2));

    /* Without a terminal nobody can be asked, so the code stays off. */
    const { stdout } = await atag({ stateDir, workspace, home }, ['plugin', 'install', source]);
    console.log(`   atag plugin install: ${stdout.trim().replace(/\n/g, ' | ')}`);
    check(stdout.includes(`Installed ${NAME}@1.2.0`), 'the CLI installed the plugin', stdout);
    check(/Those parts are off/.test(stdout), 'the CLI says the code-running parts are off', stdout);
    check(existsSync(join(installedDir(stateDir), 'commands', 'shout.md')), 'the plugin was copied into the data folder');
    check(pluginRecord(stateDir).runsCodeAccepted !== true, 'installing did not grant code consent');
    return null;
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
