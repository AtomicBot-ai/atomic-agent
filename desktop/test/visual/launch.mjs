/**
 * launch.mjs: start the app for the visual suite, on macOS, Linux and Windows.
 *
 * On macOS and Linux this is drive.mjs `launch`, unchanged. On Windows that
 * one cannot run: it spawns node_modules/.bin/electron (a .cmd shim there,
 * which Node will not spawn without a shell) and ends the app by process
 * group. So on win32 the Electron binary is resolved the way
 * scripts/smoke-ci.mjs does it (node_modules/electron/path.txt), the tree is
 * ended with taskkill /T, and the page is driven by drive.mjs's own App
 * class, so every click, key and wait is the same code on both.
 *
 * The agent is whatever ATOMIC_AGENT_BIN names (CI points it at the staged
 * bundle .exe), else the app's own lookup.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { App, DESKTOP_DIR, launch as driveLaunch } from '../drive.mjs';
import { assertThrowawayStateDir, driveEnv } from '../state-guard.mjs';

const WIN = process.platform === 'win32';

function electronBinary() {
  const dir = join(DESKTOP_DIR, 'node_modules', 'electron');
  const pathFile = join(dir, 'path.txt');
  if (!existsSync(pathFile)) throw new Error('electron is not installed in desktop/node_modules (run npm ci in desktop/)');
  const bin = join(dir, 'dist', readFileSync(pathFile, 'utf8').trim());
  if (!existsSync(bin)) throw new Error(`electron binary missing: ${bin}`);
  return bin;
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.pid === undefined) return;
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  spawnSync(join(sysRoot, 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function launchWindows(o) {
  assertThrowawayStateDir(o.stateDir);
  mkdirSync(o.stateDir, { recursive: true });
  if (o.workspace) mkdirSync(o.workspace, { recursive: true });
  if (!existsSync(join(DESKTOP_DIR, 'out', 'main', 'main.js'))) {
    throw new Error('desktop/out is missing: run `npm run build` in desktop/ first');
  }
  /* Windows reads the profile from USERPROFILE / APPDATA, not HOME, so the
     run gets its own copies inside the throwaway dir, as smoke-ci.mjs does. */
  const home = join(o.stateDir, 'home');
  const appData = join(home, 'AppData', 'Roaming');
  const localAppData = join(home, 'AppData', 'Local');
  for (const d of [home, appData, localAppData]) mkdirSync(d, { recursive: true });
  const env = driveEnv(
    o.stateDir,
    { HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData },
    o.workspace ? { ATOMIC_AGENT_WORKSPACE: o.workspace } : {},
    o.env,
  );
  delete env.ELECTRON_RUN_AS_NODE;

  const proc = spawn(electronBinary(), [
    '.',
    `--remote-debugging-port=${o.port}`,
    `--user-data-dir=${join(o.stateDir, '.chromium-profile')}`,
    ...(o.args || []),
  ], { cwd: DESKTOP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false, windowsHide: false });

  const app = new App(proc, o);
  proc.stdout.on('data', (b) => app._out.push(String(b)));
  proc.stderr.on('data', (b) => app._out.push(String(b)));
  const bye = () => killTree(proc);
  process.on('exit', bye);

  /* App.kill signals the process group, which Windows does not have; the
     tree goes through taskkill first, then App.close waits for the port. */
  const close = app.close.bind(app);
  app.close = async () => { killTree(proc); await close(); process.off('exit', bye); };

  try {
    await app.connect(o.launchTimeout ?? 90000);
  } catch (e) {
    killTree(proc);
    throw e;
  }
  app.log(`launched: state=${o.stateDir} cdp=${o.port}`);
  return app;
}

/** Same options as drive.mjs `launch`. */
export function launchApp(o) {
  return WIN ? launchWindows(o) : driveLaunch(o);
}
