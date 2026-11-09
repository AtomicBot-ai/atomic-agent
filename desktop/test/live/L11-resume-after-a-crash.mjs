/**
 * L11: a task under way survives the agent being killed.
 *
 * The person: someone with an overnight job running when the agent process
 * dies for real, here a SIGKILL, with no chance to save anything on the way.
 *
 * The human result: the app brings the agent back by itself, the job picks up
 * after its last finished step, and it finishes. Work already done is not done
 * twice, and the card ends on Done.
 *
 * The first step appends one line to a file, so running it again would show as
 * a second copy of that line. The model is held in the middle of the second
 * step when the kill lands.
 *
 * What makes it fail: the app not restarting the agent, the interrupted task
 * staying stuck as running, the task starting over without the first step's
 * result in its prompt, the first step's tool being run again, the resume not
 * being told it is a resume, or a card that never reports the finish.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, Failure, check, main, sleep } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply, requestText } from './scripted-model.mjs';

const FILE = 'journal.log';
const LINE_ONE = 'first-step-done-4410\n';
const LINE_TWO = 'second-step-done-7702\n';
/* What os.fs.write reports back (src/tools/os/fs/fs-write.ts). */
const WROTE_ONE = `wrote ${LINE_ONE.length} bytes to`;
const DONE = 'The journal is complete.';

async function until(test, label, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (test()) return;
    await sleep(100);
  }
  throw new Failure(`gave up waiting for ${label}`);
}

/* `atag serve` from this run: the harness shim puts the run's own temp path on
   its command line. Electron carries that path too, so the entry file and the
   subcommand are what pick out the agent. */
function agentProcesses(base) {
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter((m) => m && m[2].includes(base) && m[2].includes('dist/cli/index.js') && /\sserve(\s|$)/.test(m[2]))
    .map((m) => ({ pid: Number(m[1]), command: m[2] }));
}

function setup({ config }) {
  /* Workspace writes run without a card from level 2. Nobody is awake to answer
     one, and approvals are not what this scenario is about. */
  config.agent.approvalLevel = 2;
}

async function startOvernight(app, message) {
  await app.clickSel('.attbtn[data-att-menu]');
  await app.clickSel('[data-ovn="open"]');
  await app.waitFor(`!!document.querySelector('#overnight [data-ovn-field="message"]')`, 'the Run overnight dialog');
  /* The dialog repaints once it has read the defaults from the agent. */
  await sleep(500);
  await app.clickSel('#overnight [data-ovn-field="message"]');
  await app.type(message, { perChar: 1 });
  await app.clickSel('#overnight [data-ovn="start"]');
  await app.waitFor(`!!document.querySelector('.ovn-run[data-ovn-run]')`, 'the run on the overnight card', { timeout: 20000 });
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, base, workspace }) => {
  const target = join(workspace, FILE);
  const task = 'Write the journal, one line at a time.';
  model.script([
    call('os.fs.write', { path: FILE, content: LINE_ONE, mode: 'append' }),
    { hold: true },
    call('os.fs.write', { path: FILE, content: LINE_TWO, mode: 'append' }),
    reply(DONE),
  ]);

  await startOvernight(app, task);

  // ---- the task is really mid-way ------------------------------------------------
  await until(() => model.agentRequests.length === 2 && model.agentRequests[1].held,
    'the second step of the task to reach the model', 60000);
  check(readFileSync(target, 'utf8') === LINE_ONE, 'the first step is on disk before the crash');
  check(requestText(model.agentRequests[1]).includes(WROTE_ONE), 'the second step was sent the first step\'s result');
  const held = model.agentRequests[1];

  // ---- the crash ------------------------------------------------------------------
  const found = agentProcesses(base);
  check(found.length === 1, 'exactly one agent process is running for this run', JSON.stringify(found.map((p) => p.command.slice(0, 160))));
  const killed = found[0].pid;
  process.kill(killed, 'SIGKILL');
  app.log(`SIGKILL sent to the agent, pid ${killed}`);
  await until(() => held.disconnected, 'the killed agent to drop its request to the model', 10000);

  // ---- it comes back by itself and carries on ------------------------------------
  await until(() => agentProcesses(base).some((p) => p.pid !== killed), 'the app to start the agent again', 45000);
  await until(() => model.agentRequests.length >= 3, 'the task to resume after the restart', 90000);

  const resumed = requestText(model.agentRequests[2]);
  check(resumed.includes('[Resumed]'), 'the resumed step is told it is a resume', resumed.slice(-800));
  check(resumed.includes('after step 1'), 'the resume knows it stopped after the first step', resumed.slice(-800));
  check(resumed.includes(WROTE_ONE), 'the first step\'s result survived the crash in the prompt', resumed.slice(-1200));
  check(resumed.includes(task), 'the resumed step still carries the task', resumed.slice(-800));

  // ---- it finishes, and the card says so ------------------------------------------
  await app.waitFor(`/ after \\d/.test((document.querySelector('.ovn-run .ovn-meta') || {}).innerText || '')`,
    'the card reporting that the run ended', { timeout: 90000 });
  const line = await app.eval(`document.querySelector('.ovn-run .ovn-meta').innerText`);
  app.log(`the card says: ${JSON.stringify(line)}`);
  check(line.startsWith('Done'), 'the card says the task is done', line);

  // ---- the world -------------------------------------------------------------------
  const body = readFileSync(target, 'utf8');
  check(body === LINE_ONE + LINE_TWO, 'each step wrote its line exactly once', JSON.stringify(body));
  check(model.agentRequests.length === 4, 'no step was asked of the model twice', `${model.agentRequests.length} agent requests`);
  check(!requestText(model.agentRequests[0]).includes('[Resumed]'), 'the first run was not a resume');
  for (let i = 0; i < 30 && model.inFlight > 0; i++) await sleep(100);
  check(model.inFlight === 0, 'no request to the model is still open', `${model.inFlight} open`);
  check(model.pending === 0, 'every scripted step was asked for', `${model.pending} step(s) left`);
}, { setup });

if (import.meta.url === `file://${process.argv[1]}`) main(run());
