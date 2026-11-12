/**
 * L22: a plugin with an obviously hostile line is not installed, a merely
 * suspicious one waits for a yes, and an ordinary one installs (ATO-1392).
 *
 * The person: someone installing plugins with `atag plugin install` from a
 * script (no terminal, no --yes), which is how the desktop's own install runs
 * and how a copy-pasted install line runs.
 *
 * The human result:
 *  - evil-hook (a hook that runs `curl … | sh`): refused with "install
 *    blocked: flagged dangerous"; no folder in plugins/installed, no record.
 *  - fetch-note (a skill that only mentions curl): refused with "install needs
 *    confirmation", because there is nobody to say yes; nothing installed.
 *  - a-live-kit (the ordinary plugin of L07): installs, so the check is not
 *    simply refusing everything.
 *  The window's Settings › Plugins then lists only a-live-kit.
 *
 * It fails if either hostile plugin lands on disk or in the list, if the CLI
 * exits 0 for them, or if the ordinary plugin is refused. A check on the
 * check itself: with the remote-exec rule taken out of
 * src/skills/hub/skill-security-scanner.ts this scenario must fail.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, check, main } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { atag, copyFixturePlugin, installedDir, pluginRecord } from './plugin-cli.mjs';

const DANGEROUS = 'evil-hook';
const SUSPICIOUS = 'fetch-note';
const ORDINARY = 'a-live-kit';
const BLOCKED = 'install blocked: flagged dangerous';
const NEEDS_YES = 'install needs confirmation';

const lastLine = (text) => String(text).trim().split('\n').pop() ?? '';
const results = {};

async function openPluginsPane(app) {
  await app.clickSel('.sb-settings');
  await app.clickSel('button.setrow[data-act="settings:plugins"]');
  await app.waitFor(`[...document.querySelectorAll('.set-plgrow')].some((r) => r.textContent.includes(${JSON.stringify(ORDINARY)}))`,
    'the ordinary plugin listed in Settings › Plugins', { timeout: 30000 });
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, base, stateDir, workspace, home }) => {
  const dirs = { base, stateDir, workspace, home };

  // ---- the hostile plugin -------------------------------------------------------
  const evil = results[DANGEROUS];
  app.log(`${DANGEROUS}: exit ${evil.code}, ${JSON.stringify(lastLine(evil.stderr))}`);
  check(evil.code !== 0, `installing ${DANGEROUS} failed`, `exit ${evil.code}: ${evil.stdout}`);
  check(lastLine(evil.stderr).includes(BLOCKED), `the CLI said "${BLOCKED}"`, evil.stderr.slice(-600));
  check(/remote-exec/.test(evil.stderr), 'the CLI named the remote-exec finding', evil.stderr.slice(-600));
  check(!existsSync(installedDir(stateDir, DANGEROUS)), `no folder for ${DANGEROUS} in plugins/installed`);
  check(pluginRecord(stateDir, DANGEROUS) === undefined, `no record for ${DANGEROUS} in plugins.json`);

  // ---- the suspicious plugin -------------------------------------------------------
  const sus = results[SUSPICIOUS];
  app.log(`${SUSPICIOUS}: exit ${sus.code}, ${JSON.stringify(lastLine(sus.stderr))}`);
  check(sus.code !== 0, `installing ${SUSPICIOUS} without --yes failed`, `exit ${sus.code}: ${sus.stdout}`);
  check(lastLine(sus.stderr).includes(NEEDS_YES), `the CLI said "${NEEDS_YES}"`, sus.stderr.slice(-600));
  check(!existsSync(installedDir(stateDir, SUSPICIOUS)), `no folder for ${SUSPICIOUS} in plugins/installed`);
  check(pluginRecord(stateDir, SUSPICIOUS) === undefined, `no record for ${SUSPICIOUS} in plugins.json`);

  // ---- the ordinary plugin -------------------------------------------------------------
  const ok = results[ORDINARY];
  check(ok.code === 0 && ok.stdout.includes(`Installed ${ORDINARY}@`), `the ordinary plugin ${ORDINARY} installed`,
    `exit ${ok.code}: ${ok.stdout}${ok.stderr}`);
  check(pluginRecord(stateDir, ORDINARY) !== undefined, `${ORDINARY} has its record`);

  const list = await atag(dirs, ['plugin', 'list', '--json']);
  const names = JSON.parse(lastLine(list.stdout)).plugins.map((p) => p.name);
  check(names.join(',') === ORDINARY, 'the CLI lists only the ordinary plugin', JSON.stringify(names));

  // ---- what the person sees ------------------------------------------------------------
  await openPluginsPane(app);
  const rows = await app.eval(`[...document.querySelectorAll('.set-plgrow')].map((r) => r.innerText.replace(/\\s+/g, ' '))`);
  app.log(`Settings › Plugins shows: ${JSON.stringify(rows)}`);
  check(!rows.some((r) => r.includes(DANGEROUS) || r.includes(SUSPICIOUS)),
    'the window lists neither hostile plugin', JSON.stringify(rows));
  await app.clickSel('[data-act="settings:close"]');
}, {
  setup: async ({ base, stateDir, workspace, home }) => {
    const dirs = { stateDir, workspace, home };
    /* Installed before the window opens, the way L07 does it, so the pane
       reads them on its first load. The ordinary plugin's server gets this
       run's Node, as in L07; it stays off anyway until code is allowed. */
    for (const name of [DANGEROUS, SUSPICIOUS, ORDINARY]) {
      const source = copyFixturePlugin(name, base);
      if (name === ORDINARY) {
        const mcpFile = join(source, '.mcp.json');
        const mcp = JSON.parse(readFileSync(mcpFile, 'utf8'));
        mcp.mcpServers.probe.command = process.execPath;
        writeFileSync(mcpFile, JSON.stringify(mcp, null, 2));
      }
      results[name] = await atag(dirs, ['plugin', 'install', source]);
      console.log(`   atag plugin install ${name}: exit ${results[name].code}, ${lastLine(results[name].stderr || results[name].stdout)}`);
    }
    return null;
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
