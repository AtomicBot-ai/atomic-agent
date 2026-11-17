import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";

import { openaiError } from "./openai-errors.js";
import { getHeader, sendError } from "./request-context.js";

/**
 * ATO-1495: `serve` without an API key listens on loopback at a fixed
 * port, and loopback alone does not keep a web page out. Any site open
 * in the user's browser can send blind cross-site requests to
 * `http://127.0.0.1:8787` (a form or `fetch(..., { mode: "no-cors" })`
 * with a text/plain body needs no preflight), or point its own domain
 * at 127.0.0.1 (DNS rebinding) and then read the answers too.
 *
 * With no key, every request must therefore:
 * - name a loopback host in `Host` (rebinding sends the attacker's name);
 * - carry no `Origin`, or a loopback one, or one listed in
 *   `ATOMIC_AGENT_ALLOWED_ORIGINS` (browsers add `Origin` to every
 *   cross-site POST and every CORS request; curl and CLI clients send none);
 * - send its body as JSON (`application/json` is not a CORS "simple"
 *   type, so a browser cannot send it cross-site without a preflight,
 *   and the preflight gets no permissive CORS headers back).
 *
 * With a key the bearer check already stops all of that, and the guard
 * is off: the desktop always starts `serve` with a per-launch key.
 */

export const ALLOWED_ORIGINS_ENV = "ATOMIC_AGENT_ALLOWED_ORIGINS";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface LoopbackGuardRejection {
  status: 403 | 415;
  code: "host_not_allowed" | "origin_not_allowed" | "unsupported_media_type";
  message: string;
}

export interface LoopbackGuardOptions {
  /** `process.env` by default; tests pass their own. */
  env?: NodeJS.ProcessEnv;
  /** `os.hostname()` by default. */
  machineHostname?: string;
}

/** A URL `hostname` (lowercase, IPv6 in brackets) that names this machine. */
export function isLoopbackHostname(name: string, machineHostname: string = osHostname()): boolean {
  const h = name.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return h.split(".")[0] === "127";
  if (h === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h)) return true;
  const own = machineHostname.toLowerCase().replace(/\.$/, "");
  if (own.length === 0) return false;
  const short = own.split(".")[0] ?? own;
  return h === own || h === short || h === `${short}.local`;
}

/** `Host: localhost:8787`, `[::1]:8787`, `127.0.0.1`. Absent Host (HTTP/1.0) passes. */
function hostAllowed(host: string | null, machineHostname: string): boolean {
  if (host === null) return true;
  let url: URL;
  try {
    url = new URL(`http://${host.trim()}/`);
  } catch {
    return false;
  }
  if (url.username || url.password || url.pathname !== "/") return false;
  return isLoopbackHostname(url.hostname, machineHostname);
}

function allowListed(origin: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env[ALLOWED_ORIGINS_ENV];
  if (!raw) return false;
  const normalized = origin.trim().replace(/\/$/, "").toLowerCase();
  for (const entry of raw.split(",")) {
    const want = entry.trim().replace(/\/$/, "").toLowerCase();
    if (want.length === 0) continue;
    if (want === "*") return true;
    if (want.endsWith("*") ? normalized.startsWith(want.slice(0, -1)) : normalized === want) return true;
  }
  return false;
}

function originAllowed(origin: string | null, env: NodeJS.ProcessEnv, machineHostname: string): boolean {
  if (origin === null) return true;
  if (allowListed(origin, env)) return true;
  let url: URL;
  try {
    url = new URL(origin.trim());
  } catch {
    return false; // includes the opaque `null` origin of sandboxed frames and file:// pages
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isLoopbackHostname(url.hostname, machineHostname);
}

function hasBody(req: IncomingMessage): boolean {
  const length = getHeader(req, "content-length");
  if (length !== null && length.trim() !== "0") return true;
  return getHeader(req, "transfer-encoding") !== null;
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const type = (value.split(";")[0] ?? "").trim().toLowerCase();
  return type === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(type);
}

/** Why the request is refused, or `null` when it may go on to routing. */
export function checkLoopbackRequest(
  req: IncomingMessage,
  options: LoopbackGuardOptions = {},
): LoopbackGuardRejection | null {
  const env = options.env ?? process.env;
  const machineHostname = options.machineHostname ?? osHostname();
  if (!hostAllowed(getHeader(req, "host"), machineHostname)) {
    return {
      status: 403,
      code: "host_not_allowed",
      message: "Host is not a loopback name; without an API key this server answers only localhost",
    };
  }
  if (!originAllowed(getHeader(req, "origin"), env, machineHostname)) {
    return {
      status: 403,
      code: "origin_not_allowed",
      message: `Cross-origin requests are refused without an API key; allow an origin with ${ALLOWED_ORIGINS_ENV}`,
    };
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (BODY_METHODS.has(method) && hasBody(req) && !isJsonContentType(getHeader(req, "content-type"))) {
    return {
      status: 415,
      code: "unsupported_media_type",
      message: "Request bodies must be sent as Content-Type: application/json",
    };
  }
  return null;
}

/**
 * Run the guard when `apiKey` is null. Returns `true` when the request
 * may proceed; otherwise the response is already sent (no CORS headers).
 */
export function enforceLoopbackGuard(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string | null,
  options: LoopbackGuardOptions = {},
): boolean {
  if (apiKey !== null) return true;
  const rejection = checkLoopbackRequest(req, options);
  if (!rejection) return true;
  sendError(res, rejection.status, openaiError(rejection.message, "invalid_request_error", null, rejection.code));
  return false;
}
