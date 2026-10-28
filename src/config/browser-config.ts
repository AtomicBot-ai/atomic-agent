import { parseStringArrayOrNull } from "./config-values.js";

/**
 * `browser` block of config.json (unversioned, additive). Domain lists
 * for the browser tools; the launch settings (`channel`, `headless`,
 * `cdpUrl`, …) stay environment-only.
 *
 * - `blockedDomains` (default `[]`): hosts the browser may never open or
 *   act on, at any approval level. An entry matches the host and every
 *   subdomain; a scheme, path, port or leading `*.` is ignored.
 * - `allowedDomains` (default `[]`): when non-empty, opening a host
 *   outside it asks first (approval category `browser_offsite`).
 */
export interface UserBrowserConfig {
  blockedDomains: string[];
  allowedDomains: string[];
}

export function createBrowserDefaults(): UserBrowserConfig {
  return { blockedDomains: [], allowedDomains: [] };
}

export function parseBrowserConfig(
  raw: Record<string, unknown>,
  readDefaults: () => UserBrowserConfig,
): UserBrowserConfig {
  return {
    blockedDomains:
      parseStringArrayOrNull(
        raw.blockedDomains ?? readDefaults().blockedDomains,
        "browser.blockedDomains",
      ) ?? [],
    allowedDomains:
      parseStringArrayOrNull(
        raw.allowedDomains ?? readDefaults().allowedDomains,
        "browser.allowedDomains",
      ) ?? [],
  };
}
