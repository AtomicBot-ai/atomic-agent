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

  /* The fonts are vendored and the CSP is closed to 'self'. On a file://
     page 'self' can be an opaque origin, in which case the faces would be
     blocked and the app would quietly fall back to Helvetica — the kind of
     thing that looks fine in a screenshot until you compare letterforms. Ask
     the font loader, not the CSS. */
  const fonts = await app.eval(`(async () => {
    await document.fonts.ready;
    return {
      inter: document.fonts.check('600 34px Inter'),
      mono: document.fonts.check('400 13px "DM Mono"'),
      loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight),
    };
  })()`);
  console.log(`FONTS inter=${fonts.inter} mono=${fonts.mono} loaded=${fonts.loaded.length}`);
  if (!fonts.inter || !fonts.mono) {
    console.log('FAIL the vendored fonts did not load — the CSP or the paths are wrong');
  }

  for (const theme of ['dark', 'light']) {
    /* The theme verb goes through act(), and act() refuses everything while
       the first-run flow is open — so setting it with the wizard up did
       nothing at all and the "light" set came out dark. Close the flow, set
       the theme, put the flow back. */
    for (let i = 0; i < 90 && !(await app.eval(`window.__ob ? window.__ob().open : false`)); i++) await sleep(250);
    await app.eval(`window.__obClose()`).catch(() => {});
    await sleep(200);
    await app.eval(`window.__theme(${JSON.stringify(theme)})`).catch(() => {});
    await app.waitFor(
      `(document.documentElement.getAttribute('data-theme') || 'system') === ${JSON.stringify(theme)}`,
      `the ${theme} theme`, { timeout: 8000 });

    // 1 — the title card
    await app.eval(`window.__obOpen('intro')`);
    await sleep(400);
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

  }
  await app.eval(`window.__theme('system')`).catch(() => {});
  console.log(`SHOTS in ${OUT}`);
} finally {
  await app.close();
}
