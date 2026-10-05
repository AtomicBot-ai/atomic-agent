/**
 * 08 — answering an approval from the keyboard, with a message half written.
 *
 * The person: works in Ask first, asks for something that needs permission,
 * and while the card waits they start typing their NEXT message in the box.
 * They allow the call with ⌘↩ without leaving the box. Later, on a second
 * request, they type a stray "y" (a word starting with y, a slip) and the
 * card must not take it as a yes; ⌘. denies.
 *
 * The human result (05.10):
 *   - the card appears and does not take the focus;
 *   - ⌘↩ allows the call, and the words in the box stay there, unsent;
 *   - a bare `y` is a letter in the box, not an answer;
 *   - ⌘. denies, and the denied file never appears.
 *
 * Everything is trusted input: clicks and key presses over CDP (drive.mjs).
 * Off macOS the chords are Ctrl+↩ / Ctrl+. (MOD_KEY).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scenario, main, ask, waitTurn, chooseMode, check, modelDidNot, sleep, MOD_KEY, SCENARIO_NAME,
} from '../harness.mjs';

const FIRST = 'kittiwake-08';
const SECOND = 'fulmar-08';
const CHORD = MOD_KEY === 'meta' ? '⌘' : 'Ctrl+';

/** What a person can read off the screen about the approvals so far. */
const looks = (app) => app.eval(`(() => ({
  open: !!document.querySelector('#apprcard'),
  receipts: [...document.querySelectorAll('#scroller .appr.done .apprlbl b')].map((n) => n.textContent.trim()),
  mine: document.querySelectorAll('#content .turn.usr').length,
  box: (document.querySelector('#entry') || {}).value || '',
  focusInCard: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.appr')),
}))()`);

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app, workspace }) => {
  const one = join(workspace, 'first.txt');
  const two = join(workspace, 'second.txt');
  /* The next message, typed while the first card waits. It is a real
     request: once the first turn is over it is sent as it stands. */
  const DRAFT = `Next, with a shell command again, create a file called second.txt here whose only `
    + `contents are the single line "${SECOND}". Use the shell for this. Then tell me it is done.`;

  // ---- Ask first, picked from the Mode chip --------------------------------
  await chooseMode(app, 'default');
  check(await app.eval(`(document.querySelector('.cmodechip')||{dataset:{}}).dataset.id === 'default'`),
    'the Mode chip reads Ask first');
  check(!(await app.eval(`!!document.querySelector('.modewarn')`)),
    'Ask first really asks here (the approval level is not 5)');

  // ---- the first request: a card, and it does not take the focus ----------
  await ask(app,
    `Using a shell command, create a file called first.txt here whose only contents are the `
    + `single line "${FIRST}". Use the shell for this, not anything else. Then tell me it is done.`);
  const gated = await waitTurn(app, { timeout: 240000, approve: 'none' });
  if (!gated.pending) {
    modelDidNot('reach for a tool that needs approval', `reply so far: ${JSON.stringify(gated.reply.slice(0, 200))}`);
  }
  let s = await looks(app);
  check(s.open, 'the approval card is up');
  check(!s.focusInCard, 'the card did not take the focus (nothing a person types can land on its buttons)');
  const labels = await app.eval(`[...document.querySelectorAll('#apprcard [data-appr]')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim())`);
  app.log(`the card's buttons: ${JSON.stringify(labels)}`);
  check(labels.some((l) => l.includes('Allow once') && l.includes(`${CHORD}↩`))
      && labels.some((l) => l.includes('Deny') && l.includes(`${CHORD}.`)),
    `the buttons name their keys: Allow once ${CHORD}↩, Deny ${CHORD}.`, JSON.stringify(labels));
  check(!existsSync(one), 'nothing has run while the card is up');

  // ---- a draft in the box, then ⌘↩ from inside the box ---------------------
  await app.clickSel('#entry');
  await app.type(DRAFT, { perChar: 1 });
  s = await looks(app);
  check(s.box === DRAFT, 'what I typed is in the box', JSON.stringify(s.box.slice(0, 80)));
  check(s.open && !s.receipts.length, 'typing in the box did not answer the card');
  const mineBefore = s.mine;

  await app.press('Enter', [MOD_KEY]);
  await app.waitFor(`!document.querySelector('#apprcard') || [...document.querySelectorAll('#scroller .appr.done .apprlbl b')].length > 0`,
    `the card answered by ${CHORD}↩`, { timeout: 15000 });
  s = await looks(app);
  check(s.receipts.includes('Approved'), `${CHORD}↩ allowed the call — the chat says Approved`, JSON.stringify(s.receipts));
  check(s.box === DRAFT, `${CHORD}↩ left my draft in the box, word for word`, JSON.stringify(s.box.slice(0, 80)));
  check(s.mine === mineBefore, `${CHORD}↩ did not send the draft as a message`, `${mineBefore} → ${s.mine} messages of mine`);

  /* At Ask first everything asks, so a model that checks its work (`cat
     first.txt`) puts up another card in the same turn. Allow those the same
     way — from the box, with the draft in it. */
  let firstDone = await waitTurn(app, { timeout: 240000, approve: 'none' });
  for (let more = 0; firstDone.pending && more < 5; more++) {
    await app.clickSel('#entry');
    await app.press('Enter', [MOD_KEY]);
    await sleep(1200);
    check((await looks(app)).box === DRAFT, `another ${CHORD}↩ in the same turn still left the draft alone`);
    firstDone = await waitTurn(app, { timeout: 240000, approve: 'none' });
  }
  if (firstDone.pending) modelDidNot('finish the first request — it kept asking for more');
  check(existsSync(one), 'first.txt exists — the call I allowed ran');
  check(readFileSync(one, 'utf8').trim() === FIRST, `first.txt holds “${FIRST}”`, JSON.stringify(readFileSync(one, 'utf8')));
  s = await looks(app);
  check(s.box === DRAFT, 'the draft is still in the box after the turn ended', JSON.stringify(s.box.slice(0, 80)));

  // ---- the draft goes out as the second request ----------------------------
  app.repliesBefore = (await app.replies()).length;
  await app.clickSel('.sendbtn');
  await app.waitFor(`(document.querySelector('#entry')||{}).value === ''`, 'the draft sent', { timeout: 20000 });
  const asked = await waitTurn(app, { timeout: 240000, approve: 'none' });
  if (!asked.pending) modelDidNot('ask before the second shell command', JSON.stringify(asked.reply.slice(0, 200)));
  s = await looks(app);
  check(s.open && !s.focusInCard, 'the second card is up, and the focus is not on it');
  const receiptsBefore = s.receipts.length;

  // ---- a bare y is a letter ------------------------------------------------
  await app.clickSel('#entry');
  await app.press('y');
  await sleep(1200);
  s = await looks(app);
  check(s.box === 'y', 'a bare y typed into the box is just the letter y', JSON.stringify(s.box));
  check(s.open && s.receipts.length === receiptsBefore, 'and it did not answer the card');
  check(!existsSync(two), 'second.txt does not exist — nothing was allowed');

  // ---- ⌘. denies -------------------------------------------------------------
  await app.press('.', [MOD_KEY]);
  await app.waitFor(`[...document.querySelectorAll('#scroller .appr.done .apprlbl b')].length > ${receiptsBefore}`,
    `the card answered by ${CHORD}.`, { timeout: 15000 });
  s = await looks(app);
  check(s.receipts[s.receipts.length - 1] === 'Denied' || s.receipts.includes('Denied'),
    `${CHORD}. denied the call — the chat says Denied`, JSON.stringify(s.receipts));
  check(s.box === 'y', `${CHORD}. left the box as it was`, JSON.stringify(s.box));

  /* A model told no may try again in the same turn; keep saying no with the
     same key until the turn is over. */
  let after = await waitTurn(app, { timeout: 180000, approve: 'none' });
  for (let again = 0; after.pending && again < 3; again++) {
    app.log(`it asked again in the same turn — ${CHORD}. again`);
    await app.press('.', [MOD_KEY]);
    await sleep(1200);
    after = await waitTurn(app, { timeout: 180000, approve: 'none' });
  }
  check(!existsSync(two), 'second.txt was never created — the denial held');
  app.log(`after the denial the agent said: ${JSON.stringify(after.reply.slice(0, 160))}`);
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
