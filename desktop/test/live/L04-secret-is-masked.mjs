/**
 * L04: a key in a tool's output does not travel.
 *
 * The person: someone whose project has a live key in a config file and who
 * asks the agent to look at that file.
 *
 * The human result: the agent can read the file and say what is in it, but the
 * key itself never reaches the model, the window, or anything saved on disk.
 * Each key shows as a marker such as `[redacted:openrouter-key]`.
 *
 * What the feature promises (src/tools/tool-output-secrets.ts, ATO-1077): every
 * tool result except `reply` and `finish` is masked before the prompt, the
 * transcript and the trace see it. Those two tools carry the model's own words,
 * so the scripted reply here never repeats a key. A key the model typed itself
 * is outside the promise and is not tested.
 *
 * It fails if: the masking step is dropped or runs after the result is stored,
 * a vendor shape stops being recognised, or a tool's raw output reaches the
 * window or the state directory by a route around the mask. A canary line in the
 * same file must arrive everywhere the keys must not, so a file that was never
 * read, or a session that was never saved, cannot pass as "no key found".
 *
 * The keys are fake and made fresh for each run. Failure messages name which
 * key leaked and never print it.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const random = (n) => [...randomBytes(n)].map((b) => ALNUM[b % ALNUM.length]).join('');

const FILE = 'deploy.conf';
const CANARY = `harbour-canary-${randomBytes(6).toString('hex')}`;
/* Shapes from src/error-reporting/secret-detector.ts. The word before each
   vendor key says nothing about secrets, so only the shape can catch it. */
const SECRETS = {
  'the OpenRouter-shaped key': `sk-or-v1-${randomBytes(32).toString('hex')}`,
  'the GitHub-shaped token': `ghp_${random(36)}`,
  'the DB_PASSWORD value': `Zq7${random(24)}`,
};
const MARKERS = ['[redacted:openrouter-key]', '[redacted:github-token]', 'DB_PASSWORD=[redacted:secret]'];
const BODY = [
  '# staging deploy notes',
  `marker ${CANARY}`,
  `upstream ${SECRETS['the OpenRouter-shaped key']}`,
  `checkout ${SECRETS['the GitHub-shaped token']}`,
  `DB_PASSWORD=${SECRETS['the DB_PASSWORD value']}`,
  '',
].join('\n');
const REPLY = 'That file holds staging deploy notes.';
const TURN = { timeout: 90000, startGrace: 30000, quiet: 2500, approve: 'auto' };

/** Which keys are in `text`, by label only. */
const leaked = (text) => Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([label]) => label);

/** Every regular file under `dir`. Things that vanish mid-walk are skipped. */
function filesUnder(dir) {
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try { st = lstatSync(path); } catch { continue; }
    if (st.isDirectory()) out.push(...filesUnder(path));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

const readBytes = (path) => {
  try { return readFileSync(path); } catch { return Buffer.alloc(0); }
};

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, stateDir, home }) => {
  model.script([
    call('os.fs.read', { path: FILE }),
    call('os.shell.run', { cmd: 'cat', args: [FILE] }),
    reply(REPLY),
  ]);
  await ask(app, `Please look at ${FILE} and tell me what it is for.`);
  const done = await waitTurn(app, TURN);
  check(done.reply === REPLY, 'the turn finished with the scripted reply', JSON.stringify(done.reply.slice(0, 200)));

  // ---- what the model was sent -----------------------------------------------
  const [first, afterRead, afterCat] = model.agentRequests;
  check(!!afterCat, 'the model was called after each tool', `${model.agentRequests.length} agent requests`);
  check(!String(first.prompt).includes(CANARY), 'nothing from the file is in the prompt before the tools ran');
  for (const [name, request] of [['os.fs.read', afterRead], ['os.shell.run cat', afterCat]]) {
    const prompt = String(request.prompt);
    check(prompt.includes(CANARY), `the file's ordinary text reached the model through ${name}`);
    for (const marker of MARKERS) check(prompt.includes(marker), `the prompt shows ${marker} after ${name}`);
  }
  check(String(afterCat.prompt).includes(`$ cat ${FILE}`), 'the shell result is the one in the last prompt', String(afterCat.prompt).slice(-500));
  const everything = JSON.stringify(model.requests.map((r) => r.body));
  check(!leaked(everything).length, 'no key is in any request sent to the model', leaked(everything).join(', '));

  // ---- what the window holds -------------------------------------------------
  for (const tool of ['os.fs.read', 'os.shell.run']) {
    await app.clickSel(`.card[data-tool="${tool}"] .cardhead[data-toggle]`);
    await app.waitFor(`!!document.querySelector('.card[data-tool="${tool}"] .cardbody')`, `the ${tool} card open`);
    const shown = await app.eval(`document.querySelector('.card[data-tool="${tool}"] .cardbody').innerText`);
    check(shown.includes(CANARY), `the ${tool} card shows the file's ordinary text`, shown.slice(0, 400));
    check(shown.includes(MARKERS[0]), `the ${tool} card shows the marker, not the key`, shown.slice(0, 400));
  }
  /* The whole document, attributes and hidden nodes included. */
  const page = await app.eval('document.documentElement.outerHTML');
  check(!leaked(page).length, 'no key is anywhere in the window', leaked(page).join(', '));

  // ---- what is saved ---------------------------------------------------------
  /* The turn is saved as it ends and SQLite may still hold it in the log file,
     so give the canary a moment to land before trusting a clean scan. */
  const sessionFiles = () => filesUnder(stateDir).filter((f) => /[\\/]sessions\.sqlite/.test(f));
  let saved = false;
  for (let i = 0; i < 50 && !saved; i++) {
    saved = sessionFiles().some((f) => readBytes(f).includes(CANARY));
    if (!saved) await sleep(100);
  }
  check(saved, "the saved session holds the file's ordinary text, so the scan below means something",
    sessionFiles().join(', '));

  const found = [];
  for (const path of [...filesUnder(stateDir), ...filesUnder(home)]) {
    const bytes = readBytes(path);
    for (const [label, value] of Object.entries(SECRETS)) {
      if (bytes.includes(value)) found.push(`${label} in ${path}`);
    }
  }
  check(!found.length, 'no key is in the saved session, the trace or anything else on disk', found.join('\n     '));
  check(!leaked(app.output()).length, 'no key is in the app or agent log output', leaked(app.output()).join(', '));
}, {
  setup: ({ workspace }) => { writeFileSync(join(workspace, FILE), BODY); },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
