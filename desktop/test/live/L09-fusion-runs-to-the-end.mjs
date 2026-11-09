/**
 * L09: a Fusion run goes all the way to the end.
 *
 * The person: someone on Fusion, a cloud model planning and a local model
 * doing the work, who asks in the ordinary composer for two pieces of work.
 *
 * The human result: they approve the fan-out once, two workers write one file
 * each through the real write tool at the same time, both files hold the right
 * bytes, the window says both workers succeeded, the planner's answer shows,
 * and nothing is left running.
 *
 * What makes it fail: the fan-out running without the card, a worker that
 * never starts or never writes, a worker told the other worker's task, workers
 * queued one behind the other on a server with free slots, a worker's result
 * not reaching the planner, the window not reporting the finish, or a request
 * left open after the turn.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply, requestText } from './scripted-model.mjs';

const PLANNER = 'live-planner';
const WORKER = 'local-llama';
const REPLY = 'Both parts are written.';
/* Long enough that two workers running together must overlap, and two running
   one after the other cannot. */
const WORKER_THINKS_MS = 1500;
const TURN = { timeout: 90000, startGrace: 30000, quiet: 2500, approve: 'none' };

const PARTS = [
  { id: 'alpha', title: 'Write the alpha part', file: 'alpha.txt', content: 'alpha-part-5521\n' },
  { id: 'beta', title: 'Write the beta part', file: 'beta.txt', content: 'beta-part-8834\n' },
];
const workerReply = (p) => `${p.file} is written.`;

/* The agent names a new chat after its first answer (src/session/session-title.ts).
   On a cloud route that request carries a tool list, so the scripted server
   would count it as a step of the planner. It is not one. */
const titleRoute = {
  name: 'session title',
  match: (record) => (record.body?.tools ?? []).some((t) => t.function?.name === 'emit_session_title'),
  steps: () => call('emit_session_title', { title: 'Two parts' }),
};

/* The opening line of the worker brief (src/tools/fusion/worker-prompt.ts),
   then that worker's own task heading. */
const workerRoute = (p) => ({
  name: p.id,
  match: new RegExp(`You are a worker agent executing one delegated task[\\s\\S]*TASK ${p.id}:`),
  steps: [
    { ...call('os.fs.write', { path: p.file, content: p.content, mode: 'replace' }), delay: WORKER_THINKS_MS },
    reply(workerReply(p)),
  ],
});

/* The usual Fusion pair: a cloud planner and the local route for the workers.
   Fusion resolves from these pins (src/llm/run-mode/resolve-run-mode.ts), and
   the planner has to be the active provider. A fan-out on a local leg is as wide
   as the server's slots, so the scripted server reports room for both. */
function setup({ model, config }) {
  model.totalSlots = 4;
  model.serveChat();
  config.llm = {
    activeTextProvider: PLANNER,
    providers: [
      { id: WORKER, kind: 'llama-server', url: model.url },
      { id: PLANNER, kind: 'openai-compatible', baseUrl: model.url, apiKey: 'live-scripted-not-a-key', defaultChatModel: PLANNER },
    ],
    runMode: { mode: 'fusion', fusion: { orchestratorProvider: PLANNER, workerProvider: WORKER } },
  };
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, workspace }) => {
  model.route([titleRoute, ...PARTS.map(workerRoute)]);
  model.script([
    call('fusion.delegate', {
      tasks: PARTS.map((p) => ({ id: p.id, title: p.title, instructions: `Create ${p.file} in this folder.`, files: [p.file] })),
      maxWorkers: 2,
    }),
    reply(REPLY),
  ]);
  const byRoute = (name) => model.agentRequests.filter((r) => r.route === name);
  const planner = () => model.agentRequests.filter((r) => !r.route);

  await ask(app, 'Please write the alpha part and the beta part, one file each, using two workers.');

  // ---- one question before anything runs ------------------------------------
  const gated = await waitTurn(app, TURN);
  check(gated.pending, 'the agent asked me before sending the workers out',
    `reply so far: ${JSON.stringify(gated.reply.slice(0, 200))}`);
  /* The count and the task names are in the card's Details, folded at first. */
  await app.clickSel('#apprcard .apprdet summary');
  await app.waitFor(`!!document.querySelector('#apprcard .apprdet[open]')`, 'the card\'s Details open');
  const card = await app.eval(`document.querySelector('#apprcard').innerText.replace(/\\s+/g, ' ').trim().slice(0, 800)`);
  app.log(`the card says: ${JSON.stringify(card)}`);
  check(/2 tasks to 2 workers/.test(card), 'the card says how many tasks are going out', card);
  for (const p of PARTS) check(card.includes(p.title), `the card names the task "${p.title}"`, card);
  for (const p of PARTS) {
    check(byRoute(p.id).length === 0, `worker ${p.id} has not started while the card is up`);
    check(!existsSync(join(workspace, p.file)), `${p.file} does not exist while the card is up`);
  }

  // ---- one click, two workers ------------------------------------------------
  await app.clickText('Allow once', { scope: '#apprcard' });
  const done = await waitTurn(app, TURN);
  check(!done.pending, 'one answer covered the whole fan-out');

  // ---- the world --------------------------------------------------------------
  for (const p of PARTS) {
    const target = join(workspace, p.file);
    check(existsSync(target), `${p.file} exists`, `${target} is missing`);
    const body = readFileSync(target, 'utf8');
    check(body === p.content, `${p.file} holds exactly what its worker wrote`, JSON.stringify(body));
  }

  // ---- each worker really worked on its own task ------------------------------
  for (const p of PARTS) {
    const [first, second, extra] = byRoute(p.id);
    const other = PARTS.find((x) => x !== p);
    check(!!first && !!second && !extra, `worker ${p.id} took exactly its two steps`, `${byRoute(p.id).length} request(s)`);
    check(first.url === '/completion', `worker ${p.id} ran on the local route`, first.url);
    check(requestText(first).includes(`Create ${p.file}`), `worker ${p.id} was given its own instructions`);
    check(!requestText(first).includes(`TASK ${other.id}:`), `worker ${p.id} was not given the other task`);
    check(requestText(second).includes(`wrote ${p.content.length} bytes to`), `worker ${p.id} got the real result of its write`,
      requestText(second).slice(-600));
  }
  const [a, b] = PARTS.map((p) => byRoute(p.id)[0]);
  check(a.at < b.closedAt && b.at < a.closedAt, 'the two workers ran at the same time',
    `alpha ${a.at} to ${a.closedAt}, beta ${b.at} to ${b.closedAt}`);

  // ---- the plan came back together --------------------------------------------
  const [plan, merge, more] = planner();
  check(!!plan && !!merge && !more, 'the planner was called once to plan and once to finish', `${planner().length} request(s)`);
  check(plan.url.startsWith('/v1/chat/completions'), 'the planner ran on the cloud route', plan.url);
  for (const p of PARTS) {
    check(requestText(merge).includes(workerReply(p)), `what worker ${p.id} reported reached the planner`,
      requestText(merge).slice(-1200));
  }
  check(!requestText(plan).includes('You are a worker agent executing'), 'the planner was not sent a worker brief');

  // ---- what the window says ---------------------------------------------------
  check(done.reply === REPLY, 'the answer is shown in the chat', JSON.stringify(done.reply.slice(0, 200)));
  const page = await app.eval(`document.body.innerText`);
  check(page.includes('2/2 ok'), 'the window says both workers succeeded', page.slice(-800));

  // ---- nothing is left running -------------------------------------------------
  for (let i = 0; i < 30 && model.inFlight > 0; i++) await sleep(100);
  const idle = await app.eval(`({
    card: !!document.querySelector('#apprcard'),
    stop: !!document.querySelector('.sendbtn.stop'),
    lit: !!document.querySelector('#composer.cl-on'),
    strip: !!document.querySelector('.statusstrip'),
    workers: !!document.querySelector('.fzlive'),
  })`);
  check(!idle.card && !idle.stop && !idle.lit && !idle.strip && !idle.workers, 'the window is idle again', JSON.stringify(idle));
  check(model.inFlight === 0, 'no request to the model is still open', `${model.inFlight} open`);
  check(model.pending === 0, 'every scripted step was asked for', `${model.pending} step(s) left`);
}, { setup });

if (import.meta.url === `file://${process.argv[1]}`) main(run());
