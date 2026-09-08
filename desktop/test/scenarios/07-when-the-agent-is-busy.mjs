/**
 * 07 — first run on a Mac that is having a bad day.
 *
 * The person: types their API key into the wizard on a machine that is
 * thrashing — a big export running, half a dozen other apps, swap. The
 * agent's own CLI is too slow to answer, and the wizard has to tell them
 * something they can act on.
 *
 * The human result: the words under the key box. This one is entirely about
 * language, because that is the whole of what a person gets here. What they
 * used to get was
 *
 *     Command failed: /Users/valerii/atag-agent/bin/atag config get
 *
 * — a path they never typed, a subcommand they never ran, no reason and no
 * next step. That sentence is what a real, loaded-machine first run died on
 * (scenario 01, 1583s, on a Mac carrying 108 orphaned agents — see 06). The
 * assertions here are: it does not read like that any more, it says what
 * actually happened, and it tells them what to do.
 *
 * The bad day is arranged from outside, before the window opens: the app's
 * documented `ATOMIC_AGENT_BIN` is pointed at a wrapper that passes
 * everything through to the real agent but takes far too long over
 * `config get`. Nothing inside the app is touched, and no tokens are spent —
 * the run never gets as far as a model.
 */

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../drive.mjs';
import {
  scenario, main, check, pick, providerKey, sleep, SCENARIO_NAME,
} from '../harness.mjs';

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app }) => {
  const wizText = `((document.querySelector('#onboarding')||{innerText:''}).innerText)`;
  const errText = `((document.querySelector('#onboarding .ob-err')||{textContent:''}).textContent||'').trim()`;

  await app.waitFor(`!!document.querySelector('#onboarding')`, 'the first-run wizard', { timeout: 90000 });
  for (let i = 0; i < 8; i++) {
    if (await app.eval(`/Cloud models/.test(${wizText})`)) break;
    await app.press('Enter');
    await sleep(500);
  }
  // The rows are two-stage — one click selects, the next activates.
  await pick(app, 'Cloud models', `/LLM provider/.test(${wizText})`, 'the provider list');
  await pick(app, 'AI/ML API', `!!document.querySelector('#wiz-key')`, 'the key field');
  await app.clickSel('#wiz-key');
  await app.typeSecret(providerKey(), 'the AI/ML API key');
  await app.clickText('Next');

  // Somewhere under a minute the wizard has to give up and say so.
  await app.waitFor(`${errText}.length > 0`, 'the wizard telling me something went wrong', { timeout: 120000 });
  const said = await app.eval(errText);
  app.log(`the wizard says: ${JSON.stringify(said)}`);

  check(!/^Command failed:/i.test(said),
    'it does not just echo a command line back at me', JSON.stringify(said));
  check(!/\/atag-agent\/|\/\.local\/bin\/|\/usr\/local\/bin\//.test(said),
    'it does not put a binary path I never typed in front of me', JSON.stringify(said));
  check(/did not answer|timed out|too long|busy/i.test(said),
    'it says what actually happened — the agent did not answer in time', JSON.stringify(said));
  check(/try again|again/i.test(said),
    'it tells me what to do next', JSON.stringify(said));

  // And the way out is still a click away — the step is not a dead end.
  const next = await app.eval(`(() => { const b = [...document.querySelectorAll('#onboarding button')]
    .find((n) => /Next/.test(n.textContent||'')); return b ? !b.disabled : false; })()`);
  check(next, 'the Next button is still there to try again with',
    'the wizard left me on a step with no way forward');

  await app.screenshot(join(app.opts.stateDir, 'busy-machine.png'));
}, {
  firstRunFirst: false,
  setup: ({ base }) => {
    const real = resolveBinary();
    if (!real) throw new Error('no atag binary on this machine to wrap');
    const shim = join(base, 'slow-atag');
    /* Everything passes through. `config get` — the call the wizard makes to
       find out whether the cloud route came up — takes longer than the app is
       willing to wait, which is exactly what a swapping Mac does to it. */
    writeFileSync(shim,
      `#!/bin/sh\n`
      + `if [ "$1" = "config" ] && [ "$2" = "get" ]; then sleep 45; fi\n`
      + `exec ${JSON.stringify(real)} "$@"\n`);
    chmodSync(shim, 0o755);
    return { ATOMIC_AGENT_BIN: shim };
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
