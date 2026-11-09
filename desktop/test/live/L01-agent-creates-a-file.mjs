/**
 * L01: the agent creates a file.
 *
 * The person asks for a file. The scripted model calls the real write tool,
 * the real approval card comes up and holds the write back, a real click on
 * Allow once releases it, the file lands on disk with the exact bytes, the
 * tool's result goes back to the model, and the reply shows in the chat.
 *
 * The harness also fails this scenario if any process carrying its temp path
 * outlives the window, or if a scripted step was never asked for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

const FILE = 'live-note.txt';
const CONTENT = 'moray-firth-live-7731\nsecond line\n';
const REPLY = 'The note is written and saved.';
/* What os.fs.write reports back (src/tools/os/fs/fs-write.ts). */
const WROTE = `wrote ${CONTENT.length} bytes to`;
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500, approve: 'none' };

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, workspace }) => {
  const target = join(workspace, FILE);
  model.script([
    call('os.fs.write', { path: FILE, content: CONTENT, mode: 'replace' }),
    reply(REPLY),
  ]);

  await ask(app, `Please create a file called ${FILE} in this folder.`);

  // ---- the card must appear, and must actually gate -----------------------
  const gated = await waitTurn(app, TURN);
  check(gated.pending, 'the agent stopped and asked me before writing anything',
    `reply so far: ${JSON.stringify(gated.reply.slice(0, 200))}`);
  const card = await app.eval(`(() => {
    const c = document.querySelector('#apprcard');
    return { text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 800),
             buttons: [...c.querySelectorAll('[data-appr]')].map((b) => b.textContent.trim().slice(0, 40)) };
  })()`);
  app.log(`the card says: ${JSON.stringify(card.text)}`);
  check(card.text.includes(FILE), 'the card names the file it is asking about', card.text);
  check(/allow once/i.test(card.buttons.join(' ')) && /deny/i.test(card.buttons.join(' ')),
    'the card offers me both Allow once and Deny', JSON.stringify(card.buttons));
  check(!existsSync(target), 'the file does not exist while the card is up', `${target} already exists`);
  check(model.agentRequests.length === 1, 'the model is not called again while the card is up',
    `${model.agentRequests.length} agent requests so far`);

  // ---- a real click releases it --------------------------------------------
  await app.clickText('Allow once', { scope: '#apprcard' });
  const done = await waitTurn(app, TURN);
  check(!done.pending, 'nothing else was put to me to approve');

  // ---- the world ------------------------------------------------------------
  check(existsSync(target), 'the file exists after I approved it', `${target} is missing`);
  const body = readFileSync(target, 'utf8');
  check(body === CONTENT, `${FILE} holds exactly what the tool was given`, JSON.stringify(body));

  const [first, second] = model.agentRequests;
  check(!!second, 'the model was called again after the tool ran');
  check(String(first.prompt).includes(FILE), 'my request reached the model');
  check(!String(first.prompt).includes(WROTE), 'the first request has no tool result yet');
  check(String(second.prompt).includes(WROTE), 'the tool result came back to the model',
    `the follow-up prompt ended with: ${String(second.prompt).slice(-600)}`);
  check(done.reply === REPLY, 'the reply is shown in the chat', JSON.stringify(done.reply.slice(0, 200)));

  // ---- nothing is left running ----------------------------------------------
  /* The session title request goes out when the turn ends, so give it a moment. */
  for (let i = 0; i < 30 && model.inFlight > 0; i++) await sleep(100);
  const idle = await app.eval(`({
    card: !!document.querySelector('#apprcard'),
    stop: !!document.querySelector('.sendbtn.stop'),
    lit: !!document.querySelector('#composer.cl-on'),
    strip: !!document.querySelector('.statusstrip'),
  })`);
  check(!idle.card && !idle.stop && !idle.lit && !idle.strip, 'the window is idle again', JSON.stringify(idle));
  check(model.inFlight === 0, 'no request to the model is still open', `${model.inFlight} open`);
  check(model.pending === 0, 'the model was asked exactly as often as scripted', `${model.pending} step(s) left`);
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
