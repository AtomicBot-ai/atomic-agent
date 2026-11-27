/**
 * ATO-2536: an artifact page (a chat artifact, a canvas page, an MCP App)
 * must not reach the network through WebRTC. No CSP directive covers
 * `RTCPeerConnection`, and resolving a STUN or TURN server name goes past
 * `webRequest` and the permission handlers, so a page could carry data out
 * in DNS labels (`stun:<data>.attacker.example`) or a TURN-over-TCP
 * connection, even under `connect-src 'none'`.
 *
 * Three layers, all on the page's own document (artifact-frame.ts):
 *
 *   1. ARTIFACT_RTC_BLOCK_SCRIPT runs before anything of the page and sets
 *      every `RTC*` / `webkitRTC*` global to `undefined`, read-only and not
 *      configurable, so the page cannot put them back.
 *   2. A fresh realm would bring the constructors back (an `<iframe>` with no
 *      `src` is `about:blank`, which `frame-src 'none'` does not stop, and the
 *      page could read `frames[0].RTCPeerConnection`). So no child browsing
 *      context is ever made: `document.createElement(NS)` refuses frame-like
 *      tags, `customElements.define` refuses to extend them, `XSLTProcessor`
 *      is gone, and every HTML string goes through `stripChildFrames`:
 *      the static markup here before it is served, and dynamic strings
 *      (`innerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`,
 *      `createContextualFragment`, …) through a Trusted Types default
 *      policy, which `require-trusted-types-for 'script'` in the page CSP
 *      makes the browser apply at every HTML sink. A policy the page makes
 *      itself has its `createHTML` output stripped the same way, and
 *      `TrustedHTML.fromLiteral` is removed.
 *   3. main.ts sets the window's `setWebRTCIPHandlingPolicy
 *      ("disable_non_proxied_udp")`, as My Apps windows do (ATO-2383): no UDP,
 *      so no STUN lookup, even if a page found a way around 1 and 2. The
 *      window itself never makes a peer connection; voice and meetings use
 *      `getUserMedia` only, which the policy does not touch.
 *
 * Pure strings: no Electron import, so the unit suite loads it from `out/main`.
 */

/** Tag names that would make a child browsing context (and so a fresh realm). */
const CHILD_FRAME_TAGS = "i?frame|frameset|object|embed|fencedframe|portal";

/**
 * A start or end tag of a frame-like element, as the HTML tokenizer reads it:
 * `<`, an optional `/`, the name in any ASCII case, then whitespace, `/`, `>`
 * or the end. A NUL or any other character in the name makes it another name.
 */
const CHILD_FRAME_TAG_RE = new RegExp(`<(\\/?)(${CHILD_FRAME_TAGS})(?=[\\s/>]|$)`, "gi");

/** `<iframe …>` becomes `<x-blocked-iframe …>`, an unknown element that loads nothing. */
export function stripChildFrames(html: string): string {
  return String(html).replace(CHILD_FRAME_TAG_RE, "<$1x-blocked-$2");
}

/** The page CSP's extra directive: every HTML string goes through the default policy below. */
export const ARTIFACT_TRUSTED_TYPES_CSP = "require-trusted-types-for 'script'";

/** Put before the widget bridge and the page. Nothing here reaches the network. */
export const ARTIFACT_RTC_BLOCK_SCRIPT =
  "<script>(function(){var W=window,D=Object.defineProperty;"
  + "function lock(o,k,v){try{D(o,k,{value:v,writable:false,configurable:false});}catch(e){}}"
  + "Object.getOwnPropertyNames(W).forEach(function(n){if(/^(?:webkit)?RTC/.test(n))lock(W,n,undefined);});"
  + "var FR=/^(?:" + CHILD_FRAME_TAGS + ")$/i;"
  + "function no(){throw new DOMException('Frames are not available in an artifact','NotSupportedError');}"
  + "var dp=Document.prototype,ce=dp.createElement,cn=dp.createElementNS;"
  + "lock(dp,'createElement',function(n){if(FR.test(String(n)))no();return ce.apply(this,arguments);});"
  + "lock(dp,'createElementNS',function(s,q){if(FR.test(String(q).split(':').pop()))no();return cn.apply(this,arguments);});"
  + "if(W.CustomElementRegistry){var cp=CustomElementRegistry.prototype,cd=cp.define;"
  + "lock(cp,'define',function(n,c,o){if(o&&o.extends!==undefined&&FR.test(String(o.extends)))no();return cd.apply(this,arguments);});}"
  + "lock(W,'XSLTProcessor',undefined);"
  + "var S=new RegExp(" + JSON.stringify(CHILD_FRAME_TAG_RE.source) + ",'gi');"
  + "function strip(s){return String(s).replace(S,'<$1x-blocked-$2');}"
  + "var tt=W.trustedTypes;if(tt){var tp=Object.getPrototypeOf(tt),mk=tp.createPolicy;"
  + "lock(tp,'createPolicy',function(name,rules){var r={};if(rules)for(var k in rules)r[k]=rules[k];"
  + "if(rules&&typeof rules.createHTML==='function'){var h=rules.createHTML;r.createHTML=function(){return strip(h.apply(this,arguments));};}"
  + "return mk.call(this,name,r);});"
  + "mk.call(tt,'default',{createHTML:strip,createScript:function(s){return s;},createScriptURL:function(s){return s;}});"
  + "if(W.TrustedHTML)lock(W.TrustedHTML,'fromLiteral',undefined);}"
  + "})();</script>";
