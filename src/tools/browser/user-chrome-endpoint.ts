import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Finding the DevTools endpoint of the user's own Chrome
 * (`browser.connect: "user-chrome"`, ATO-511).
 *
 * Chrome 144+ lets the user turn on remote debugging for their normal
 * profile at `chrome://inspect/#remote-debugging`, behind Chrome's own
 * consent dialog. While it is on, Chrome writes `DevToolsActivePort` into
 * its user data dir: line 1 is the port, line 2 the browser target path
 * (`/devtools/browser/<id>`). That pair is the only discovery there is;
 * the HTTP `/json/version` endpoint is not served in this mode.
 *
 * Everything here except {@link resolveUserChromeEndpoint}'s default file
 * reader is pure, so the per-OS paths and the parser are unit-tested.
 */

/** Plain-words steps shown whenever the user's Chrome cannot be reached. */
export const USER_CHROME_STEPS =
  "Open chrome://inspect/#remote-debugging in Chrome, turn on remote debugging, allow the dialog, then retry.";

export type DevToolsActivePort =
  | { ok: true; port: number; path: string }
  | { ok: false; reason: string };

/** Parse the two-line `DevToolsActivePort` file. */
export function parseDevToolsActivePort(text: string): DevToolsActivePort {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const portLine = lines[0] ?? "";
  if (!/^\d{1,5}$/.test(portLine)) {
    return { ok: false, reason: "the first line is not a port number" };
  }
  const port = Number(portLine);
  if (port < 1 || port > 65_535) {
    return { ok: false, reason: `port ${port} is out of range` };
  }
  const path = lines[1] ?? "";
  if (path.length === 0) {
    return { ok: false, reason: "the second line (browser path) is missing" };
  }
  if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(path)) {
    return { ok: false, reason: "the second line is not a /devtools/browser/<id> path" };
  }
  return { ok: true, port, path };
}

/** Always loopback: Chrome only listens on this machine in this mode. */
export function devToolsWsUrl(port: number, path: string): string {
  return `ws://127.0.0.1:${port}${path}`;
}

export interface UserChromeDirCandidate {
  /** Human name for messages ("Google Chrome", "Brave"…). */
  browser: string;
  userDataDir: string;
}

export interface UserChromeDirEnv {
  platform: NodeJS.Platform;
  homeDir: string;
  /** `%LOCALAPPDATA%` on Windows. */
  localAppData?: string | undefined;
  /** `$XDG_CONFIG_HOME` on Linux. */
  xdgConfigHome?: string | undefined;
}

/**
 * Default user data dirs, most likely first: stable Chrome, then Beta,
 * Canary / Dev, Chromium, Brave and Edge. All Chromium-family browsers
 * on 144+ write the same file once remote debugging is on.
 */
export function userChromeDataDirCandidates(env: UserChromeDirEnv): UserChromeDirCandidate[] {
  if (env.platform === "win32") {
    const base = env.localAppData ?? win32.join(env.homeDir, "AppData", "Local");
    const at = (browser: string, ...parts: string[]): UserChromeDirCandidate => ({
      browser,
      userDataDir: win32.join(base, ...parts, "User Data"),
    });
    return [
      at("Google Chrome", "Google", "Chrome"),
      at("Google Chrome Beta", "Google", "Chrome Beta"),
      at("Google Chrome Canary", "Google", "Chrome SxS"),
      at("Chromium", "Chromium"),
      at("Brave", "BraveSoftware", "Brave-Browser"),
      at("Microsoft Edge", "Microsoft", "Edge"),
    ];
  }
  const base =
    env.platform === "darwin"
      ? posix.join(env.homeDir, "Library", "Application Support")
      : (env.xdgConfigHome ?? posix.join(env.homeDir, ".config"));
  const at = (browser: string, ...parts: string[]): UserChromeDirCandidate => ({
    browser,
    userDataDir: posix.join(base, ...parts),
  });
  if (env.platform === "darwin") {
    return [
      at("Google Chrome", "Google", "Chrome"),
      at("Google Chrome Beta", "Google", "Chrome Beta"),
      at("Google Chrome Canary", "Google", "Chrome Canary"),
      at("Chromium", "Chromium"),
      at("Brave", "BraveSoftware", "Brave-Browser"),
      at("Microsoft Edge", "Microsoft Edge"),
    ];
  }
  return [
    at("Google Chrome", "google-chrome"),
    at("Google Chrome Beta", "google-chrome-beta"),
    at("Google Chrome Dev", "google-chrome-unstable"),
    at("Chromium", "chromium"),
    at("Brave", "BraveSoftware", "Brave-Browser"),
    at("Microsoft Edge", "microsoft-edge"),
  ];
}

export function devToolsActivePortPath(
  userDataDir: string,
  platform: NodeJS.Platform,
): string {
  return (platform === "win32" ? win32 : posix).join(userDataDir, "DevToolsActivePort");
}

export interface UserChromeEndpoint {
  wsUrl: string;
  browser: string;
  userDataDir: string;
}

export interface ResolveUserChromeEndpointInput {
  /** `browser.userDataDir`; when set, only this directory is tried. */
  userDataDir?: string | null;
  platform?: NodeJS.Platform;
  homeDir?: string;
  localAppData?: string | undefined;
  xdgConfigHome?: string | undefined;
  /** File reader; `null` when the file does not exist or cannot be read. */
  readTextFile?: (path: string) => string | null;
}

/** Thrown with the plain-words steps when the user's Chrome is not ready. */
export class UserChromeNotReadyError extends Error {
  constructor(detail: string) {
    super(`Could not reach your Chrome: ${detail}. ${USER_CHROME_STEPS}`);
    this.name = "UserChromeNotReadyError";
  }
}

function readTextFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The first candidate dir holding a valid `DevToolsActivePort`, as a
 * loopback `ws://` URL. Throws {@link UserChromeNotReadyError} when none
 * does, naming where it looked.
 */
export function resolveUserChromeEndpoint(
  input: ResolveUserChromeEndpointInput = {},
): UserChromeEndpoint {
  const platform = input.platform ?? process.platform;
  const read = input.readTextFile ?? readTextFileOrNull;
  const candidates: UserChromeDirCandidate[] = input.userDataDir
    ? [{ browser: "Chrome", userDataDir: input.userDataDir }]
    : userChromeDataDirCandidates({
        platform,
        homeDir: input.homeDir ?? homedir(),
        localAppData: input.localAppData ?? process.env.LOCALAPPDATA,
        xdgConfigHome: input.xdgConfigHome ?? process.env.XDG_CONFIG_HOME,
      });
  const broken: string[] = [];
  for (const candidate of candidates) {
    const file = devToolsActivePortPath(candidate.userDataDir, platform);
    const text = read(file);
    if (text === null) continue;
    const parsed = parseDevToolsActivePort(text);
    if (!parsed.ok) {
      broken.push(`${file}: ${parsed.reason}`);
      continue;
    }
    return {
      wsUrl: devToolsWsUrl(parsed.port, parsed.path),
      browser: candidate.browser,
      userDataDir: candidate.userDataDir,
    };
  }
  if (broken.length > 0) {
    throw new UserChromeNotReadyError(`the DevToolsActivePort file is unreadable (${broken.join("; ")})`);
  }
  const where = input.userDataDir
    ? input.userDataDir
    : candidates.map((c) => c.userDataDir).join(", ");
  throw new UserChromeNotReadyError(
    `remote debugging is not turned on (no DevToolsActivePort in ${where})`,
  );
}
