import { PANEL_ICON_PNG_BASE64, PANEL_ICON_SVG, PANEL_MANIFEST } from "./panel-assets.js";
import { PANEL_HTML, PANEL_JS } from "./panel-page.js";
import type { HttpHandler } from "./request-context.js";

/**
 * ATO-1128: `GET /panel` — the phone panel: chats, a chat's turns as they
 * land, a message box, and the agent's approval requests with Allow once /
 * Deny. Served without auth because the page itself holds no data; it asks
 * for the API key and every call it makes carries it (the routes it uses
 * are the authenticated ones: /api/sessions, /v1/chat/completions,
 * /api/events, /api/approval/resolve). Reach it from a phone with
 * `atag serve --host 0.0.0.0` and a key (ATO-1126). On this machine,
 * serve prints `/panel#key=…` when it runs in a terminal; the page takes
 * the key from the fragment (never sent to the server) and drops it from
 * the address bar.
 */
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

/**
 * ATO-1130: the manifest and icon that let the panel be added to a
 * phone's home screen and open full screen. No auth, same as the page:
 * they hold no data. Cached for a day; they change only with a release.
 */
const ASSET_HEADERS = {
  "cache-control": "public, max-age=86400",
  "x-content-type-options": "nosniff",
};

const PANEL_ICON_PNG = Buffer.from(PANEL_ICON_PNG_BASE64, "base64");

export function createPanelManifestHandler(): HttpHandler {
  return (_req, res) => {
    res.writeHead(200, { ...ASSET_HEADERS, "content-type": "application/manifest+json; charset=utf-8" });
    res.end(PANEL_MANIFEST);
  };
}

export function createPanelIconSvgHandler(): HttpHandler {
  return (_req, res) => {
    res.writeHead(200, {
      ...ASSET_HEADERS,
      "content-type": "image/svg+xml",
      // An SVG opened on its own is a document: let it run nothing.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(PANEL_ICON_SVG);
  };
}

export function createPanelIconPngHandler(): HttpHandler {
  return (_req, res) => {
    res.writeHead(200, { ...ASSET_HEADERS, "content-type": "image/png", "content-length": PANEL_ICON_PNG.length });
    res.end(PANEL_ICON_PNG);
  };
}
