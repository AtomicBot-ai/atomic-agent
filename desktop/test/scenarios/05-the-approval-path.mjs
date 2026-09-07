/**
 * 05 — the approval path.
 *
 * The person: asks for something the agent cannot do without permission,
 * reads the card, and clicks Approve.
 *
 * The human result: the card really appears and really blocks (the work
 * has NOT happened while it is up), the click really releases it, and the
 * work then completes — a file on disk with the contents that were asked
 * for. Deny is checked too, on a second request, because an approval
 * button that approves everything it is shown is not an approval button.
 *
 * This is the scenario the hook-driven suite could least afford to fake:
 * every Approve and Deny here is a mouse press at the button's coordinates.
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
    return { kind: (c.querySelector('.badge') || {}).textContent?.trim() || null,
             text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 260),
             buttons: [...c.querySelectorAll('[data-appr]')].map((b) => b.textContent.trim().slice(0, 40)) };
  })()`);
  app.log(`the card says: ${JSON.stringify(card.text)}`);
  app.log(`its buttons are: ${JSON.stringify(card.buttons)}`);

  check(/approve/i.test(card.buttons.join(' ')) && /deny/i.test(card.buttons.join(' ')),
    'the card offers me both Approve and Deny', JSON.stringify(card.buttons));
  check(!existsSync(target),
    'nothing has happened yet — the file does not exist while the card is still up',
    `${target} already exists, so the gate did not gate`);

  // ---- deny first: the button has to mean something -----------------------
  await app.clickText('Deny');
  await sleep(1200);
  const afterDeny = await waitTurn(app, { timeout: 180000, approve: 'none' });
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

  await app.clickText('Approve');
  app.log('clicked Approve — a real mouse press on the button');

  /* The moment after the click is the one a person judges the app on: did
     anything happen? Approving used to leave the window completely idle —
     no status strip, no clock, a send arrow where Stop belongs — for as long
     as the released tool and the next model call took. Asserted right here,
     before the work finishes, because a second later it is over and the
     evidence is gone. */
  const working = await app.eval(`(() => ({
    strip: (document.querySelector('.statusstrip') || {}).textContent || '',
    stop: !!document.querySelector('.sendbtn.stop'),
  }))()`);
  app.log(`the instant after Approve, the app says: ${JSON.stringify(working)}`);
  check(working.strip.trim().length > 0 && working.stop,
    'the app says it is working the instant I approve, and offers me Stop',
    `strip=${JSON.stringify(working.strip)} stop=${working.stop} — approving left the window looking idle`);

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
    'both the Deny and the Approve are written into the chat where I can see them',
    JSON.stringify(decisions));
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
