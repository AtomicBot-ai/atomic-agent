/**
 * screens.mjs: the screens the visual suite shoots, and how to reach each.
 *
 * Picked by the UI quality plan (27.11.2026) from where releases broke most:
 * first run, the chat, Settings, the model picker and the download card.
 * Each screen names the renderer hooks it needs (`hooks`); the runner checks
 * them before shooting and lists a screen whose hook is gone under "Screens
 * left out" in the report, instead of guessing a new way in. Every hook used
 * here already exists in renderer.js and is used by the smoke suite or
 * visual.drive.mjs; none is added for this suite.
 *
 * The first-run screens are reached the way visual.drive.mjs reaches them
 * (real clicks on Cloud models, a provider row, Continue). The app screens
 * are opened through the same hooks the smoke suite uses, since what is
 * compared is the picture, not the path to it.
 *
 * `run(app)` leaves the screen up for the shot. `after(app)` puts the window
 * back to the plain chat for the next screen. `check`, when set, is read
 * once more after the shot is ready and must still hold. `quick: true`
 * would shoot without waiting for the page to go quiet; no screen needs it
 * today (a title card opened by __obOpen arms no auto-advance timer, only
 * openOnboarding does).
 */

import { sleep } from '../drive.mjs';

/** A fixed assistant reply: prose, a list and a code block, so the
    markdown styles are in the picture. Never a live model. */
export const STUB_QUESTION = 'How do I list the ten largest files in this folder?';
export const STUB_ANSWER = [
  'Here are two ways to do it.',
  '',
  '1. **Terminal**: sort by size and keep the top ten.',
  '2. **Finder**: switch to list view and sort by *Size*.',
  '',
  '```sh',
  'du -ah . | sort -rh | head -n 10',
  '```',
  '',
  'The first column is the size, the second is the path.',
].join('\n');

const call = (app, expr) => app.eval(`(() => { ${expr}; return true; })()`);

/** Close the first-run flow if it is up. act() refuses everything while it is. */
export async function leaveOnboarding(app) {
  await app.eval('window.__ob && window.__ob().open ? window.__obClose() : null').catch(() => null);
  await sleep(200);
}

/** The plain chat, nothing open over it. */
export async function backToChat(app) {
  await app.eval(`(() => {
    try { if (window.__sel && window.__sel().open) window.__selClose(); } catch (e) {}
    try { if (window.__settingsPane && window.__settingsPane()) window.__settingsClose(); } catch (e) {}
    try { if (window.__dl && window.__dl().running) window.__dlClear(); } catch (e) {}
    try { if (window.__ctxDraft) window.__ctxDraft(''); } catch (e) {}
    try { if (window.__quiesce) window.__quiesce(); } catch (e) {}
    return true;
  })()`).catch(() => null);
  await sleep(200);
}

async function walkToSetup(app) {
  await app.eval("window.__obOpen('intro')");
  await app.waitFor("window.__ob().step === 'intro'", 'the title card', { timeout: 8000 });
  // Reached by a real keypress, as visual.drive.mjs does.
  await app.press('Space');
  await app.waitFor("window.__ob().step === 'choose'", 'the setup step', { timeout: 20000 });
}

async function walkToProviders(app) {
  await walkToSetup(app);
  await app.clickText('Cloud models');
  await app.clickSel('#onboarding .ob-foot .btn-p'); // select, then Continue
  await app.waitFor("!!document.querySelector('.prow')", 'the provider list', { timeout: 20000 });
}

export const SCREENS = [
  {
    id: 'onboarding-title', label: 'First run: title card', phase: 'onboarding',
    hooks: ['__ob', '__obOpen', '__obClose'],
    async run(app) {
      await app.eval("window.__obOpen('intro')");
      await app.waitFor("window.__ob().step === 'intro'", 'the title card', { timeout: 8000 });
      await sleep(250);
    },
    /* If the card has moved on by the time the shot is ready, say so rather than compare the setup step. */
    check: "window.__ob().step === 'intro'",
    after: leaveOnboarding,
  },
  {
    id: 'onboarding-setup', label: 'First run: setup', phase: 'onboarding',
    hooks: ['__ob', '__obOpen', '__obClose'],
    run: walkToSetup,
    after: leaveOnboarding,
  },
  {
    id: 'onboarding-providers', label: 'First run: providers', phase: 'onboarding',
    hooks: ['__ob', '__obOpen', '__obClose'],
    run: walkToProviders,
    after: leaveOnboarding,
  },
  {
    id: 'onboarding-api-key', label: 'First run: API key', phase: 'onboarding',
    hooks: ['__ob', '__obOpen', '__obClose'],
    async run(app) {
      await walkToProviders(app);
      await app.clickSel('.prow', { nth: 0, timeout: 12000 });
      await app.clickSel('#onboarding .ob-foot .btn-p');
      await app.waitFor("!!document.querySelector('#wiz-key')", 'the key screen', { timeout: 20000 });
    },
    after: leaveOnboarding,
  },
  {
    id: 'chat-empty', label: 'Empty chat', phase: 'app',
    hooks: ['__newSession'],
    async run(app) {
      await call(app, 'window.__newSession()');
      await app.waitFor("!document.querySelector('#content .turn.usr')", 'an empty chat', { timeout: 8000 });
    },
    after: backToChat,
  },
  {
    id: 'chat-answer', label: 'Chat with an answer', phase: 'app',
    hooks: ['__newSession', '__pushUser', '__pushAssistant'],
    async run(app) {
      await call(app, 'window.__newSession()');
      await call(app, `window.__pushUser(${JSON.stringify(STUB_QUESTION)})`);
      await call(app, `window.__pushAssistant(${JSON.stringify(STUB_ANSWER)})`);
      await app.waitFor("!!document.querySelector('#content .turn .prose pre, #content .turn .prose code')", 'the stubbed answer', { timeout: 8000 });
    },
    after: async (app) => { await call(app, 'window.__newSession()').catch(() => null); await backToChat(app); },
  },
  {
    id: 'slash-menu', label: 'Slash command menu', phase: 'app',
    hooks: ['__newSession', '__ctxDraft'],
    async run(app) {
      await call(app, 'window.__newSession()');
      await app.clickSel('textarea', { scroll: false });
      await app.type('/');
      await app.waitFor("!!document.querySelector('.slash')", 'the slash menu', { timeout: 8000 });
    },
    after: async (app) => { await app.press('Escape').catch(() => null); await backToChat(app); },
  },
  {
    id: 'settings-general', label: 'Settings: General', phase: 'app',
    hooks: ['__settingsOpen', '__settingsPane', '__settingsClose'],
    async run(app) {
      await app.eval("window.__settingsOpen('general')");
      await app.waitFor("window.__settingsPane() === 'general'", 'Settings, General', { timeout: 8000 });
      await app.waitSteady('#settings .setbody', { quietMs: 800 });
    },
    after: backToChat,
  },
  {
    id: 'settings-models', label: 'Settings: Models', phase: 'app',
    hooks: ['__settingsOpen', '__settingsPane', '__settingsClose'],
    async run(app) {
      await app.eval("window.__settingsOpen('llm')");
      await app.waitFor("window.__settingsPane() === 'llm'", 'Settings, Models', { timeout: 8000 });
      await app.waitSteady('#settings .setbody', { quietMs: 800 });
    },
    after: backToChat,
  },
  {
    id: 'model-picker', label: 'Model picker', phase: 'app',
    hooks: ['__sel', '__selOpen', '__selClose'],
    async run(app) {
      await app.eval("window.__selOpen('model')");
      await app.waitFor("!!document.querySelector('#overlays .selpop')", 'the model picker', { timeout: 8000 });
    },
    after: backToChat,
  },
  {
    id: 'download-card', label: 'Download card', phase: 'app',
    hooks: ['__dl', '__dlSeed', '__dlFeed', '__dlClear', '__dlcard'],
    async run(app) {
      /* A dry job (no process is spawned) and one progress frame, the same
         seed main.ts's smoke uses. One sample keeps the ETA on "estimating",
         which does not depend on how fast the machine is. */
      await app.eval("window.__dlSeed([{kind:'weights', id:'qwen3.5-4b'}])");
      await app.eval("window.__dlFeed({id:'qwen3.5-4b', kind:'weights', percent:42, transferredBytes:2100000000, totalBytes:5000000000})");
      await app.waitFor('window.__dlcard().visible', 'the download card', { timeout: 8000 });
    },
    after: async (app) => { await app.eval('window.__dlClear()').catch(() => null); await backToChat(app); },
  },
];

/**
 * Split the list into screens that can run and screens whose hooks are
 * missing from this build. Pure: `present` is the set of hook names found.
 */
export function partitionByHooks(screens, present) {
  const runnable = [];
  const dropped = [];
  for (const s of screens) {
    const missing = (s.hooks || []).filter((h) => !present.has(h));
    if (missing.length) dropped.push({ id: s.id, label: s.label, reason: `hook${missing.length > 1 ? 's' : ''} not in this build: ${missing.map((h) => `window.${h}`).join(', ')}` });
    else runnable.push(s);
  }
  return { runnable, dropped };
}

/** Every hook any screen needs, for one look at the page. */
export function hooksNeeded(screens) {
  return [...new Set(screens.flatMap((s) => s.hooks || []))].sort();
}
