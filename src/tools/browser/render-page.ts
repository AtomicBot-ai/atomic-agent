import type { BrowserBackend } from "./browser-backend.js";
import {
  blockedHostOfPage,
  checkBrowserUrl,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";

/** What the `os.web.fetch` ladder gets back from the browser step. */
export interface RenderedPage {
  finalUrl: string;
  title: string;
  html: string;
}

/**
 * Renders a page in the agent's own browser for `os.web.fetch` (ATO-968).
 * Resolves `null` when this browser may not be used for it (no backend
 * support, a host outside the domain lists); throws when the render
 * itself failed.
 */
export type BrowserPageRenderer = (input: {
  url: string;
  timeoutMs: number;
  isStillWalled?: (html: string) => boolean;
}) => Promise<RenderedPage | null>;

/**
 * The browser step of the page-read ladder. It goes through the same
 * domain lists as `browser.navigate`: a blocked host is never opened and
 * a page that lands on (or frames) one is discarded, and with an
 * allow-list a host outside it is skipped rather than asked about, since
 * a background read has nobody to ask.
 */
export function buildBrowserPageRenderer(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy,
): BrowserPageRenderer {
  return async ({ url, timeoutMs, isStillWalled }) => {
    if (typeof backend.renderHtml !== "function") return null;
    if (policy.userProfile) return null;
    if (checkBrowserUrl(url, policy).kind !== "ok") return null;
    const page = await backend.renderHtml({
      url,
      timeoutMs,
      ...(isStillWalled ? { isStillWalled } : {}),
    });
    if (checkBrowserUrl(page.url, policy).kind !== "ok") return null;
    if (blockedHostOfPage(page.url, page.frameUrls, policy) !== null) {
      return null;
    }
    return { finalUrl: page.url, title: page.title, html: page.html };
  };
}
