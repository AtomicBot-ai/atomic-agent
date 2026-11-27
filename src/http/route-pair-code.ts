import type { IncomingMessage } from "node:http";

import { CODE_LENGTH } from "./device-code.js";
import { deviceCookieHeader } from "./device-auth.js";
import type { DeviceSessions } from "./device-sessions.js";
import { deviceNameFromUserAgent, page, PAIR_PAGE_HEADERS, sendPage } from "./route-device-pairing.js";
import { getHeader, readRawBody, type HttpHandler } from "./request-context.js";

/**
 * ATO-2494: `GET` and `POST /panel/pair`, pairing by typing a short code
 * instead of scanning. For the iPhone home-screen app first: it keeps
 * its own cookies apart from Safari, so a phone paired in Safari opens
 * it signed out, and the panel sends it here ("Connect this app").
 * The code is shown next to the QR (`atag pair`, the desktop's Connect
 * phone card) and redeems the same one-time pairing.
 *
 * Open (no key), like `/pair/{token}`: the code is the credential. A form
 * post, no script, so the page's CSP stays `default-src 'none'`.
 * Precedent: the OAuth device flow's user code (RFC 8628), the code a TV
 * shows for YouTube or Netflix.
 */

function codeForm(note: string): string {
  const err = note ? `<p class="err">${note}</p>` : "";
  return page(
    "Connect this app",
    "<p>On your computer, open Connect phone in Atomic Agent Settings (or run <code>atag pair</code>) and type the code shown under the QR.</p>"
      + "<p>An app added to the iPhone home screen keeps its own sign-in, apart from Safari, so it needs its own code.</p>"
      + err
      + '<form method="post" action="/panel/pair">'
      + `<input name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="${CODE_LENGTH + 4}" placeholder="BCDF-GHJK" aria-label="Pairing code" required>`
      + '<button type="submit">Connect</button></form>',
  );
}

const OFF_PAGE = page("Pairing is off", "<p>This server does not pair phones.</p>");

/** The `code` field of a urlencoded form body, or "" (a bad body is just a wrong code). */
async function typedCode(req: IncomingMessage): Promise<string> {
  try {
    const raw = await readRawBody(req);
    return new URLSearchParams(raw.toString("utf8")).get("code") ?? "";
  } catch {
    return "";
  }
}

export function createPairCodePageHandler(devices: DeviceSessions | null): HttpHandler {
  return (_req, res) => {
    if (!devices) return sendPage(res, 404, OFF_PAGE);
    sendPage(res, 200, codeForm(""));
  };
}

export function createPairCodeRedeemHandler(devices: DeviceSessions | null): HttpHandler {
  return async (req, res) => {
    if (!devices) {
      req.resume();
      return sendPage(res, 404, OFF_PAGE);
    }
    const code = await typedCode(req);
    const result = devices.redeemCode(code, deviceNameFromUserAgent(getHeader(req, "user-agent")));
    if (!result.ok) {
      if (result.reason === "store") {
        return sendPage(res, 500, page("Pairing failed", "<p>The agent could not save this phone. Try again.</p>"));
      }
      const note = result.reason === "locked"
        ? "Too many wrong codes. Make a new code on your computer and type that one."
        : result.reason === "expired"
          ? "This code has expired. A code works once, for 5 minutes. Make a new one on your computer."
          : "This code does not work. Check it, or make a new one on your computer.";
      return sendPage(res, result.reason === "locked" ? 429 : 400, codeForm(note));
    }
    res.writeHead(303, {
      ...PAIR_PAGE_HEADERS,
      "set-cookie": deviceCookieHeader(req, result.secret),
      location: "/panel",
    });
    res.end();
  };
}
