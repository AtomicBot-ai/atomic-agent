/**
 * L02: "Always allow" is remembered, and remembers only what it said.
 *
 * The person: someone tired of approving the same kind of file write.
 *
 * The human result: the first write asks. One real click on Always allow
 * answers it. The next write in that chat just happens. The rule is in the
 * file the app keeps it in, it still holds after the app is closed and opened
 * again on the same state directory, and something else (a write outside the
 * folder, a shell command) still asks.
 *
 * It fails if: the button only allows once, the rule is not written to
 * `<stateDir>/approval-rules.json`, the rule lives only in memory and dies with
 * the app, or the rule is wider than the one kind of action it was given for.
 *
 * The harness owns the first window. The restart is done here, with the same
 * launch options, so the second window has to be closed here too.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch, sleep } from '../drive.mjs';
import { SCENARIO_NAME, ask, check, main, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

const FIRST = { file: 'first-note.txt', content: 'skerry-first-4410\n' };
const SECOND = { file: 'second-note.txt', content: 'skerry-second-note-5521\n' };
const THIRD = { file: 'third-note.txt', content: 'skerry-third-note-after-restart-6632\n' };
const OUTSIDE = { file: 'outside-workspace.txt', content: 'must never land\n' };
const COMMAND_FILE = 'other-action.txt';
/* What os.fs.write reports back (src/tools/os/fs/fs-write.ts). */
const wrote = (content) => `wrote ${content.length} bytes to`;
/* What the model reads after a Deny (src/approval/dangerous-tool.ts). */
const declined = (tool) => `The user declined this ${tool} call`;
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500, approve: 'none' };

const rulesPath = (stateDir) => join(stateDir, 'approval-rules.json');
const savedRules = (stateDir) => JSON.parse(readFileSync(rulesPath(stateDir), 'utf8')).rules;

/** The open card as a person sees it: its words and the answers it offers. */
const cardNow = (app) => app.eval(`(() => {
  const c = document.querySelector('#apprcard');
  return { text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 800),
           answers: [...c.querySelectorAll('[data-appr]')].map((b) => b.dataset.appr) };
})()`);

/** Wait for a card about `words`. A card just answered is not the next one. */
const waitCard = (app, words) => app.waitFor(
  `((document.querySelector('#apprcard') || {}).innerText || '').includes(${JSON.stringify(words)})`,
  `a card about ${words}`, { timeout: 30000 });

/** Processes still carrying this run's temp path, the crash handler aside. */
function stillRunning(base) {
  if (process.platform === 'win32') return [];
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((line) => line.includes(base) && !/crashpad_handler/.test(line));
}

/** Copied from live-harness.mjs, which does not export it. */
async function waitReady(app) {
  await app.waitFor(`!!document.querySelector('#entry')`, 'the composer', { timeout: 90000 });
  await app.waitFor(`!!document.querySelector('.cmodechip[data-id]:not([data-id=""])')`,
    'the Mode chip, once the agent has reported its stance', { timeout: 90000 });
  await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the send button live', { timeout: 60000 });
}

/** Close the app the way the harness does and open it on the same state. */
async function reopen(app, base) {
  await app.close();
  let left = stillRunning(base);
  for (let i = 0; i < 100 && left.length; i++) {
    await sleep(100);
    left = stillRunning(base);
  }
  check(!left.length, 'the first run of the app is really gone before the second starts', left[0]?.slice(0, 160));
  return launch(app.opts);
}

/** `ask`, then wait for the question to reach the model. A chat restored after
    a restart can paint its old replies late and look like an answer. */
async function askAfterRestart(app, model, text) {
  const before = model.agentRequests.length;
  await ask(app, text);
  for (let i = 0; i < 300 && model.agentRequests.length === before; i++) await sleep(100);
  check(model.agentRequests.length > before, 'my message reached the model after the restart');
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, base, stateDir, workspace, home }) => {
  const at = (name) => join(workspace, name);

  // ---- the first write asks, and Always allow answers it --------------------
  model.script([
    call('os.fs.write', { path: FIRST.file, content: FIRST.content, mode: 'replace' }),
    reply('The first note is saved.'),
  ]);
  await ask(app, `Please create a file called ${FIRST.file} in this folder.`);
  const gated = await waitTurn(app, TURN);
  check(gated.pending, 'the first write stopped and asked me');
  const offered = await cardNow(app);
  app.log(`the card says: ${JSON.stringify(offered.text)}`);
  check(offered.text.includes(FIRST.file), 'the card names the file', offered.text);
  check(offered.answers.includes('w'), 'the card offers Always allow', JSON.stringify(offered.answers));
  check(!existsSync(at(FIRST.file)), 'nothing is written while the card is up');
  check(!existsSync(rulesPath(stateDir)), 'no rule exists before I chose one');

  await app.clickSel('#apprcard [data-appr="w"]');
  const firstDone = await waitTurn(app, TURN);
  check(!firstDone.pending, 'that one click was the only question');
  check(readFileSync(at(FIRST.file), 'utf8') === FIRST.content, 'the approved write happened');

  // ---- the rule is really on disk, and is exactly this rule -----------------
  check(existsSync(rulesPath(stateDir)), 'the rule was saved to approval-rules.json', rulesPath(stateDir));
  const rules = savedRules(stateDir);
  check(rules.length === 1, 'exactly one rule was saved', JSON.stringify(rules));
  const [rule] = rules;
  check(rule.decision === 'allow' && rule.tool === 'os.fs.write' && rule.category === 'fs_write_workspace',
    'the rule allows workspace writes and nothing else', JSON.stringify(rule));
  check(rule.project === workspace, 'the rule is scoped to this folder', `${rule.project} != ${workspace}`);
  check(rule.source === 'prompt', 'the rule is recorded as coming from the card', JSON.stringify(rule));
  await app.waitFor(`/Rule saved/.test(document.querySelector('#scroller').innerText)`, 'the receipt saying the rule was saved');

  // ---- the same action, same chat: no card ----------------------------------
  model.script([
    call('os.fs.write', { path: SECOND.file, content: SECOND.content, mode: 'replace' }),
    reply('The second note is saved.'),
  ]);
  await ask(app, `Please create a file called ${SECOND.file} in this folder.`);
  const secondDone = await waitTurn(app, TURN);
  check(!secondDone.pending, 'the second write did not ask me');
  check(readFileSync(at(SECOND.file), 'utf8') === SECOND.content, 'the second write happened without a click');
  check(String(model.agentRequests.at(-1).prompt).includes(wrote(SECOND.content)), 'the model got the result of the second write');

  // ---- close the app, open it again on the same state -----------------------
  const before = readFileSync(rulesPath(stateDir), 'utf8');
  const again = await reopen(app, base);
  /* The harness only knows the first window: if the model breaks while this
     one is up, nothing else would close it before the next scenario. */
  model.whenBroken.catch(() => again.close().catch(() => {}));
  try {
    await waitReady(again);
    check(readFileSync(rulesPath(stateDir), 'utf8') === before, 'opening the app left the saved rule alone');

    model.script([
      call('os.fs.write', { path: THIRD.file, content: THIRD.content, mode: 'replace' }),
      reply('The third note is saved.'),
    ]);
    await askAfterRestart(again, model, `Please create a file called ${THIRD.file} in this folder.`);
    const thirdDone = await waitTurn(again, TURN);
    check(!thirdDone.pending, 'after the restart the same action still does not ask');
    check(readFileSync(at(THIRD.file), 'utf8') === THIRD.content, 'the write after the restart happened without a click');

    // ---- anything else still asks --------------------------------------------
    const outside = join(home, OUTSIDE.file);
    model.script([
      call('os.fs.write', { path: outside, content: OUTSIDE.content, mode: 'replace' }),
      call('os.shell.run', { cmd: 'touch', args: [COMMAND_FILE] }),
      reply('Neither of those was done.'),
    ]);
    await askAfterRestart(again, model, `Please make ${OUTSIDE.file} in my home folder and touch ${COMMAND_FILE} here.`);

    await waitCard(again, OUTSIDE.file);
    check(!existsSync(outside), 'a write outside the folder waits: the rule does not cover it');
    await again.clickSel('#apprcard [data-appr="n"]');

    await waitCard(again, COMMAND_FILE);
    check(!existsSync(at(COMMAND_FILE)), 'a shell command waits: the rule does not cover it');
    await again.clickSel('#apprcard [data-appr="n"]');

    const denied = await waitTurn(again, TURN);
    check(!denied.pending, 'no third question came up');
    check(!existsSync(outside), 'the denied write never landed');
    check(!existsSync(at(COMMAND_FILE)), 'the denied command never ran');
    const told = String(model.agentRequests.at(-1).prompt);
    check(told.includes(declined('os.fs.write')) && told.includes(declined('os.shell.run')),
      'the model was told I refused both', told.slice(-600));
    check(savedRules(stateDir).length === 1, 'denying added no rule', JSON.stringify(savedRules(stateDir)));
  } catch (e) {
    await again.screenshot(join(base, 'failure-after-restart.png')).catch(() => {});
    writeFileSync(join(base, 'app-output-after-restart.log'), again.output());
    throw e;
  } finally {
    await again.close();
  }
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
