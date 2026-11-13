/**
 * ATO-1136: an HTML artifact shown in the chat, in a sandboxed frame.
 *
 * The agent (or a reply's .html file, or a ```html block the person asks to
 * preview) hands the window a page that may carry script: a chart, a small
 * dashboard, a mini app. The window must run it without giving it anything:
 *
 *   - It is served from its own scheme (`atomic-art://<token>/`), never as
 *     `srcdoc` or a `blob:` URL. Those two are local documents and inherit the
 *     window's own CSP (`script-src 'self'`), which would block the page's
 *     inline script; a document served with its own response header gets only
 *     the CSP below.
 *   - That CSP allows inline script and style and nothing that leaves the
 *     page: no fetch, no XHR, no WebSocket, no images or fonts from anywhere
 *     but `data:`/`blob:`, no frames, no workers, no forms. It also carries
 *     `sandbox allow-scripts`, so even loaded on its own the page has an
 *     opaque origin, no popups, no top navigation and no forms.
 *   - The window's <iframe> is `sandbox="allow-scripts"` (no
 *     allow-same-origin): no Node, no preload, no access to the window's DOM,
 *     storage or bridge. The page can only post a message to its parent; the
 *     window reads one kind (its height) and ignores the rest.
 *   - main.ts denies the frame any permission (camera, microphone, clipboard…)
 *     and any navigation away from these schemes (subframeNavAllowed).
 *
 * The page's text lives in main, in a small store keyed by a random token;
 * the window only ever gets the URL. Pure: no Electron import, so the unit
 * suite loads it from `out/main`.
 */

import { randomBytes } from "node:crypto";

export const ARTIFACT_SCHEME = "atomic-art";

/** The one CSP an artifact page runs under (its response header). */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ");

/** Nothing a page could ask the browser for. */
export const ARTIFACT_PERMISSIONS_POLICY = [
  "camera=()", "microphone=()", "geolocation=()", "display-capture=()", "clipboard-read=()", "clipboard-write=()",
  "usb=()", "serial=()", "hid=()", "bluetooth=()", "payment=()", "fullscreen=()", "screen-wake-lock=()",
].join(", ");

/** One page at most this large (UTF-8 bytes); a reply's .html file is read up to 512 KB. */
export const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
/** Pages kept; the oldest goes first. Its frame, if still on screen, keeps what it loaded. */
export const ARTIFACT_MAX_PAGES = 64;

/**
 * Appended to every page: tells the window how tall it is, so the frame fits
 * it (the window clamps the number). `postMessage` is all a sandboxed page can
 * reach of its parent; the message carries no data of the page's.
 */
export const ARTIFACT_SIZE_SCRIPT =
  "<script>(function(){var last=0;function s(){try{var d=document.documentElement,b=document.body;"
  + "var h=Math.ceil(Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0));if(h&&h!==last){last=h;"
  + "parent.postMessage({atomicArtifact:'size',h:h},'*');}}catch(e){}}"
  + "addEventListener('load',s);if(window.ResizeObserver)new ResizeObserver(s).observe(document.documentElement);"
  + "setTimeout(s,0);setTimeout(s,300);})();</script>";

/** The document served for a page: standards mode, both colour schemes, the page, the size reporter. */
export function artifactDocument(html: string): string {
  return "<!doctype html><meta charset=\"utf-8\"><meta name=\"color-scheme\" content=\"light dark\">"
    + html + ARTIFACT_SIZE_SCRIPT;
}

export type ArtifactPut = { ok: true; url: string } | { ok: false; reason: "empty" | "too-large" };

export type ArtifactResponse = { status: number; headers: Record<string, string>; body: string };

export function artifactHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": ARTIFACT_CSP,
    "Permissions-Policy": ARTIFACT_PERMISSIONS_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

/** The token of an `atomic-art://<token>/` URL, or null. */
export function artifactToken(url: string): string | null {
  const m = /^atomic-art:\/\/([0-9a-f]{32})\/?(?:[?#].*)?$/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

export class ArtifactStore {
  private pages = new Map<string, string>();

  constructor(private readonly maxPages = ARTIFACT_MAX_PAGES, private readonly maxBytes = ARTIFACT_MAX_BYTES) {}

  /** Keep a page; its URL is new every time, so a frame given it loads this text and no other. */
  put(html: unknown): ArtifactPut {
    if (typeof html !== "string" || !html.trim()) return { ok: false, reason: "empty" };
    if (Buffer.byteLength(html, "utf8") > this.maxBytes) return { ok: false, reason: "too-large" };
    const token = randomBytes(16).toString("hex");
    this.pages.set(token, html);
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next().value;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
    }
    return { ok: true, url: `${ARTIFACT_SCHEME}://${token}/` };
  }

  /** Forget a page (the window replaced it). */
  drop(url: unknown): void {
    const t = artifactToken(String(url || ""));
    if (t) this.pages.delete(t);
  }

  get size(): number { return this.pages.size; }

  /** What the scheme's handler answers for a request URL. */
  response(url: string): ArtifactResponse {
    const t = artifactToken(url);
    const html = t ? this.pages.get(t) : undefined;
    if (html === undefined) {
      return { status: 404, headers: { ...artifactHeaders(), "Content-Type": "text/plain; charset=utf-8" }, body: "Not found" };
    }
    return { status: 200, headers: artifactHeaders(), body: artifactDocument(html) };
  }
}

/**
 * A frame inside the window may go only to these: an artifact page, the
 * file preview's own frames (`about:srcdoc`, a PDF's `blob:`) and the PDF
 * viewer Chromium puts inside that blob frame. A link in an artifact page
 * (http, https, file, anything else) does not navigate.
 */
export function subframeNavAllowed(url: string): boolean {
  const u = String(url || "");
  return /^(?:about:|blob:|atomic-art:\/\/|chrome-extension:\/\/|chrome:\/\/)/i.test(u);
}

/** A permission asked from an artifact page (or any frame but the window's own): always refused. */
export function permissionFromSubframe(details: { isMainFrame?: boolean; requestingUrl?: string } | undefined): boolean {
  if (!details) return false;
  if (details.isMainFrame === false) return true;
  return typeof details.requestingUrl === "string" && details.requestingUrl.toLowerCase().startsWith(`${ARTIFACT_SCHEME}:`);
}
