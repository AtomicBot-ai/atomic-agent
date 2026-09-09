/**
 * The screenshot set the brief asks for: the first-run flow walked with
 * trusted mouse and keyboard events, at the tester's window size, in both
 * themes.
 *
 * The state directory is a throwaway, not `~/.atomic-agent-desktop`. That is
 * deliberate and drive.mjs refuses the real one outright: it is the operator's
 * live app data, and "make it a first run again" must never mean deleting it
 * from a test. A directory with no config.json is a first run by the same
 * latch the app itself uses (DESKTOP_STATE_WAS_FRESH).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { launch, sleep } from './drive.mjs';

const DIR = process.env.ATAG_SHOT_DIR || '/tmp/atag-shots-state';
const OUT = process.env.ATAG_SHOT_OUT || '/tmp/atag-shots';
const PORT = Number(process.env.ATAG_SHOT_PORT || 9490);
const W = 1470, H = 923;

rmSync(DIR, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const app = await launch({ port: PORT, stateDir: DIR, workspace: '/tmp/atag-shots-ws' });
const shot = async (name) => { await sleep(350); await app.screenshot(`${OUT}/${name}.png`); };

try {
  /* The tester's window, exactly. The app opens at 1280x820, so this is set
     rather than assumed — a layout that holds at 1280 and breaks at 1470 is
     the kind of thing a fixed-size run never sees. */
  await app.send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 2, mobile: false });

  for (const theme of ['dark', 'light']) {
    await app.eval(`window.__theme(${JSON.stringify(theme)})`).catch(() => {});
    await sleep(250);

    // 1 — the title card
    for (let i = 0; i < 90 && !(await app.eval(`window.__ob ? window.__ob().open : false`)); i++) await sleep(250);
    if ((await app.eval(`window.__ob().step`)) !== 'intro') await app.eval(`window.__obOpen('intro')`);
    await shot(`${theme}-1-title-card`);

    // 2 — the setup step, reached by a real keypress
    await app.press('Space');
    await app.waitFor(`window.__ob().step === 'choose'`, 'the setup step', { timeout: 20000 });
    await shot(`${theme}-2-setup`);

    // 3 — the provider list, reached by a real click
    await app.clickText('Cloud models');
    await app.waitFor(`!!document.querySelector('.prow')`, 'the provider list', { timeout: 20000 });
    await shot(`${theme}-3-providers`);

    // 4 — the key screen, reached by clicking a provider row
    await app.clickSel('.prow', { nth: 0, timeout: 12000 });
    await app.waitFor(`!!document.querySelector('#wiz-key')`, 'the key screen', { timeout: 20000 });
    await shot(`${theme}-4-api-key`);

    // 5 — the chat window behind it
    await app.eval(`window.__obClose()`);
    await sleep(600);
    await shot(`${theme}-5-chat`);

    /* F14 — "typing / showed no commands", unconfirmed. Reproduce it before
       changing anything: type the character into the composer with a real
       key event and look. */
    await app.clickSel('textarea', { scroll: false });
    await app.type('/');
    await sleep(500);
    const slash = await app.eval(`(() => {
      const p = document.querySelector('.slash');
      if (!p) return {popover:false};
      const r = p.getBoundingClientRect();
      const co = document.querySelector('.composerwrap');
      const c = co ? co.getBoundingClientRect() : null;
      return {popover:true, rows:p.querySelectorAll('.slashrow').length,
        top:Math.round(r.top), bottom:Math.round(r.bottom),
        clippedByComposer: !!(c && r.top < 0),
        offTop: r.top < 0};
    })()`);
    console.log(`F14 ${theme}: ${JSON.stringify(slash)}`);
    await shot(`${theme}-6-slash`);
    await app.press('Escape');
    await app.eval(`window.__ctxDraft('')`).catch(() => {});
    await sleep(200);

    if (theme === 'dark') await app.eval(`window.__obOpen('intro')`);
  }
  await app.eval(`window.__theme('system')`).catch(() => {});
  console.log(`SHOTS in ${OUT}`);
} finally {
  await app.close();
}
