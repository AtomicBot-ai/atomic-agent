/**
 * settings-plugins.mjs: driving Settings › Plugins in the live scenarios
 * (L07, L08, L22) without clicking into a window that is still redrawing.
 * The file name does not start with L, so run-all.mjs skips it.
 *
 * ATO-1755 found it in L08, ATO-2439 moved it here for L07 and L22. Settings
 * rebuilds its whole window with innerHTML on every render, and the Plugins
 * pane renders again when a write answers and again when the list read after
 * it lands (plugins-pane.js plgWrite, pluginsRefresh). plugins.json is on disk
 * BEFORE that answer comes back (the CLI writes it, then exits, then the IPC
 * answers), so "saved" is not "done redrawing": the "saving…" question still
 * lies over the window and the rows are about to move. A click pressed in that
 * gap lands on nothing, and the next step goes into nothing. The gap grows when
 * the machine is busy, which is why only the full run hit it.
 */

/* The pane is done when nothing it shows is still working: the Refresh button
   is there and not disabled (no list read running), no row shows a spinner
   (no write running), no question is open. */
export const PANE_SETTLED = `!!document.querySelector('[data-act="plugins:refresh"]')`
  + ` && !document.querySelector('[data-act="plugins:refresh"][disabled]')`
  + ` && !document.querySelector('.set-plgrow .tk-spin')`
  + ` && !document.querySelector('#settings .set-overlay')`;

export const paneSettled = (app, what) =>
  app.waitFor(PANE_SETTLED, `Settings › Plugins done redrawing ${what}`, { timeout: 30000 });

/** Settings › Plugins, by clicking, once `name` is listed and the pane holds still. */
export async function openPluginsPane(app, name) {
  await app.clickSelSteady('.sb-settings');
  await app.clickSelSteady('button.setrow[data-act="settings:plugins"]');
  await app.waitFor(`[...document.querySelectorAll('.set-plgrow')].some((r) => r.textContent.includes(${JSON.stringify(name)}))`,
    'the plugin listed in Settings › Plugins', { timeout: 30000 });
  await paneSettled(app, 'after opening');
}

/* Done, once it holds still, and Settings really gone before anything is typed. */
export async function closeSettings(app) {
  await app.clickSelSteady('[data-act="settings:close"]');
  await app.waitFor(`!document.querySelector('#settings')`, 'Settings closed', { timeout: 10000 });
}
