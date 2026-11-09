/**
 * L12: a stopped Claude Code session continues here.
 *
 * The person: someone whose Claude Code ran out of its limit halfway through a
 * task, with the session still sitting in ~/.claude.
 *
 * The human result: in the desktop, Settings › Import › Continue a task lists
 * that session, Continue opens it as a new chat with the words already in the
 * box, and Send carries the whole history to the model. `atag handoff --from
 * claude-code` run in that folder picks the same session and saves a chat the
 * window can open and continue.
 *
 * What would make it fail: the reader no longer understanding the transcript
 * format; `latest` picking a newer session from some other folder; the history
 * not reaching the prompt; a subagent's side thread leaking into it; an
 * unanswered last tool call left open instead of being closed in words; a chat
 * saved by the CLI that the window cannot see.
 *
 * The session files are invented and live only under this run's throwaway HOME.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { REPO_DIR } from '../drive.mjs';
import { SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { reply } from './scripted-model.mjs';

const run_ = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ENTRY = join(REPO_DIR, 'dist', 'cli', 'index.js');

const STOPPED_ID = '3f1c9a52-7d40-4e1b-9a6e-5b7c2d8e1f01';
const OTHER_ID = '7b2e4d10-1c3a-4f55-8d21-90ab12cd34ef';
const TITLE = 'Harbor tide retries';
const OPENING = 'You are taking over this task from Claude Code';
const CARRIED = ['KESTREL-4417', 'BRINE-3390', 'OSPREY-7126', 'No result: Claude Code stopped before this call returned'];
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500, approve: 'none' };

/* The environment the app gets: nothing secret, nothing pointing at real data. */
const STRIP = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ATOMIC_|^XDG_(CONFIG|DATA|CACHE|STATE)_HOME$|^CLAUDE_CODE_STATE_DIR$/i;

/** The real CLI, asynchronously so the scripted model keeps answering. */
function atag({ stateDir, workspace, home }, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k)));
  return run_(process.execPath, [AGENT_ENTRY, ...args], { cwd: workspace, encoding: 'utf8', timeout: 60000,
    env: { ...env, HOME: home, ATOMIC_AGENT_STATE_DIR: stateDir, ATOMIC_AGENT_ANALYTICS: 'off', DO_NOT_TRACK: '1' } });
}

/** Lay one invented transcript out the way Claude Code keeps them. */
function seedSession(home, fixture, id, cwd, ageMs, fill) {
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  let text = readFileSync(join(HERE, 'fixtures', 'handoff', fixture), 'utf8');
  for (const [from, to] of Object.entries(fill)) text = text.split(from).join(to);
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, text);
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

function checkCarried(prompt, where) {
  for (const mark of CARRIED) {
    check(prompt.includes(mark), `${where}: the model received "${mark}"`, `the prompt ended with: ${prompt.slice(-800)}`);
  }
  check(!prompt.includes('SIDECHAIN-1180'), `${where}: a subagent's side thread stayed out`);
  check(!prompt.includes('MARLIN-9052'), `${where}: the session from the other folder stayed out`);
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, stateDir, workspace, home }) => {
  const dirs = { stateDir, workspace, home };

  // ---- the terminal command ----------------------------------------------------
  const listed = JSON.parse((await atag(dirs, ['handoff', '--from', 'claude-code', '--list', '--json'])).stdout.trim().split('\n').pop());
  check(listed.sourceDir === join(home, '.claude'), 'the CLI reads the throwaway HOME and nothing else', listed.sourceDir);
  const { stdout } = await atag(dirs, ['handoff', '--from', 'claude-code']);
  app.log(`atag handoff said: ${JSON.stringify(stdout)}`);
  check(stdout.includes(`Continuing Claude Code session ${STOPPED_ID}`),
    'atag handoff picks the session from this folder, not the newer one elsewhere', stdout);
  check(stdout.includes(`${TITLE} (from Claude Code)`), 'the saved chat keeps the session title', stdout);
  check(/1 unanswered tool call/.test(stdout), 'the unanswered last call is counted', stdout);
  const cliChat = stdout.match(/saved as chat (s-[\w-]+)/)?.[1];
  check(!!cliChat, 'atag handoff names the chat it saved', stdout);
  const firstLine = stdout.match(/then send: (.+)/)?.[1]?.trim();
  check(!!firstLine && firstLine.startsWith(OPENING), 'atag handoff says what to send', stdout);

  // ---- the desktop sheet, by clicking ------------------------------------------
  await app.clickSel('.sb-settings');
  await app.clickSel('button.setrow[data-act="settings:import"]');
  await app.clickSel('[data-act="handoff:open"]');
  await app.waitFor(`document.querySelectorAll('.sheet-handoff .handoffrow').length === 2`, 'both sessions listed', { timeout: 60000 });
  const rows = await app.eval(`[...document.querySelectorAll('.sheet-handoff .handoffrow .t')].map((n) => n.textContent.trim())`);
  app.log(`the sheet lists: ${JSON.stringify(rows)}`);
  check(rows[1] === TITLE, 'the stopped session is listed under its own title, after the newer one', JSON.stringify(rows));

  await app.clickSel(`[data-act="handoff:go:${STOPPED_ID}"]`);
  await app.waitFor(`!document.querySelector('.sheet-handoff') && (document.querySelector('#entry') || { value: '' }).value.includes(${JSON.stringify(OPENING)})`,
    'the chat open with the continuation message in the box', { timeout: 90000 });
  check(model.agentRequests.length === 0, 'Continue sends nothing by itself', `${model.agentRequests.length} requests`);
  await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the send button live in the new chat', { timeout: 30000 });
  check(await app.eval(`/KESTREL-4417/.test(document.querySelector('#content').innerText)`), 'the carried history is on screen');
  const desktopChat = await app.eval(`(document.querySelector('#sidebar .sesrow.on') || { dataset: {} }).dataset.ses || ''`);
  check(desktopChat !== cliChat, 'Continue made a chat of its own', desktopChat);

  model.script([reply('Picked it up from the Edit.')]);
  app.repliesBefore = (await app.replies()).length;
  await app.clickSel('.sendbtn');
  const desktopTurn = await waitTurn(app, TURN);
  check(!desktopTurn.pending, 'nothing was put to me to approve');
  check(desktopTurn.reply === 'Picked it up from the Edit.', 'the reply is shown in the chat', JSON.stringify(desktopTurn.reply.slice(0, 200)));
  const fromDesktop = String(model.agentRequests.at(-1).prompt);
  check(fromDesktop.includes(OPENING), 'the continuation message reached the model');
  checkCarried(fromDesktop, 'desktop');

  // ---- the chat the terminal saved, opened in the window -----------------------
  await app.waitFor(`!!document.querySelector('#sidebar .sesrow[data-ses="${cliChat}"]')`, 'the chat the CLI saved in the sidebar', { timeout: 30000 });
  await app.clickSel(`#sidebar .sesrow[data-ses="${cliChat}"]`);
  await app.waitFor(`!!document.querySelector('#sidebar .sesrow.on[data-ses="${cliChat}"]') && /KESTREL-4417/.test(document.querySelector('#content').innerText)`,
    'the chat the CLI saved on screen', { timeout: 30000 });
  await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the send button live in that chat', { timeout: 30000 });
  await sleep(300);

  model.script([reply('Continuing from the terminal handoff.')]);
  await ask(app, firstLine);
  const cliTurn = await waitTurn(app, TURN);
  check(!cliTurn.pending, 'nothing was put to me to approve');
  checkCarried(String(model.agentRequests.at(-1).prompt), 'terminal handoff');
}, {
  setup: ({ base, workspace, home }) => {
    /* A real CLAUDE_CODE_STATE_DIR in the operator's shell must not win. */
    const other = join(base, 'other-project');
    mkdirSync(other, { recursive: true });
    seedSession(home, 'stopped-session.jsonl', STOPPED_ID, workspace, 10 * 60 * 1000, { __WORKSPACE__: workspace });
    seedSession(home, 'other-folder-session.jsonl', OTHER_ID, other, 60 * 1000, { __OTHER_FOLDER__: other });
    return { CLAUDE_CODE_STATE_DIR: undefined };
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
