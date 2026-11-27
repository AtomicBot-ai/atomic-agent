import { hostname as osHostname } from "node:os";

import { originAllowed } from "./loopback-guard.js";

/**
 * The `Origin` check of `/mcp` (route-mcp-endpoint.ts), the only place
 * that reads `ATOMIC_AGENT_ALLOWED_ORIGINS` (ATO-2475).
 *
 * The MCP Streamable HTTP spec says a server must validate `Origin` to
 * stop DNS rebinding, and the official SDK transport takes an
 * `allowedOrigins` list for the browser clients a user trusts. This is
 * that list, as an environment variable. It only ever adds a check: the
 * request still needs the serve API key, and the keyless loopback guard
 * (loopback-guard.ts) and every other route ignore the variable.
 *
 * Entries are comma-separated, compared without case or a trailing `/`:
 * - an exact origin (`https://app.example`, `http://192.168.1.5:3000`);
 * - a trailing `*` for an extension scheme only (`chrome-extension://*`,
 *   `moz-extension://abc*`). A wildcard on `http`/`https`, and a lone
 *   `*`, are ignored: `https://app.example*` would also match
 *   `https://app.example.evil.test`, and `*` would turn the spec's check off.
 */
export const ALLOWED_ORIGINS_ENV = "ATOMIC_AGENT_ALLOWED_ORIGINS";

function normalize(origin: string): string {
  return origin.trim().replace(/\/$/, "").toLowerCase();
}

/** A `scheme://` wildcard prefix this list honours, or `null` for one it ignores. */
function wildcardPrefix(entry: string): string | null {
  const prefix = entry.slice(0, -1);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(prefix)?.[1];
  if (scheme === undefined || scheme === "http" || scheme === "https") return null;
  return prefix;
}

/** Whether `ATOMIC_AGENT_ALLOWED_ORIGINS` in `env` lists `origin`. */
export function listedOrigin(origin: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env[ALLOWED_ORIGINS_ENV];
  if (!raw) return false;
  const want = normalize(origin);
  for (const item of raw.split(",")) {
    const entry = normalize(item);
    if (entry.length === 0) continue;
    if (entry.endsWith("*")) {
      const prefix = wildcardPrefix(entry);
      if (prefix !== null && want.startsWith(prefix)) return true;
      continue;
    }
    if (want === entry) return true;
  }
  return false;
}

/** No `Origin`, a loopback one, or one `ATOMIC_AGENT_ALLOWED_ORIGINS` lists. */
export function mcpOriginAllowed(
  origin: string | null,
  env: NodeJS.ProcessEnv = process.env,
  machineHostname: string = osHostname(),
): boolean {
  if (originAllowed(origin, machineHostname)) return true;
  return origin !== null && listedOrigin(origin, env);
}
