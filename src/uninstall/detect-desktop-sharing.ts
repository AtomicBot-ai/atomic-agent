import { existsSync, readFileSync } from "node:fs";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";

/**
 * Since Desktop 0.0.3 / terminal 0.6.9 the desktop app runs on the
 * terminal agent's own state directory (`~/.atomic-agent`, or whatever
 * `ATOMIC_AGENT_STATE_DIR` names). Removing that directory therefore
 * removes the desktop's chats, memory, settings, API keys and models
 * as well. This module only finds out whether that is the case; it
 * never changes what the plan removes.
 *
 * Which evidence was seen:
 * - `state-dirs-record`: the desktop's own record of the state
 *   directories it has run on (`state-dirs.json` in Electron's userData,
 *   written on every launch; desktop/main/shared-state-notice.ts) lists
 *   the directory being removed.
 * - `app-installed`: the desktop app is installed in its usual place.
 * - `legacy-dir`: `~/.atomic-agent-desktop`, the directory desktops
 *   before 0.0.3 used, is still there.
 */
export type DesktopSignal = "state-dirs-record" | "app-installed" | "legacy-dir";

export interface DesktopSharing {
  /** The state directory this was checked against, resolved. */
  readonly stateDir: string;
  /** Every signal seen. Empty when no trace of the desktop app was found. */
  readonly signals: readonly DesktopSignal[];
  /**
   * Whether a current desktop app (0.0.3 or later) uses `stateDir`, so
   * removing it removes the desktop's data too. True on the record
   * signal, or on an installed app when `stateDir` is the desktop's
   * default directory.
   *
   * The legacy directory on its own does NOT set this. It proves only
   * that a desktop from before 0.0.3 ran here, and that desktop kept its
   * data in `~/.atomic-agent-desktop`, not in this folder. An upgraded
   * desktop shows up through the other two signals (it is installed, and
   * it records the directory on every launch), so claiming "the desktop
   * uses this folder" from the legacy directory alone would be a guess.
   */
  readonly sharesStateDir: boolean;
  /**
   * `~/.atomic-agent-desktop` when it exists and is not itself the
   * directory being removed. The plan never deletes it; the output only
   * says it was left in place.
   */
  readonly legacyDir: string | null;
}

export interface DetectDesktopSharingInput {
  /** `getConfig().paths.stateDir`: the folder the plan removes. */
  readonly stateDir: string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Injectable for tests. Defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
  /** Injectable for tests. Defaults to a UTF-8 `fs.readFileSync`. */
  readonly readFile?: (path: string) => string;
}

/** The desktop's productName (desktop/electron-builder.cjs). */
const PRODUCT_NAME = "Atomic Agent";

/** A sharing result for a plan that was not checked (or found nothing). */
export function noDesktopSharing(stateDir: string): DesktopSharing {
  return { stateDir, signals: [], sharesStateDir: false, legacyDir: null };
}

/**
 * Look for the desktop app around the state directory being removed.
 * Never throws: an unreadable record or a failing stat counts as "this
 * signal was not seen", because the result only adds a warning.
 */
export function detectDesktopSharing(
  input: DetectDesktopSharingInput,
): DesktopSharing {
  const path = input.platform === "win32" ? pathWin32 : pathPosix;
  const probe = input.exists ?? ((file: string) => existsSync(file));
  const exists = (file: string): boolean => {
    try {
      return probe(file);
    } catch {
      return false;
    }
  };
  const readFile = input.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const stateDir = path.resolve(input.stateDir);
  const same = (a: string, b: string): boolean =>
    comparable(input.platform, a) === comparable(input.platform, b);

  const signals: DesktopSignal[] = [];

  const userData = userDataDir(input.platform, input.homeDir, input.env);
  const record = userData
    ? readRecordedDirs(path.join(userData, "state-dirs.json"), readFile)
    : [];
  const recorded = record.some((dir) => same(dir, stateDir));
  if (recorded) signals.push("state-dirs-record");

  const installed = installCandidates(input.platform, input.homeDir, input.env)
    .some((candidate) => exists(candidate));
  if (installed) signals.push("app-installed");

  const legacy = path.resolve(input.homeDir, ".atomic-agent-desktop");
  const legacyPresent = exists(legacy);
  if (legacyPresent) signals.push("legacy-dir");

  // An installed desktop that never recorded this folder still runs on
  // its default, `~/.atomic-agent`, so it shares only that one. A
  // custom ATOMIC_AGENT_STATE_DIR elsewhere is not the desktop's folder
  // unless its own record says so. (A still-installed desktop older
  // than 0.0.3 would also match here; warning about data it does not
  // keep in this folder is the safe side of that error.)
  const isDesktopDefault = same(stateDir, path.resolve(input.homeDir, ".atomic-agent"));
  const sharesStateDir = recorded || (installed && isDesktopDefault);

  return {
    stateDir,
    signals,
    sharesStateDir,
    legacyDir: legacyPresent && !same(legacy, stateDir) ? legacy : null,
  };
}

/**
 * Electron's default userData: `<appData>/<productName>`. The desktop
 * never calls `app.setPath("userData")`, so this is where its
 * `state-dirs.json` lives.
 */
function userDataDir(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  switch (platform) {
    case "darwin":
      return pathPosix.join(homeDir, "Library", "Application Support", PRODUCT_NAME);
    case "win32": {
      const appData = nonEmpty(env["APPDATA"]) ??
        pathWin32.join(homeDir, "AppData", "Roaming");
      return pathWin32.join(appData, PRODUCT_NAME);
    }
    case "linux": {
      const config = nonEmpty(env["XDG_CONFIG_HOME"]) ??
        pathPosix.join(homeDir, ".config");
      return pathPosix.join(config, PRODUCT_NAME);
    }
    default:
      return null;
  }
}

/**
 * Where the desktop's installers put the app.
 *
 * - macOS: the DMG drags it into `/Applications`; some people keep apps
 *   in `~/Applications` instead.
 * - Windows: NSIS, per user (`perMachine: false`, `oneClick: false`), so
 *   electron-builder installs into `%LOCALAPPDATA%\Programs\Atomic Agent`.
 *   The installer lets the operator pick another folder; that install is
 *   still found through `state-dirs.json` once the app has been opened.
 * - Linux: the .deb installs into `/opt/Atomic Agent`. An AppImage has no
 *   fixed place on disk, so it is found only through `state-dirs.json`.
 */
function installCandidates(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  switch (platform) {
    case "darwin":
      return [
        `/Applications/${PRODUCT_NAME}.app`,
        pathPosix.join(homeDir, "Applications", `${PRODUCT_NAME}.app`),
      ];
    case "win32": {
      const localAppData = nonEmpty(env["LOCALAPPDATA"]) ??
        pathWin32.join(homeDir, "AppData", "Local");
      return [pathWin32.join(localAppData, "Programs", PRODUCT_NAME)];
    }
    case "linux":
      return [`/opt/${PRODUCT_NAME}`];
    default:
      return [];
  }
}

/**
 * The record's `dirs`, as the desktop writes it:
 * `{"dirs":["/Users/op/.atomic-agent"]}`. Anything else (missing file,
 * bad JSON, wrong shape) reads as an empty record, the same way the
 * desktop's own `readStateDirsRecord` treats it.
 */
function readRecordedDirs(
  file: string,
  readFile: (path: string) => string,
): readonly string[] {
  try {
    const raw = JSON.parse(readFile(file)) as { dirs?: unknown } | null;
    const dirs = raw?.dirs;
    if (!Array.isArray(dirs)) return [];
    return dirs.filter((d): d is string => typeof d === "string" && d.length > 0);
  } catch {
    return [];
  }
}

/**
 * A path in a form two spellings of the same folder agree on: resolved,
 * no trailing separator, and lower-case on Windows, whose file system
 * ignores case. Symlinks are not followed.
 */
function comparable(platform: NodeJS.Platform, raw: string): string {
  const path = platform === "win32" ? pathWin32 : pathPosix;
  const resolved = path.resolve(raw);
  const root = path.parse(resolved).root;
  const trimmed = resolved.length > root.length
    ? resolved.replace(/[\\/]+$/, "")
    : resolved;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
