import { PANEL_HTML, PANEL_JS } from "./panel-page.js";
import type { HttpHandler } from "./request-context.js";

/**
 * ATO-1128: `GET /panel` — the phone panel: chats, a chat's turns as they
 * land, a message box, and the agent's approval requests with Allow once /
 * Deny. Served without auth because the page itself holds no data; it asks
 * for the API key and every call it makes carries it (the routes it uses
 * are the authenticated ones: /api/sessions, /v1/chat/completions,
 * /api/events, /api/approval/resolve). Reach it from a phone with
 * `atag serve --host 0.0.0.0` and a key (ATO-1126).
 */
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function createPanelPageHandler(): HttpHandler {
  return (_req, res) => {
    res.writeHead(200, { ...HEADERS, "content-type": "text/html; charset=utf-8" });
    res.end(PANEL_HTML);
  };
}

export function createPanelScriptHandler(): HttpHandler {
  return (_req, res) => {
    res.writeHead(200, { ...HEADERS, "content-type": "text/javascript; charset=utf-8" });
    res.end(PANEL_JS);
  };
}
