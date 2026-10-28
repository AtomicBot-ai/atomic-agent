import { ConfigValidationError } from "./config-validation-error.js";
import { parseNullableString, parseStringArrayOrNull } from "./config-values.js";

/**
 * Which browser the `browser.*` tools drive.
 *
 * - `"agent"` (default): the agent starts its own Chrome with its own
 *   profile (`<stateDir>/browser-profile`), as before.
 * - `"user-chrome"`: attach to the Chrome the user already has open, with
 *   their signed-in sessions. Chrome 144+ allows this once the user turns
 *   on remote debugging at `chrome://inspect/#remote-debugging` and
 *   accepts Chrome's own dialog; Chrome then writes `DevToolsActivePort`
 *   into its user data dir, which is how the agent finds it.
 */
export type BrowserConnectMode = "agent" | "user-chrome";

export const BROWSER_CONNECT_MODES: readonly BrowserConnectMode[] = [
  "agent",
  "user-chrome",
];

/**
 * `browser` block of config.json (unversioned, additive). The other
 * launch settings (`channel`, `headless`, `executablePath`, …) stay
 * environment-only.
 *
 * - `blockedDomains` (default `[]`): hosts the browser may never open or
 *   act on, at any approval level. An entry matches the host and every
 *   subdomain; a scheme, path, port or leading `*.` is ignored.
 * - `allowedDomains` (default `[]`): when non-empty, opening a host
 *   outside it asks first (approval category `browser_offsite`).
 * - `connect` (default `"agent"`): see {@link BrowserConnectMode}.
 * - `cdpUrl` (default `null`): attach to this DevTools endpoint instead of
 *   launching. Loopback only (`127.0.0.1`, `localhost`, `[::1]`): a CDP
 *   endpoint is full control of a browser, signed-in sessions included,
 *   so the file never points the agent at another machine. Env
 *   `ATOMIC_AGENT_BROWSER_CDP_URL` still wins.
 * - `userDataDir` (default `null`): the user's Chrome data directory for
 *   `"user-chrome"`, when it is not one of the standard locations.
 */
export interface UserBrowserConfig {
  blockedDomains: string[];
  allowedDomains: string[];
  connect: BrowserConnectMode;
  cdpUrl: string | null;
  userDataDir: string | null;
}

export function createBrowserDefaults(): UserBrowserConfig {
  return {
    blockedDomains: [],
    allowedDomains: [],
    connect: "agent",
    cdpUrl: null,
    userDataDir: null,
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CDP_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * `null` when `raw` is an http(s)/ws(s) URL on a loopback host, else the
 * reason it is refused. Pure; shared by the config parser and its tests.
 */
export function cdpUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (!CDP_PROTOCOLS.has(url.protocol)) {
    return `scheme ${url.protocol} is not http, https, ws or wss`;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return `host ${url.hostname} is not this machine (only 127.0.0.1, localhost or [::1]); a DevTools endpoint gives full control of the browser`;
  }
  return null;
}

function parseCdpUrl(raw: unknown, field: string): string | null {
  const value = parseNullableString(raw, field);
  if (value === null) return null;
  const problem = cdpUrlProblem(value);
  if (problem) throw new ConfigValidationError(field, problem);
  return value;
}

function parseConnectMode(raw: unknown, field: string): BrowserConnectMode {
  if (raw === "agent" || raw === "user-chrome") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of ${BROWSER_CONNECT_MODES.join(" | ")}, got ${JSON.stringify(raw)}`,
  );
}

export function parseBrowserConfig(
  raw: Record<string, unknown>,
  readDefaults: () => UserBrowserConfig,
): UserBrowserConfig {
  const defaults = readDefaults();
  return {
    blockedDomains:
      parseStringArrayOrNull(
        raw.blockedDomains ?? defaults.blockedDomains,
        "browser.blockedDomains",
      ) ?? [],
    allowedDomains:
      parseStringArrayOrNull(
        raw.allowedDomains ?? defaults.allowedDomains,
        "browser.allowedDomains",
      ) ?? [],
    connect: parseConnectMode(raw.connect ?? defaults.connect, "browser.connect"),
    cdpUrl: parseCdpUrl(
      raw.cdpUrl === undefined ? defaults.cdpUrl : raw.cdpUrl,
      "browser.cdpUrl",
    ),
    userDataDir: parseNullableString(
      raw.userDataDir === undefined ? defaults.userDataDir : raw.userDataDir,
      "browser.userDataDir",
    ),
  };
}
