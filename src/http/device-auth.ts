import type { IncomingMessage, ServerResponse } from "node:http";

import { throttleAddress, type AuthThrottle } from "./auth-throttle.js";
import type { DeviceSessions } from "./device-sessions.js";
import { DEVICE_IDLE_MS, type PairedDevice } from "./device-store.js";
import { roleHasScope, type HttpRole, type HttpScope } from "./http-scopes.js";
import { openaiError } from "./openai-errors.js";
import {
  getBearerToken,
  getHeader,
  sendAuthThrottled,
  sendInvalidApiKey,
  sendJson,
} from "./request-context.js";

/**
 * ATO-2308: the cookie a phone gets when it opens its pairing link. It
 * holds the device's session secret; serve keeps only its hash.
 *
 * HttpOnly (page script never sees it), SameSite=Strict (no other site
 * can make the browser send it), Path=/ (the panel and the API it calls),
 * Secure when the request came over HTTPS (the `--remote` tunnel).
 * ATO-2494: it lasts DEVICE_IDLE_MS (30 days) and every signed-in request
 * sends it again with a fresh Max-Age, so a phone in use stays signed in
 * and one left unused for 30 days is signed out (sliding expiry, like
 * GitHub and Google device sessions); Revoke ends it sooner.
 */
export const DEVICE_COOKIE = "atag_device";
const COOKIE_MAX_AGE_S = Math.floor(DEVICE_IDLE_MS / 1000);

/**
 * A paired phone is a member: it chats and answers approvals one at a
 * time. It never changes settings (admin routes), and the routes that
 * read `HandlerContext.pairedDevice` refuse it an Always allow rule and a
 * change of a chat's folder.
 */
export const DEVICE_ROLE: HttpRole = "member";

/** The value of cookie `name` in the request, or `null`. */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = getHeader(req, "cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** HTTPS directly, or through a proxy that says so (cloudflared sets X-Forwarded-Proto). */
export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted === true) return true;
  return getHeader(req, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

export function deviceCookieHeader(req: IncomingMessage, secret: string): string {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${DEVICE_COOKIE}=${secret}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict${secure}`;
}

/** Tells the browser to drop a cookie serve no longer accepts. */
export function clearDeviceCookieHeader(): string {
  return `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A cookie is sent by the browser on its own, so a request that changes
 * something must also prove it came from the panel's own page: its
 * `Origin` names the host it was sent to. SameSite=Strict already stops
 * other sites; this is the second lock (OWASP "verify origin").
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = getHeader(req, "origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const targets = [getHeader(req, "host"), getHeader(req, "x-forwarded-host")]
    .filter((h): h is string => typeof h === "string" && h.length > 0)
    .map((h) => h.trim().toLowerCase());
  return targets.includes(host);
}

export interface DeviceAuthInput {
  apiKey: string | null;
  devices?: DeviceSessions;
  scope: HttpScope;
  route: string;
}

/**
 * Auth by the device cookie. `"absent"` when it does not apply (no
 * store, a keyless server, or the request carries a key or token, which
 * then goes through the usual check unchanged). Otherwise the cookie
 * decides: the device it signed in (`{ device }`), or `"refused"` with
 * the response already sent.
 * A wrong cookie counts against the address like a wrong key.
 */
export function authorizeDeviceCookie(
  req: IncomingMessage,
  res: ServerResponse,
  input: DeviceAuthInput,
  throttle?: AuthThrottle,
): "absent" | "refused" | { device: Pick<PairedDevice, "id" | "name"> } {
  if (input.apiKey === null || !input.devices) return "absent";
  if (getBearerToken(req) !== null || getHeader(req, "x-api-key") !== null) return "absent";
  const secret = readCookie(req, DEVICE_COOKIE);
  if (secret === null) return "absent";
  const address = throttleAddress(req);
  const wait = throttle ? throttle.retryAfter(address) : 0;
  if (wait > 0) {
    sendAuthThrottled(res, wait);
    return "refused";
  }
  const device = input.devices.identify(secret);
  if (!device) {
    throttle?.failed(address);
    res.setHeader("set-cookie", clearDeviceCookieHeader());
    sendInvalidApiKey(res);
    return "refused";
  }
  throttle?.succeeded(address);
  // ATO-2494: sliding expiry, the cookie's 30 days start again from this use.
  res.setHeader("set-cookie", deviceCookieHeader(req, secret));
  if (!SAFE_METHODS.has((req.method ?? "GET").toUpperCase()) && !sameOrigin(req)) {
    sendJson(res, 403, openaiError(
      "A paired device may change things only from the panel page itself",
      "permission_error",
      null,
      "origin_not_allowed",
    ));
    return "refused";
  }
  if (roleHasScope(DEVICE_ROLE, input.scope)) return { device: { id: device.id, name: device.name } };
  sendJson(res, 403, openaiError(
    `Paired device "${device.name}" (${device.id}) cannot use ${input.route}: it needs the ${input.scope} scope`,
    "permission_error",
    null,
    "insufficient_scope",
  ));
  return "refused";
}
