import type { BrowserContext, Frame, Page, Request } from "playwright-core";
import type { PageDebugLog } from "./page-debug-log.js";

/**
 * Feed `log` from one browser context's `console`, `weberror`,
 * `response` and `requestfailed` events (ATO-701). Only events of pages
 * `visible` admits are kept: in the user's own Chrome that is the
 * agent's own tabs, never the user's. A listener never throws into
 * Playwright; an event whose page cannot be told is dropped.
 */
export function watchPageDebugEvents(
  context: BrowserContext,
  log: PageDebugLog,
  visible: (page: Page) => boolean,
): void {
  const admitted = (page: Page | null | undefined): page is Page =>
    page !== null && page !== undefined && visible(page);

  context.on("console", (message) => {
    guard(() => {
      const page = message.page();
      if (!admitted(page)) return;
      const location = message.location();
      log.addConsole({
        level: message.type(),
        text: message.text(),
        ...(location.url ? { source: `${location.url}:${location.lineNumber + 1}` } : {}),
        pageUrl: page.url(),
      });
    });
  });

  context.on("weberror", (webError) => {
    guard(() => {
      const page = webError.page();
      if (!admitted(page)) return;
      const error = webError.error();
      const firstFrame = error.stack?.split("\n").find((line) => /^\s+at /.test(line))?.trim();
      log.addConsole({
        level: "pageerror",
        text: firstFrame ? `${error.name}: ${error.message} (${firstFrame})` : `${error.name}: ${error.message}`,
        pageUrl: page.url(),
      });
    });
  });

  context.on("response", (response) => {
    guard(() => {
      const request = response.request();
      const page = pageOf(request);
      if (!admitted(page)) return;
      log.addResponse({
        method: request.method(),
        url: response.url(),
        resourceType: request.resourceType(),
        status: response.status(),
        pageUrl: page.url(),
      });
    });
  });

  context.on("requestfailed", (request) => {
    guard(() => {
      const page = pageOf(request);
      if (!admitted(page)) return;
      log.addFailure({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText ?? "failed",
        pageUrl: page.url(),
      });
    });
  });
}

/** The page a request belongs to; `null` for a service worker's, which has no frame. */
function pageOf(request: Request): Page | null {
  let frame: Frame;
  try {
    frame = request.frame();
  } catch {
    return null;
  }
  return frame.page();
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    // A closed page or a detached frame mid-event: drop the event.
  }
}
