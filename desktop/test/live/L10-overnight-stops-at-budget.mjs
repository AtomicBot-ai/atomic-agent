/**
 * L10: an Overnight run stops when its budget is spent.
 *
 * The person: someone leaving a long job on a paid cloud model who sets a
 * small money limit in the Run overnight dialog and goes to bed.
 *
 * The human result: the agent works while the limit leaves room for one more
 * step and the closing summary, then gets that one last step to say where it
 * stopped, and is not called again. The cap is hard (ATO-1472, PR #1262): the
 * summary is paid for inside the budget, so the run never spends past it. The card in the window
 * says the run stopped at the budget and what it spent.
 *
 * The scripted model would keep working forever, so only the agent's own
 * ceiling can end this. It reports token usage on every completion and the
 * model has a seeded price, so the money is computed by the real pricing path.
 *
 * What makes it fail: a budget from the dialog that never reaches the task, a
 * completion not priced, a ceiling that does not stop the loop, a model call
 * after the stop, no final step, or a card that reports Done or nothing.
 *
 * A local route cannot test this: its completions carry no usage, so a budget
 * can never stop local work, and the dialog hides the field for it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, Failure, check, main, sleep } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply, requestText } from './scripted-model.mjs';

const CLOUD = 'live-cloud';
const CLOUD_MODEL = 'live-priced';
const BUDGET = '0.01';
/* Each completion is 400 tokens in and 400 out at $2 per million each way:
   $0.0016. A step runs only while the spend leaves room for it and the summary
   after it, each estimated at what the last step cost (budgetStepPlan in
   src/agent/turn/turn-spend.ts, PR #1262). After four steps ($0.0064) a fifth
   and the summary still fit ($0.0096); after five ($0.008) they would not
   ($0.0112), so the sixth call is the reserved last step, the run ends at
   $0.0096 of $0.01 and there is no seventh. Before PR #1262 the summary came
   on top of a reached cap, so a $0.01 cap ended past it. */
const TOKENS = 400;
const STEPS_TO_SPEND_IT = 5;
const BUDGET_USD = 0.01;
const REPORT = 'stopped: the budget is spent, three parts are done.';
/* The first words of the agent's notice on the last step, shared by both of
   its forms: "... is nearly used up" when the summary step still fits under the
   cap, "... is used up" when the cap is already reached (costCeilingNotice in
   src/agent/turn/turn-spend.ts). */
const LAST_STEP = 'The spend budget for this task is';
/* If the ceiling is broken the scripted model ends the run itself here, so the
   scenario fails on the count instead of writing files until the timeout. */
const RUNAWAY_AFTER = 12;
const partFile = (n) => `part-${n}.txt`;

function setup({ model, config }) {
  model.serveChat({ promptTokens: TOKENS, completionTokens: TOKENS });
  /* Workspace writes run without a card from level 2. Approvals are not what
     this scenario is about, and nobody is awake to answer one. */
  config.agent.approvalLevel = 2;
  config.llm = {
    activeTextProvider: CLOUD,
    providers: [
      { id: 'local-llama', kind: 'llama-server', url: model.url },
      { id: CLOUD, kind: 'openai-compatible', baseUrl: model.url, apiKey: 'live-scripted-not-a-key', defaultChatModel: CLOUD_MODEL,
        userModels: [{ id: CLOUD_MODEL, kind: 'chat', contextWindow: 128000, pricing: { input: 2, output: 2 } }] },
    ],
  };
}

async function startOvernight(app, message, budget) {
  // W2: Run overnight is a row of the composer's mode chip, not of the "+" menu.
  await app.clickSel('#composer .cmodepick[data-cmode-open]');
  await app.clickSel('#cmodemenu [data-cmode="overnight"]');
  await app.waitFor(`!!document.querySelector('#overnight [data-ovn-field="message"]')`, 'the Run overnight dialog');
  /* The dialog repaints once it has read the defaults from the agent. */
  await sleep(500);
  if (await app.eval(`!!document.querySelector('#overnight [data-ovn-free]')`)) {
    throw new Failure('the dialog says this cloud route is free and offers no budget');
  }
  await app.clickSel('#overnight [data-ovn-field="message"]');
  await app.type(message, { perChar: 1 });
  await app.clickSel('#overnight [data-ovn-field="budget"]');
  await app.type(budget, { perChar: 1 });
  await app.clickSel('#overnight [data-ovn="start"]');
  await app.waitFor(`!!document.querySelector('.ovn-run[data-ovn-run]')`, 'the run on the overnight card', { timeout: 20000 });
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, workspace }) => {
  model.route([{
    name: 'overnight work',
    match: () => true,
    steps: (record, n) => ((requestText(record).includes(LAST_STEP) || n > RUNAWAY_AFTER)
      ? reply(REPORT)
      : call('os.fs.write', { path: partFile(n), content: `part ${n}\n`, mode: 'replace' })),
  }]);

  await startOvernight(app, 'Write as many numbered parts as you can.', BUDGET);

  // ---- the card is polled every 15 s, so give it several rounds ----------------
  await app.waitFor(`/ after \\d/.test((document.querySelector('.ovn-run .ovn-meta') || {}).innerText || '')`,
    'the card reporting that the run ended', { timeout: 90000 });
  const line = await app.eval(`document.querySelector('.ovn-run .ovn-meta').innerText`);
  app.log(`the card says: ${JSON.stringify(line)}`);

  // ---- it stopped where the money ran out --------------------------------------
  const calls = model.agentRequests;
  check(calls.length === STEPS_TO_SPEND_IT + 1,
    `the model was called ${STEPS_TO_SPEND_IT} times to work and once to sign off`, `${calls.length} calls`);
  for (let n = 1; n <= STEPS_TO_SPEND_IT; n++) {
    check(existsSync(join(workspace, partFile(n))), `${partFile(n)} was really written before the money ran out`);
  }
  check(!existsSync(join(workspace, partFile(STEPS_TO_SPEND_IT + 1))), 'no work was done after the budget ran out');

  const last = calls[calls.length - 1];
  check(requestText(last).includes(LAST_STEP), 'the agent told the model the budget is spent', requestText(last).slice(-800));
  for (const earlier of calls.slice(0, -1)) {
    check(!requestText(earlier).includes(LAST_STEP), 'the budget notice did not come early');
  }

  // ---- it stays stopped --------------------------------------------------------
  await sleep(4000);
  check(model.agentRequests.length === calls.length, 'the model is not called again after the stop',
    `${model.agentRequests.length} calls now`);
  for (let i = 0; i < 30 && model.inFlight > 0; i++) await sleep(100);
  check(model.inFlight === 0, 'no request to the model is still open', `${model.inFlight} open`);
  /* The session is named once after its first answered turn, outside the
     turn's budget (runtime-turn-service.ts). Anything else calling the model
     is a call after the stop. */
  const sideCalls = model.requests.filter((r) => r.kind === 'auxiliary');
  check(sideCalls.length <= 1 && sideCalls.every((r) => requestText(r).includes('Name this work session')),
    'the only other model call is the one that names the chat', `${sideCalls.length} side calls`);

  // ---- what the window says ----------------------------------------------------
  check(line.includes('Stopped at the budget'), 'the card says the budget is why it stopped', line);
  const spend = line.match(/\$(\d+\.\d\d) of \$(\d+\.\d\d)/);
  check(!!spend && spend[2] === '0.01', 'the card shows the limit I set', line);
  /* The card rounds to cents: the $0.0096 really spent shows as $0.01. The
     cap is hard (PR #1262), so it never shows more than the limit. */
  check(Number(spend[1]) > 0 && Number(spend[1]) <= BUDGET_USD, 'the card shows money really spent, and not past the budget', line);
  check(!(await app.eval(`!!document.querySelector('[data-ovn^="stop:"]')`)), 'the run no longer offers Stop');
}, { setup });

if (import.meta.url === `file://${process.argv[1]}`) main(run());
