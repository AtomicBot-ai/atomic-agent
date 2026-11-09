/**
 * L05: a tool from a connected MCP server.
 *
 * The person: someone who added a third-party MCP server and asks the agent
 * to use it.
 * The human result: the agent asks first, Deny really keeps the server from
 * being called, Allow once really calls it, the server's answer reaches the
 * model, and the chat names the tool in words rather than as an internal id.
 *
 * It fails if the server is not started or its tool is not offered to the
 * model, if the tool runs without approval or after a Deny, if the call never
 * reaches the server, if the server's answer is lost on the way back, if the
 * chat shows a raw tool id, or if the server process outlives the app.
 *
 * The server is the real stdio fixture in fixtures/mcp/. Each answer holds a
 * value the fixture invents at call time and writes to its record file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'tide-server.mjs');
const SERVER = 'tides';
const RAW_TOOL = 'lookup_tide';
const TOOL = `mcp.${SERVER}.${RAW_TOOL}`;
const RECORD = 'mcp-calls.jsonl';
const DENIED_PORT = 'Portree';
const ALLOWED_PORT = 'Lossiemouth';
const AFTER_DENY = 'I did not look that up.';
const AFTER_ALLOW = 'High water is on its way.';
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500, approve: 'none' };
/* src/tools/describe-tool-call.ts says "tides: lookup tide"; the renderer's
   fallback before the agent's own line arrives says "tides lookup tide". */
const READABLE = /tides:? lookup tide/i;

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, base }) => {
  const recordFile = join(base, RECORD);
  const calls = () => (existsSync(recordFile)
    ? readFileSync(recordFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : []);
  const cardNow = () => app.eval(`(() => {
    const c = document.querySelector('#apprcard');
    return { text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 800),
             buttons: [...c.querySelectorAll('[data-appr]')].map((b) => b.textContent.trim().slice(0, 40)) };
  })()`);

  // ---- Deny keeps the server from being called -----------------------------
  model.script([call(TOOL, { port: DENIED_PORT }), reply(AFTER_DENY)]);
  await ask(app, `Look up the tide for ${DENIED_PORT} with the tides server.`);

  const asked = await waitTurn(app, TURN);
  check(asked.pending, 'the agent stopped and asked me before using the server',
    `reply so far: ${JSON.stringify(asked.reply.slice(0, 200))}`);
  const [offered] = model.agentRequests;
  check(String(offered.prompt).includes(TOOL), 'the model was told about the tool on the configured server',
    `the prompt has no ${TOOL}`);
  check(String(offered.body.grammar).includes(`\\"${TOOL}\\"`), 'the grammar lets a local model name that tool',
    'a model held to this grammar could never call it');
  const firstCard = await cardNow();
  app.log(`the card says: ${JSON.stringify(firstCard.text)}`);
  check(firstCard.text.includes(RAW_TOOL) && firstCard.text.includes(SERVER), 'the card names the tool and the server', firstCard.text);
  check(/allow once/i.test(firstCard.buttons.join(' ')) && /deny/i.test(firstCard.buttons.join(' ')),
    'the card offers me both Allow once and Deny', JSON.stringify(firstCard.buttons));
  check(calls().length === 0, 'the server was not called while the card is up', JSON.stringify(calls()));

  await app.clickText('Deny', { scope: '#apprcard' });
  const afterDeny = await waitTurn(app, TURN);
  check(!afterDeny.pending, 'nothing else was put to me after Deny');
  check(calls().length === 0, 'Deny kept the call from ever reaching the server', JSON.stringify(calls()));
  const toldNo = model.agentRequests[1];
  check(!!toldNo && /declined/.test(String(toldNo.prompt)), 'the model was told I declined',
    `the follow-up prompt ended with: ${String(toldNo?.prompt).slice(-600)}`);
  check(afterDeny.reply === AFTER_DENY, 'the reply after the Deny is shown', JSON.stringify(afterDeny.reply.slice(0, 200)));

  // ---- Allow once really reaches the server --------------------------------
  const before = model.agentRequests.length;
  model.script([call(TOOL, { port: ALLOWED_PORT }), reply(AFTER_ALLOW)]);
  await ask(app, `Fine, look up the tide for ${ALLOWED_PORT} instead.`);

  const gated = await waitTurn(app, TURN);
  check(gated.pending, 'the second call is asked about too: my Deny granted nothing and neither did the last turn',
    `reply so far: ${JSON.stringify(gated.reply.slice(0, 200))}`);
  check(calls().length === 0, 'the server is still untouched while the second card is up', JSON.stringify(calls()));

  await app.clickText('Allow once', { scope: '#apprcard' });
  const done = await waitTurn(app, TURN);
  check(!done.pending, 'nothing else was put to me after Allow once');

  // ---- the world: the fixture's own record and the model's prompt -----------
  const recorded = calls();
  check(recorded.length === 1, 'the server received exactly one call', JSON.stringify(recorded));
  check(recorded[0].name === RAW_TOOL && recorded[0].arguments?.port === ALLOWED_PORT,
    'the server received the tool and the arguments the model sent', JSON.stringify(recorded[0]));
  const [sent, next] = model.agentRequests.slice(before);
  check(!String(sent.prompt).includes(recorded[0].answer), 'the first request of the turn has no result yet');
  check(!!next && String(next.prompt).includes(recorded[0].answer), "the server's own answer reached the model",
    `the follow-up prompt ended with: ${String(next?.prompt).slice(-600)}`);
  check(done.reply === AFTER_ALLOW, 'the reply is shown in the chat', JSON.stringify(done.reply.slice(0, 200)));

  // ---- the chat says it in words --------------------------------------------
  const selector = '#scroller [data-turnsum]';
  const folds = await app.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  check(folds === 2, 'each finished turn folded into one summary line', `${folds} summary lines`);
  for (let nth = 0; nth < folds; nth += 1) await app.clickSel(selector, { nth });
  const cardSelector = `#scroller .card[data-tool=${JSON.stringify(TOOL)}] .nm`;
  await app.waitFor(`document.querySelectorAll(${JSON.stringify(cardSelector)}).length === 2`, 'both tool lines, opened by a click');
  const lines = await app.eval(`[...document.querySelectorAll(${JSON.stringify(cardSelector)})].map((n) => n.innerText.trim())`);
  app.log(`the chat says: ${JSON.stringify(lines)}`);
  for (const line of lines) {
    check(READABLE.test(line) && !line.includes(TOOL) && !line.includes(RAW_TOOL), 'the chat names the tool in plain words', line);
  }
  check(/denied/i.test(lines[0]), 'the first line says I denied it', lines[0]);
  check(/^used /i.test(lines[1]), 'the second line says it was used', lines[1]);

  // ---- nothing is left running ----------------------------------------------
  for (let i = 0; i < 30 && model.inFlight > 0; i++) await sleep(100);
  const idle = await app.eval(`({
    card: !!document.querySelector('#apprcard'),
    stop: !!document.querySelector('.sendbtn.stop'),
    lit: !!document.querySelector('#composer.cl-on'),
    strip: !!document.querySelector('.statusstrip'),
  })`);
  check(!idle.card && !idle.stop && !idle.lit && !idle.strip, 'the window is idle again', JSON.stringify(idle));
  check(model.inFlight === 0, 'no request to the model is still open', `${model.inFlight} open`);
}, {
  setup: ({ config, base }) => {
    config.mcp.servers = [{
      name: SERVER,
      enabled: true,
      transport: { kind: 'stdio', command: process.execPath, args: [FIXTURE, join(base, RECORD)] },
    }];
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
