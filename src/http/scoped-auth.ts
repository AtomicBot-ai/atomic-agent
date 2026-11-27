import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthThrottle } from "./auth-throttle.js";
import { authorizeDeviceCookie } from "./device-auth.js";
import type { DeviceSessions } from "./device-sessions.js";
import { roleHasScope, type HttpRole, type HttpScope } from "./http-scopes.js";
import { hashHttpToken, type StoredHttpToken } from "./http-token-store.js";
import { openaiError } from "./openai-errors.js";
import {
  enforceAuth,
  getBearerToken,
  getHeader,
  sendAuthThrottled,
  sendInvalidApiKey,
  sendJson,
} from "./request-context.js";
import { secretEquals } from "./secret-equal.js";

/** Who sent a request: the serve key, or one named token. */
export interface HttpCaller {
  /** The token's name; `api-key` for the serve key. */
  name: string;
  role: HttpRole;
}

export interface ScopedAuthInput {
  apiKey: string | null;
  namedTokens: readonly StoredHttpToken[];
  /** What the matched route needs. */
  scope: HttpScope;
  /** `"POST /api/config"`, for the 403 message. */
  route: string;
  /** ATO-2308: phones paired by QR, signed in by a cookie (device-auth.ts). */
  devices?: DeviceSessions;
}

/**
 * Match a presented token against the serve key (admin) and every named
 * token. Each named token is compared in constant time on its hash, and
 * the loop never stops early, so timing does not say which one matched.
 */
export function identifyCaller(
  presented: string | null,
  apiKey: string,
  namedTokens: readonly StoredHttpToken[],
): HttpCaller | null {
  if (secretEquals(presented, apiKey)) return { name: "api-key", role: "admin" };
  if (typeof presented !== "string" || presented.length === 0) return null;
  const hash = hashHttpToken(presented);
  let found: StoredHttpToken | null = null;
  for (const token of namedTokens) {
    if (secretEquals(hash, token.sha256) && found === null) found = token;
  }
  return found ? { name: found.name, role: found.role } : null;
}

/**
 * ATO-583: auth plus scope for one request. Returns `true` when the
 * handler may run; otherwise the response is already sent.
 *
 * Without named tokens, or without a serve key, this is `enforceAuth`
 * unchanged: no key means an open loopback server, one key means that key
 * or 401. With both, the key is `admin`, a named token gets its role's
 * scopes, anything else is 401 (counted by the throttle), and a known
 * token whose role lacks the route's scope is 403 `insufficient_scope`.
 */
export function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: ScopedAuthInput,
  throttle?: AuthThrottle,
): boolean {
  const byDevice = authorizeDeviceCookie(req, res, input, throttle);
  if (byDevice !== "absent") return byDevice === "allowed";
  if (input.apiKey === null || input.namedTokens.length === 0) {
    return enforceAuth(req, res, input.apiKey, throttle);
  }
  const address = req.socket?.remoteAddress;
  const wait = throttle ? throttle.retryAfter(address) : 0;
  if (wait > 0) {
    sendAuthThrottled(res, wait);
    return false;
  }
  const presented = getBearerToken(req) ?? getHeader(req, "x-api-key");
  const caller = identifyCaller(presented, input.apiKey, input.namedTokens);
  if (!caller) {
    throttle?.failed(address);
    sendInvalidApiKey(res);
    return false;
  }
  throttle?.succeeded(address);
  if (roleHasScope(caller.role, input.scope)) return true;
  sendJson(
    res,
    403,
    openaiError(
      `Token "${caller.name}" has the ${caller.role} role and cannot use ${input.route}: it needs the ${input.scope} scope`,
      "permission_error",
      null,
      "insufficient_scope",
    ),
  );
  return false;
}
