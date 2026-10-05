/**
 * 05 — the approval path.
 *
 * The person: asks for something the agent cannot do without permission,
 * reads the card, and clicks Allow once.
 *
 * The human result: the card really appears and really blocks (the work
 * has NOT happened while it is up), the click really releases it, and the
 * work then completes — a file on disk with the contents that were asked
 * for. Deny is checked too, on a second request, because an approval
 * button that approves everything it is shown is not an approval button.
 *
 * This is the scenario the hook-driven suite could least afford to fake:
 * every Allow once and Deny here is a mouse press at the button's coordinates.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scenario, main, ask, waitTurn, check, modelDidNot, sleep, SCENARIO_NAME,
} from '../harness.mjs';

const STAMP = 'moray-firth-2026';

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app, workspace }) => {
  const target = join(workspace, 'approved.txt');

  await ask(app,
    `Using a shell command, create a file called approved.txt here whose only contents are the `
    + `single line "${STAMP}". Use the shell for this, not anything else. Then tell me it is done.`);

  // ---- the card must appear, and must actually gate -----------------------
  const gated = await waitTurn(app, { timeout: 240000, approve: 'none' });
  if (!gated.pending) {
    modelDidNot('reach for a tool that needs approval — nothing was put to me to approve',
      `reply so far: ${JSON.stringify(gated.reply.slice(0, 200))}`);
  }
  check(true, 'the agent stopped and asked me before running anything');

  const card = await app.eval(`(() => {
    const c = document.querySelector('#apprcard');
    return { kind: (c.querySelector('.ttl') || {}).textContent?.trim() || null,
             text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 260),
             buttons: [...c.querySelectorAll('[data-appr]')].map((b) => b.textContent.trim().slice(0, 40)) };
  })()`);
  app.log(`the card says: ${JSON.stringify(card.text)}`);
  app.log(`its buttons are: ${JSON.stringify(card.buttons)}`);

  /* Calm (S4): the card's buttons read "Allow once" and "Deny" — since 05.10
     with their keys on them ("Allow once ⌘↩", "Deny ⌘."); the match is by
     inclusion, so both still read as asked. */
  check(/allow once/i.test(card.buttons.join(' ')) && /deny/i.test(card.buttons.join(' ')),
    'the card offers me both Allow once and Deny', JSON.stringify(card.buttons));
  check(!existsSync(target),
    'nothing has happened yet — the file does not exist while the card is still up',
    `${target} already exists, so the gate did not gate`);

  // ---- deny first: the button has to mean something -----------------------
  /* Scoped to the card: `#apprcard` is the request the keys answer, and once
     answered the page also carries a "Denied" receipt. */
  await app.clickText('Deny', { scope: '#apprcard' });
  await sleep(1200);
  let afterDeny = await waitTurn(app, { timeout: 180000, approve: 'none' });
  /* A model told no may try the same thing another way, which puts a new
     card up in the same turn. A person keeps saying no until the turn ends;
     the next question asked under an open card would only go into this turn
     as a message, and the card would keep waiting (ATO-227). */
  for (let again = 0; afterDeny.pending && again < 3; again++) {
    app.log('it asked again in the same turn — Deny again');
    const had = await app.eval(`document.querySelectorAll('#scroller .appr.done').length`);
    await app.clickText('Deny', { scope: '#apprcard' });
    await app.waitFor(`document.querySelectorAll('#scroller .appr.done').length > ${had}`,
      'that Deny answered the card', { timeout: 15000 });
    afterDeny = await waitTurn(app, { timeout: 180000, approve: 'none' });
  }
  if (afterDeny.pending) modelDidNot('take no for an answer — it kept asking after four Denies');
  check(!existsSync(target),
    'clicking Deny left the file uncreated — the button is wired to a real refusal',
    `${target} exists after a Deny`);
  app.log(`after Deny the agent said: ${JSON.stringify(afterDeny.reply.slice(0, 160))}`);

  // ---- now ask again and approve, with a real click ------------------------
  await ask(app, `Sorry — go ahead and do it now. Same thing: a shell command that writes the `
    + `single line "${STAMP}" into approved.txt here.`);
  const asked = await waitTurn(app, { timeout: 240000, approve: 'none' });
  if (!asked.pending) {
    modelDidNot('ask again on the second attempt', JSON.stringify(asked.reply.slice(0, 200)));
  }
  check(true, 'it asked again rather than remembering a permission I never gave');

  await app.clickText('Allow once', { scope: '#apprcard' });
  app.log('clicked Allow once — a real mouse press on the button');

  /* The moment after the click is the one a person judges the app on: did
     anything happen? Approving used to leave the window completely idle —
     no status strip, no clock, a send arrow where Stop belongs — for as long
     as the released tool and the next model call took. Asserted right here,
     before the work finishes, because a second later it is over and the
     evidence is gone. */
  /* Calm: "working" is the composer lighting up (the travelling band, drawn
     while `#composer.cl-on`), not a "Thinking 1.3s" strip above it. */
  const working = await app.eval(`(() => ({
    lit: !!document.querySelector('#composer.cl-on .cloader'),
    stop: !!document.querySelector('.sendbtn.stop'),
  }))()`);
  app.log(`the instant after Allow once, the app says: ${JSON.stringify(working)}`);
  check(working.lit && working.stop,
    'the app says it is working the instant I approve, and offers me Stop',
    `composer lit=${working.lit} stop=${working.stop} — approving left the window looking idle`);

  const done = await waitTurn(app, { timeout: 240000 });

  check(existsSync(target), 'the file exists now that I approved it',
    `${target} is still missing; the agent said ${JSON.stringify(done.reply.slice(0, 200))}`);
  const body = readFileSync(target, 'utf8');
  check(body.trim() === STAMP, `approved.txt holds exactly “${STAMP}”`, JSON.stringify(body));
  check(done.reply.trim().length > 0, 'the agent reported back in the chat once it was through',
    JSON.stringify(done.reply.slice(0, 200)));

  // The record of what I decided is still on screen.
  const decisions = await app.eval(`(() => [...document.querySelectorAll('#content .turn')]
    .map((n) => n.innerText.replace(/\\s+/g, ' ').trim())
    .filter((t) => /^(Approved|Denied)\\b/.test(t)).map((t) => t.slice(0, 40)))()`);
  app.log(`the chat records my decisions as: ${JSON.stringify(decisions)}`);
  check(decisions.some((d) => /^Denied/.test(d)) && decisions.some((d) => /^Approved/.test(d)),
    'both the Deny and the Allow once are written into the chat where I can see them',
    JSON.stringify(decisions));
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
