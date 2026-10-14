/**
 * state-guard.mjs — the one check every driven launch makes before it
 * starts an app: the state dir it was handed is a throwaway, never the
 * operator's real profile.
 *
 * Four drivers (`drive.mjs`, `drive-ux.mjs`, `drive-selector-lib.mjs`,
 * `drive-cloud-lib.mjs`) each spawn Electron with `ATOMIC_AGENT_STATE_DIR`
 * set to the caller's state dir, and most scenarios take that dir from an
 * inherited `ATOMIC_AGENT_STATE_DIR` or `--state`. Until this module only
 * `drive.mjs` compared it against the real profile, and only by string, so
 * a symlink to it, a relative path or any of the other three drivers went
 * straight through to real config, real keys and a real model load.
 *
 * Refused:
 * - no state dir at all;
 * - a relative one: `main/state-dir.ts` ignores a non-absolute
 *   `ATOMIC_AGENT_STATE_DIR` and falls back to the desktop's default, which
 *   IS the operator's live profile;
 * - anything that resolves (symlinks followed where the path exists) to
 *   `~/.atomic-agent`, `~/.atomic-agent-desktop`, an absolute
 *   `ATOMIC_AGENT_DESKTOP_STATE_DIR`, or on macOS the installed app's
 *   Electron profile `~/Library/Application Support/Atomic Agent`.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';

/** Absolute the way `main/state-dir.ts` `absoluteEnv` means it. */
function isAbsoluteForApp(p, platform) {
  return platform === 'win32' ? win32.isAbsolute(p) : p.startsWith('/');
}

/**
 * The path with every symlink in it followed. For a path that does not
 * exist yet, its nearest existing ancestor is followed and the rest kept
 * as written, so `/var/...` and `/private/var/...` still compare equal.
 */
function canonical(p, platform) {
  let head = resolve(p);
  let tail = '';
  let out = head;
  for (;;) {
    try { out = join(realpathSync.native(head), tail); break; } catch { /* not there: try the parent */ }
    const up = dirname(head);
    if (up === head) { out = resolve(p); break; }
    tail = tail ? join(basename(head), tail) : basename(head);
    head = up;
  }
  // APFS and NTFS are case-insensitive by default.
  return platform === 'darwin' || platform === 'win32' ? out.toLowerCase() : out;
}

/**
 * Throw unless `stateDir` is safe to hand a driven app.
 *
 * @param {string} stateDir
 * @param {object} [o]
 * @param {string} [o.home]      defaults to both $HOME and os.homedir() (they differ on Windows)
 * @param {object} [o.env]       defaults to process.env
 * @param {string} [o.platform]  defaults to process.platform
 */
export function assertThrowawayStateDir(stateDir, o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const homes = o.home ? [o.home] : [...new Set([process.env.HOME, homedir()].filter(Boolean))];
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (!dir) throw new Error('refusing to launch without a stateDir: the app would run on real app data');
  if (!isAbsoluteForApp(dir, platform)) {
    throw new Error(`refusing to launch against ${stateDir}: the app ignores a relative state dir `
      + 'and falls back to real app data. Pass an absolute throwaway path');
  }
  const real = homes.flatMap((h) => [join(h, '.atomic-agent'), join(h, '.atomic-agent-desktop')]);
  const named = typeof env.ATOMIC_AGENT_DESKTOP_STATE_DIR === 'string' ? env.ATOMIC_AGENT_DESKTOP_STATE_DIR.trim() : '';
  if (named && isAbsoluteForApp(named, platform)) real.push(named);
  if (platform === 'darwin') real.push(...homes.map((h) => join(h, 'Library', 'Application Support', 'Atomic Agent')));
  const mine = canonical(dir, platform);
  const hit = real.find((r) => canonical(r, platform) === mine);
  if (hit) throw new Error(`refusing to launch against ${stateDir}: that is real app data (${hit})`);
}

/**
 * The environment a driven app starts with: this process's own, then each
 * of `layers` in order, and `ATOMIC_AGENT_STATE_DIR` set LAST to the
 * guarded `stateDir`. A caller's `env: { ATOMIC_AGENT_STATE_DIR: ... }`
 * used to be spread after it and win, so the app ran on a dir nobody had
 * checked. Every launch() builds its env here so that cannot come back.
 *
 * @param {string} stateDir  already passed through assertThrowawayStateDir
 * @param {...object} layers  extra variables, later ones winning
 */
export function driveEnv(stateDir, ...layers) {
  return Object.assign({}, process.env, ...layers.filter(Boolean), { ATOMIC_AGENT_STATE_DIR: stateDir });
}
