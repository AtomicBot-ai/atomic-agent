/**
 * ATO-2536, review round 2: an artifact frame must not swap its own document
 * for one main did not serve.
 *
 * The page could do `location.href = URL.createObjectURL(new Blob([html]))`
 * (a `blob:` document, which the PDF preview's rule used to let through) or
 * `location = "javascript:'<script>…'"`. Either way the frame gets a new
 * document with a fresh realm: no guard (artifact-page-guard.ts), so a fresh
 * RTCPeerConnection. No child frame is made, so watchArtifactChildFrames
 * never sees it.
 *
 * So, in main, for the window's frames:
 *
 *   - frameNavAllowed: a frame in artifact scope (it shows an
 *     `atomic-art://` page, sits under one, was seen showing one, or the
 *     navigation was started by such a frame) may go only to another
 *     `atomic-art://<token>/` page. The one exception is the window itself
 *     clearing the frame to `about:blank`. Every other frame keeps
 *     subframeNavAllowed, except that a `blob:` target must be the window's
 *     own (`blob:file://…`, what the PDF preview makes): an artifact page's
 *     blobs are `blob:null/…`, since its origin is opaque.
 *   - watchArtifactNavigation: if a document still commits in an artifact
 *     frame (`did-frame-navigate`), main runs the guard in it at once. When
 *     it is not an `atomic-art://` page at all, main then sends the frame
 *     to ARTIFACT_GONE_URL, a "Not found" page, which unloads the document
 *     and ends every connection it started. A `javascript:` document keeps
 *     the page's URL; the page's Trusted Types policy refuses that sink
 *     before it gets here (artifact-page-guard.ts).
 *   - No window: the window's open handler always denies, and
 *     `did-create-window` closes any window that appears anyway.
 *
 * Pure: no Electron import; main.ts hands in `webFrameMain.fromId`.
 */

import { artifactFrameAbove, artifactToken, subframeNavAllowed } from "./artifact-frame.js";
import { ARTIFACT_RTC_BLOCK_JS } from "./artifact-rtc-block.js";

/** The part of Electron's WebFrameMain read here. */
export type NavFrame = {
  url: string;
  parent: NavFrame | null;
  frameTreeNodeId?: number;
  executeJavaScript?: (code: string) => Promise<unknown>;
};

/** What `will-frame-navigate` carries (Electron's event object). */
export type FrameNavigation = {
  url: string;
  isMainFrame: boolean;
  frame?: NavFrame | null;
  initiator?: NavFrame | null;
};

/** A token the store never hands out, so the page answers "Not found". */
export const ARTIFACT_GONE_URL = `atomic-art://${"0".repeat(32)}/`;

/** The frame shows an artifact page or sits under one. */
export function inArtifactScope(frame: NavFrame | null | undefined): boolean {
  if (!frame) return false;
  return artifactToken(frame.url) !== null || artifactFrameAbove(frame) !== null;
}

/** A `blob:` URL the window itself made (its origin is `file://`). */
export function windowBlob(url: string): boolean {
  return /^blob:file:\/\//i.test(String(url || ""));
}

/**
 * May this subframe navigation go ahead? `seen` holds the frame ids that
 * have shown an artifact page (watchArtifactNavigation keeps it).
 */
export function frameNavAllowed(nav: FrameNavigation, seen: ReadonlySet<number> = new Set()): boolean {
  if (nav.isMainFrame) return true;
  const url = String(nav.url || "");
  const frame = nav.frame ?? null;
  const initiator = nav.initiator ?? null;
  const id = frame?.frameTreeNodeId;
  const scoped = !frame || inArtifactScope(frame) || inArtifactScope(initiator) || (id !== undefined && seen.has(id));
  if (scoped) {
    if (artifactToken(url) !== null) return true;
    // The window clearing a frame it owns; never the page itself.
    const byWindow = !!initiator && initiator.parent === null && !inArtifactScope(initiator);
    return !!frame && byWindow && url.toLowerCase() === "about:blank";
  }
  if (/^blob:/i.test(url)) return windowBlob(url);
  return subframeNavAllowed(url);
}

/** The part of Electron's WebContents used here. */
export type NavContents = {
  on(event: "will-frame-navigate", listener: (event: FrameNavigation & { preventDefault(): void }) => void): unknown;
  on(
    event: "did-frame-navigate",
    listener: (event: unknown, url: string, code: number, status: string, isMainFrame: boolean, processId: number, routingId: number) => void,
  ): unknown;
  on(event: "did-create-window", listener: (win: { close(): void }) => void): unknown;
};

export type NavGuardDeps = {
  /** `webFrameMain.fromId`. */
  frameFromId: (processId: number, routingId: number) => NavFrame | null | undefined;
};

/** Run the guard in a frame's document; the frame may already be gone. */
function reguard(frame: NavFrame, then?: string): void {
  const run = frame.executeJavaScript;
  if (typeof run !== "function") return;
  try {
    void Promise.resolve(run.call(frame, ARTIFACT_RTC_BLOCK_JS))
      .catch(() => undefined)
      .then(() => (then ? run.call(frame, then) : undefined))
      .catch(() => undefined);
  } catch { /* the frame is gone */ }
}

/** Wire the three handlers on the window's contents. Returns the seen-frame set (for tests). */
export function watchArtifactNavigation(contents: NavContents, deps: NavGuardDeps): Set<number> {
  const seen = new Set<number>();
  contents.on("will-frame-navigate", (event) => {
    if (!frameNavAllowed(event, seen)) { event.preventDefault(); return; }
    const id = event.frame?.frameTreeNodeId;
    if (event.isMainFrame || id === undefined) return;
    if (artifactToken(event.url) !== null) seen.add(id);
    else if (String(event.url).toLowerCase() === "about:blank") seen.delete(id); // the window cleared it
  });
  contents.on("did-frame-navigate", (_event, url, _code, _status, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    let frame: NavFrame | null | undefined = null;
    try { frame = deps.frameFromId(processId, routingId); } catch { frame = null; }
    if (!frame) return;
    const id = frame.frameTreeNodeId;
    const wasArtifact = id !== undefined && seen.has(id);
    if (artifactToken(url) !== null) {
      if (id !== undefined) seen.add(id);
      // Served pages carry the guard already; running it again changes nothing
      // there, and covers a document that kept the page's URL.
      reguard(frame);
      return;
    }
    if (!wasArtifact && !inArtifactScope(frame)) return;
    reguard(frame, `location.replace(${JSON.stringify(ARTIFACT_GONE_URL)})`);
  });
  contents.on("did-create-window", (win) => {
    try { win.close(); } catch { /* already closed */ }
  });
  return seen;
}
