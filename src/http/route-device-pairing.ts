import type { IncomingMessage, ServerResponse } from "node:http";

import { deviceCookieHeader } from "./device-auth.js";
import type { DeviceSessions } from "./device-sessions.js";
import { getHeader, type HttpHandler } from "./request-context.js";

/**
 * ATO-2308: `GET` and `POST /pair/{token}`, where the QR code of
 * `atag pair` leads. Open (no key): the one-time token in the path is
 * the credential, the way OpenCode's pairing links and WhatsApp Web's QR
 * work.
 *
 * - `GET` shows one "Connect this phone" button and spends nothing, so
 *   a link preview or a prefetch cannot use the link up.
 * - `POST` (that button) redeems the token: a new device, its session
 *   cookie, and a redirect to the panel, which then needs no key. A used,
 *   expired or unknown token gets a page that says so.
 */

/** 32 random bytes in base64url, exactly what `createPairing` makes. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  // The token is in this page's address: never hand it on as a Referer.
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:32px 20px;font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:440px}
button{font:inherit;width:100%;padding:14px;border:0;border-radius:12px;background:#2f6bff;color:#fff}p{color:#5b616b}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}

function sendPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { ...HEADERS, "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

const CONFIRM_PAGE = page(
  "Connect this phone",
  "<p>This phone will open your Atomic Agent panel without typing the API key. It can chat and answer the agent's questions and approvals one at a time. It cannot change settings, save an Always allow rule, or move a chat to another folder. You can sign it out any time with <code>atag pair --revoke</code>.</p>"
    + '<form method="post"><button type="submit">Connect this phone</button></form>',
);

const USED_PAGE = page(
  "This link does not work",
  "<p>A pairing link works once, for 5 minutes. Run <code>atag pair</code> again on your computer and scan the new code.</p>",
);

const OFF_PAGE = page("Pairing is off", "<p>This server does not pair phones.</p>");

/** A short name for the device list, from the browser that paired. */
export function deviceNameFromUserAgent(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/iPad/i.test(ua)) return "iPad";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/i.test(ua)) return "Mac browser";
  if (/Windows/i.test(ua)) return "Windows browser";
  if (/Linux/i.test(ua)) return "Linux browser";
  return "Browser";
}

function tokenOf(params: Record<string, string>): string | null {
  const token = params.token ?? "";
  return TOKEN_PATTERN.test(token) ? token : null;
}

export function createPairPageHandler(devices: DeviceSessions | null): HttpHandler {
  return (_req, res, ctx) => {
    if (!devices) return sendPage(res, 404, OFF_PAGE);
    if (!tokenOf(ctx.params)) return sendPage(res, 404, USED_PAGE);
    sendPage(res, 200, CONFIRM_PAGE);
  };
}

export function createPairRedeemHandler(devices: DeviceSessions | null): HttpHandler {
  return (req: IncomingMessage, res, ctx) => {
    // The form body (empty) is not read: the token in the path is all it takes.
    req.resume();
    if (!devices) return sendPage(res, 404, OFF_PAGE);
    const token = tokenOf(ctx.params);
    if (!token) return sendPage(res, 404, USED_PAGE);
    const result = devices.redeem(token, deviceNameFromUserAgent(getHeader(req, "user-agent")));
    if (!result.ok) {
      return sendPage(res, result.reason === "store" ? 500 : 410, result.reason === "store"
        ? page("Pairing failed", "<p>The agent could not save this phone. Try again.</p>")
        : USED_PAGE);
    }
    res.writeHead(303, {
      ...HEADERS,
      "set-cookie": deviceCookieHeader(req, result.secret),
      location: "/panel",
    });
    res.end();
  };
}
