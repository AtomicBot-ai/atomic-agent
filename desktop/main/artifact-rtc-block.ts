/**
 * ATO-2536: an artifact page (a chat artifact, a canvas page, an MCP App)
 * must not reach the network through WebRTC. No CSP directive covers
 * `RTCPeerConnection`, and resolving a STUN or TURN server name goes past
 * `webRequest` and the permission handlers, so a page could carry data out
 * in DNS labels (`stun:<data>.attacker.example`) or a TURN-over-TCP
 * connection, even under `connect-src 'none'`.
 *
 * The layers:
 *
 *   1. ARTIFACT_RTC_BLOCK_SCRIPT (artifact-page-guard.ts) runs before
 *      anything of the page and sets every `RTC*` / `webkitRTC*` global to
 *      `undefined`, read-only and not configurable, so the page cannot put
 *      them back. It uses only built-ins it captured before the page ran, so
 *      a page that changes `RegExp.prototype`, `String.prototype`,
 *      `Function.prototype.apply` or `Object.prototype` does not turn it off.
 *   2. A fresh realm would bring the constructors back (an `<iframe>` with no
 *      `src` is `about:blank`, which `frame-src 'none'` does not stop, and the
 *      page could read `frames[0].RTCPeerConnection`). So no child browsing
 *      context is made: `createElement(NS)` and
 *      `document.implementation.createDocument` refuse frame-like names (with
 *      or without a prefix), `customElements.define` refuses to extend them,
 *      `XSLTProcessor` is gone, `DOMParser` refuses an XML `<!DOCTYPE` (an
 *      entity could spell a tag the string check never sees), and every HTML
 *      string goes through the frame strip: the static markup here
 *      (`stripChildFrames`) before it is served, and dynamic strings
 *      (`innerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`,
 *      `createContextualFragment`, …) through a Trusted Types default
 *      policy, which `require-trusted-types-for 'script'` in the page CSP
 *      makes the browser apply at every HTML sink. A policy the page makes
 *      itself has its `createHTML` output stripped the same way, and
 *      `TrustedHTML.fromLiteral` is removed. A `document.write` that stops
 *      inside a tag name is refused, since the parser would join it with the
 *      next one.
 *      The default policy's `createScript` passes only the sinks that run
 *      in the same realm, so a `javascript:` self-navigation (sink
 *      "Location href"), which would give the frame a new document, is
 *      refused (review round 2).
 *   2b. Main (artifact-nav-guard.ts): a frame that shows an artifact page,
 *      or that such a page starts a navigation of, may only go to another
 *      `atomic-art://` page, never to `blob:`, `data:`, `javascript:` or
 *      `about:`; a `blob:` target anywhere must be the window's own
 *      (`blob:file://`). If a document main did not serve still commits in
 *      an artifact frame, main runs this guard in it and sends the frame to
 *      a "Not found" page.
 *   3. Main (artifact-frame-ipc.ts, watchArtifactChildFrames): if a child
 *      frame still appears under an artifact page, main forgets the page and
 *      reloads its frame, which ends every connection the page started. This
 *      runs after the fact (the page may already have sent a first packet),
 *      so it is a backstop, not the gate.
 *   4. main.ts sets the window's `setWebRTCIPHandlingPolicy
 *      ("disable_non_proxied_udp")`, as My Apps windows do (ATO-2383): no UDP,
 *      so no STUN lookup. It does not stop TURN over TCP, and Electron has no
 *      stricter policy, which is why 1 and 2 must hold on their own. The
 *      window itself never makes a peer connection; voice and meetings use
 *      `getUserMedia` only, which the policy does not touch. The page CSP
 *      also carries `webrtc 'block'` for Chromium builds that honour it.
 *
 * Pure strings: no Electron import, so the unit suite loads it from `out/main`.
 */

import { artifactPageGuard } from "./artifact-page-guard.js";

/** Tag names that would make a child browsing context (and so a fresh realm). */
export const CHILD_FRAME_TAG_NAMES = ["iframe", "frame", "frameset", "object", "embed", "fencedframe", "portal"];

/**
 * A start or end tag of a frame-like element, as the HTML or XML tokenizer
 * reads it: `<`, an optional `/`, an optional namespace prefix (`h:`, which
 * DOMParser's XML mode honours), the name in any ASCII case, then
 * whitespace, `/`, `>` or the end. A NUL or any other character in the name
 * makes it another name. artifact-page-guard.ts applies the same rule in the
 * page without a RegExp.
 */
const CHILD_FRAME_TAG_RE = new RegExp(`<(\\/?)((?:[^\\s/>:<]*:)*)(${CHILD_FRAME_TAG_NAMES.join("|")})(?=[\\s/>]|$)`, "gi");

/** `<iframe …>` becomes `<x-blocked-iframe …>` (`<h:iframe>` becomes `<h:x-blocked-iframe>`), an unknown element that loads nothing. */
export function stripChildFrames(html: string): string {
  return String(html).replace(CHILD_FRAME_TAG_RE, "<$1$2x-blocked-$3");
}

/**
 * The page CSP's extra directives: every HTML string goes through the
 * default policy (artifact-page-guard.ts), and the CSP3 `webrtc 'block'`
 * directive, which a child about:blank frame would inherit. A Chromium build
 * that does not know `webrtc` ignores it, so nothing here relies on it.
 */
export const ARTIFACT_PAGE_EXTRA_CSP = "require-trusted-types-for 'script'; webrtc 'block'";

/** The guard as plain script text; main also runs it in a document of an artifact frame it did not serve (artifact-nav-guard.ts). */
export const ARTIFACT_RTC_BLOCK_JS = `(${artifactPageGuard.toString()})(${JSON.stringify(CHILD_FRAME_TAG_NAMES)});`;

/** Put before the widget bridge and the page. Nothing here reaches the network. */
export const ARTIFACT_RTC_BLOCK_SCRIPT = `<script>${ARTIFACT_RTC_BLOCK_JS}</script>`;
