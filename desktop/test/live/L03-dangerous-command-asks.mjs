/**
 * L03: a destructive command asks, whatever was allowed before.
 *
 * The person: someone who has told the agent to stop asking about ordinary
 * work, and who still expects to be stopped before something is destroyed.
 *
 * The human result: file writes are allowed always and plain `rm` is allowed
 * for this chat, so those run unasked. `rm -f` on a fixture file still brings
 * up its own card. The file is intact while the card is up, Deny leaves it
 * intact, and the model is told the person refused.
 *
 * It fails if: `rm -f` is classed as an ordinary command, because then the
 * in-chat grant on `rm` runs it with no card and the file is gone. At the
 * default level every shell command asks, so the grant is what tells a
 * dangerous card apart from an ordinary one. It also fails if the card offers
 * to remember the answer: `shell_dangerous` is never granted (ATO-1220,
 * src/approval/approval-level.ts), so this branch has no "for this session"
 * choice on this card and none may appear.
 *
 * Every target is a fixture inside the scenario's own throwaway workspace.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, ask, check, main, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

const WARMUP = { file: 'warmup.txt', content: 'tern-warmup-3107\n' };
const OLD_A = 'old-a.txt';
const OLD_B = 'old-b.txt';
const VICTIM = 'victim.txt';
const VICTIM_BYTES = 'tern-keep-this-8842\nsecond line\n';
const COMMAND = `rm -f ${VICTIM}`;
/* What the model reads after a bare Deny (src/approval/dangerous-tool.ts). */
const DECLINED = 'The user declined this os.shell.run call (they pressed Deny)';
const FINAL = 'I did not delete it.';
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500, approve: 'none' };

const cardNow = (app) => app.eval(`(() => {
  const c = document.querySelector('#apprcard');
  return { text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 800),
           answers: [...c.querySelectorAll('[data-appr]')].map((b) => b.dataset.appr) };
})()`);

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, stateDir, workspace }) => {
  const at = (name) => join(workspace, name);
  const rules = () => JSON.parse(readFileSync(join(stateDir, 'approval-rules.json'), 'utf8')).rules;

  // ---- ordinary writes are allowed always -----------------------------------
  model.script([
    call('os.fs.write', { path: WARMUP.file, content: WARMUP.content, mode: 'replace' }),
    reply('Saved.'),
  ]);
  await ask(app, `Please create a file called ${WARMUP.file} in this folder.`);
  check((await waitTurn(app, TURN)).pending, 'the first write asked me');
  await app.clickSel('#apprcard [data-appr="w"]');
  check(!(await waitTurn(app, TURN)).pending, 'Always allow answered it');
  check(readFileSync(at(WARMUP.file), 'utf8') === WARMUP.content, 'the write happened');
  check(rules().length === 1 && rules()[0].tool === 'os.fs.write', 'a rule for writes is saved', JSON.stringify(rules()));

  // ---- plain rm is allowed for this chat ------------------------------------
  model.script([
    call('os.shell.run', { cmd: 'rm', args: [OLD_A] }),
    reply('Removed.'),
  ]);
  await ask(app, `Please remove ${OLD_A}.`);
  check((await waitTurn(app, TURN)).pending, 'a plain rm asked me the first time');
  const plain = await cardNow(app);
  check(plain.answers.includes('c'), 'an ordinary command can be allowed for the chat', JSON.stringify(plain.answers));
  await app.clickSel('#apprcard [data-appr="c"]');
  check(!(await waitTurn(app, TURN)).pending, 'Allow in this chat answered it');
  check(!existsSync(at(OLD_A)), 'the plain rm ran');

  // ---- in one turn: a plain rm runs unasked, then rm -f must stop -----------
  model.script([
    call('os.shell.run', { cmd: 'rm', args: [OLD_B] }),
    call('os.shell.run', { cmd: 'rm', args: ['-f', VICTIM] }),
    reply(FINAL),
  ]);
  const requestsBefore = model.agentRequests.length;
  await ask(app, `Please remove ${OLD_B} and then get rid of ${VICTIM} for good.`);
  await app.waitFor(`((document.querySelector('#apprcard') || {}).innerText || '').includes(${JSON.stringify(COMMAND)})`,
    'the card for the destructive command', { timeout: 30000 });

  check(!existsSync(at(OLD_B)), 'the plain rm before it ran with no card: the chat grant is live');
  const card = await cardNow(app);
  app.log(`the card says: ${JSON.stringify(card.text)}`);
  check(/force remove/.test(card.text), 'the card says what the safety check flagged', card.text);
  check(card.answers.join(',') === 'y,n,esc', 'the only answers are Allow once, Deny and Abort: nothing that remembers it',
    JSON.stringify(card.answers));
  await app.clickSel('#apprcard .apprdet summary');
  const badge = await app.eval(`((document.querySelector('#apprcard .aplate .badge') || {}).innerText || '').trim()`);
  check(/dangerous/i.test(badge), 'Details names it as a dangerous command, not an ordinary one', JSON.stringify(badge));

  check(readFileSync(at(VICTIM), 'utf8') === VICTIM_BYTES, 'the file is intact while the card is up');
  check(model.agentRequests.length === requestsBefore + 2, 'the model is not called again while the card is up',
    `${model.agentRequests.length - requestsBefore} agent requests in this turn`);

  // ---- Deny ------------------------------------------------------------------
  await app.clickSel('#apprcard [data-appr="n"]');
  const done = await waitTurn(app, TURN);
  check(!done.pending, 'nothing else was put to me');
  check(existsSync(at(VICTIM)) && readFileSync(at(VICTIM), 'utf8') === VICTIM_BYTES, 'the file is intact after Deny');
  const told = String(model.agentRequests.at(-1).prompt);
  check(told.includes(DECLINED), 'the model was told I refused', told.slice(-600));
  check(done.reply === FINAL, 'the reply is shown in the chat', JSON.stringify(done.reply.slice(0, 200)));
  check(rules().length === 1 && rules()[0].commandPrefix === undefined, 'no rule about a command was saved', JSON.stringify(rules()));
}, {
  setup: ({ workspace }) => {
    writeFileSync(join(workspace, OLD_A), 'stale a\n');
    writeFileSync(join(workspace, OLD_B), 'stale b\n');
    writeFileSync(join(workspace, VICTIM), VICTIM_BYTES);
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
