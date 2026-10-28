import { spawn } from "node:child_process";
import type { BrowserChannel } from "../../config/index.js";
import { findChromeExecutable } from "./find-chrome-executable.js";
import {
  resolveUserChromeEndpoint,
  UserChromeNotReadyError,
  type ResolveUserChromeEndpointInput,
  type UserChromeEndpoint,
} from "./user-chrome-endpoint.js";

/**
 * Where the agent attaches in `browser.connect: "user-chrome"` mode
 * (ATO-511), in order:
 *
 * 1. `cdpUrl` when set: a Chrome the user started themselves with
 *    `--remote-debugging-port` (loopback only, see browser-config.ts).
 * 2. The `DevToolsActivePort` file Chrome 144+ writes while remote
 *    debugging is on (`user-chrome-endpoint.ts`).
 * 3. Otherwise the user's Chrome is opened (no flags, their normal
 *    profile) on `chrome://inspect/#remote-debugging`, once per backend,
 *    and the file is polled for `waitMs`. Since Chrome 136 a debugging
 *    port on the default profile is ignored, so turning the switch on
 *    is the only way in; the agent never flips it for the user.
 */
export const REMOTE_DEBUGGING_PAGE = "chrome://inspect/#remote-debugging";

/**
 * Why a re-attach failed. Said so the model hands the step to the user
 * and stops, rather than retrying or reaching Chrome another way.
 */
export const USER_CHROME_RESTARTED =
  "Chrome was closed or restarted and remote debugging is not on in it now. Ask the user to turn it on; do not call the browser again until they say it is on, and do not control Chrome through os.shell.run";

export interface FindUserChromeCdpUrlInput {
  cdpUrl: string | null;
  userDataDir: string | null;
  /** How long to wait for the user to turn remote debugging on. */
  waitMs: number;
  /**
   * Attaching again after the browser went away (quit or restart,
   * ATO-1260): when remote debugging is not on, fail at once with the
   * steps instead of opening the settings page and waiting.
   */
  reconnect?: boolean;
  pollMs?: number;
  /** Open the user's Chrome on the remote-debugging page; `false` when none is installed. */
  openRemoteDebuggingPage: () => boolean;
  resolve?: (input: ResolveUserChromeEndpointInput) => UserChromeEndpoint;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface UserChromeCdpTarget {
  cdpUrl: string;
  /** "Google Chrome", "Brave"…, or "Chrome" for an explicit address. */
  browser: string;
  /** The remote-debugging page was opened to get here. */
  openedSettings: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function findUserChromeCdpUrl(
  input: FindUserChromeCdpUrlInput,
): Promise<UserChromeCdpTarget> {
  if (input.cdpUrl) {
    return { cdpUrl: input.cdpUrl, browser: "Chrome", openedSettings: false };
  }
  const resolve = input.resolve ?? resolveUserChromeEndpoint;
  const lookup = () => resolve({ userDataDir: input.userDataDir });
  try {
    const found = lookup();
    return { cdpUrl: found.wsUrl, browser: found.browser, openedSettings: false };
  } catch (error) {
    if (!(error instanceof UserChromeNotReadyError)) throw error;
    if (input.reconnect) throw new UserChromeNotReadyError(USER_CHROME_RESTARTED);
  }
  if (!input.openRemoteDebuggingPage()) {
    throw new UserChromeNotReadyError(
      "no Chrome, Chromium, Brave or Edge is installed on this computer",
    );
  }
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? 1_000;
  const deadline = now() + input.waitMs;
  while (now() < deadline) {
    await sleep(pollMs);
    try {
      const found = lookup();
      return { cdpUrl: found.wsUrl, browser: found.browser, openedSettings: true };
    } catch (error) {
      if (!(error instanceof UserChromeNotReadyError)) throw error;
    }
  }
  throw new UserChromeNotReadyError(
    `remote debugging was not turned on within ${Math.round(input.waitMs / 1000)} seconds (Chrome is open on that page now)`,
  );
}

/**
 * Open the user's own browser (no flags, so their normal profile and
 * windows) on {@link REMOTE_DEBUGGING_PAGE}. A running Chrome takes the
 * URL into a new tab; a closed one starts. Detached: the agent never
 * owns or stops the user's browser process.
 */
export function openRemoteDebuggingPage(options: {
  channel: BrowserChannel;
  executablePath: string | null;
}): boolean {
  const executable = findChromeExecutable({
    executablePath: options.executablePath,
    channel: options.channel,
  });
  if (!executable) return false;
  try {
    const child = spawn(executable.path, [REMOTE_DEBUGGING_PAGE], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
