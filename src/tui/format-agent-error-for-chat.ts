import { formatLlamaUnreachableHint } from "../llm/llama-server-health.js";
import { looksLikeMidStreamDrop } from "../llm/reliability/index.js";

const MAX_CHARS = 480;

/**
 * Length past which a payload that *also* carries markup is treated as a
 * page rather than a sentence. Only ever consulted together with
 * `HTML_TAG` — see `classifyHtmlWall`.
 */
const WALL_CHARS = 800;

/**
 * The front matter of a real document. Case-insensitive on purpose:
 * appliances and old proxies still emit `<HTML><HEAD><TITLE>504 Gateway
 * Time-out</TITLE>`, and an uppercase page is every bit as much a page.
 */
const HTML_DOCUMENT_MARKER = /<!doctype\b|<html\b/i;

/** `div`, `soapenv:Body`, `my-widget` — optionally namespaced or hyphenated. */
const TAG_NAME = String.raw`[a-z][a-z0-9]*(?:[:-][a-z0-9]+)*`;

/** The same, but *required* to carry the `:` or the `-`. */
const QUALIFIED_TAG_NAME = String.raw`[a-z][a-z0-9]*(?:[:-][a-z0-9]+)+`;

/**
 * Names that are actually HTML elements, so a bare `<name>` with no
 * attributes and no slash can still be recognised as markup.
 *
 * The single-letter elements (`a`, `b`, `i`, `p`, `u`, `q`, `s`) are
 * deliberately absent: a bare `<T>`, `<U>` or `<B>` is a generic type
 * parameter far more often than it is markup, and the two are
 * indistinguishable by shape. Losing them costs nothing realistic — a
 * payload over 800 characters that carries markup carries more than one
 * bare `<p>`, and if it somehow does not, the outcome is 480 characters
 * of raw text rather than a fabricated diagnosis.
 */
const HTML_ELEMENT_NAME = [
  "big", "blockquote", "body", "br", "center", "code", "dd", "div",
  "dl", "dt", "em", "font", "footer", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "head", "header", "hr", "html", "li", "main", "nav", "ol",
  "pre", "script", "section", "small", "span", "strong", "style", "sub",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "title", "tr", "tt",
  "ul",
].join("|");

/**
 * A real markup tag. Four shapes, and the split between them is the
 * whole point:
 *
 * - a closing tag (`</center>`),
 * - a self-closing tag (`<br/>`, `<hr />`) — XHTML and appliance bodies
 *   are full of these, and the older pattern rejected them because `/`
 *   is neither whitespace nor `>`,
 * - an open tag carrying attributes (`<meta http-equiv="refresh" …>`),
 * - a *bare* open tag, but only when the name is either a genuine HTML
 *   element or namespaced/hyphenated (`<soapenv:Body>`, `<my-widget>`).
 *
 * That last restriction is the fix. Every stack-trace pseudo-frame has
 * exactly the shape of a bare open tag — `at Object.<anonymous>`,
 * `at Socket.<anonymous>`, `at new Promise (<anonymous>)`, JVM
 * `<init>`/`<clinit>`, Python `<module>` — and a pattern that accepts any
 * name accepts all of them. A bundled CJS CLI (`claude`, `codex`) prints
 * `at Object.<anonymous>` on any top-level throw, so the subscription-CLI
 * provider's verbatim stderr was reliably mistaken for a web page.
 *
 * The leading `(?<!\w)` is the other half: it separates a tag from a
 * generic type argument. `List<String>`, `Promise<void>`, `Array<number>`
 * and `Vector<Body>` all sit immediately after a word character;
 * `<body>`, `</td><td>` and `Gateway<br/><hr/>` do not (`>` is
 * deliberately allowed before a tag, because adjacent tags are how real
 * markup is written).
 */
const HTML_TAG = new RegExp(
  String.raw`(?<!\w)(?:` +
    String.raw`<\/${TAG_NAME}\s*>` +
    String.raw`|<${TAG_NAME}(?:\s[^<>]*)?\/>` +
    String.raw`|<${TAG_NAME}\s[^<>]*>` +
    String.raw`|<(?:${HTML_ELEMENT_NAME})>` +
    String.raw`|<${QUALIFIED_TAG_NAME}>` +
    `)`,
  "i",
);

/**
 * Where the failed turn was pointed, so a transport failure can say what
 * to actually do about it. The CLI has printed
 * `formatLlamaUnreachableHint` for years; the TUI dropped the same
 * failure as a bare `fetch failed` — this closes that gap. Gated on the
 * active provider being local because for a cloud provider the llama
 * hint would be advice about the wrong server.
 */
export interface LocalProviderErrorContext {
  activeProviderIsLocal: boolean;
  llamaUrl: string;
}

/**
 * What a dropped connection actually means, for an operator who
 * otherwise reads `Turn failed [transport]: terminated` and concludes
 * the whole task is gone.
 *
 * Keyed off `looksLikeMidStreamDrop`, not the classifier's broader
 * `looksLikeDroppedConnection`: line 1 asserts a reply was in flight,
 * which is false for undici's catch-all `fetch failed` (a connection
 * that never opened reads exactly the same). See the two lists in
 * `llm/reliability/network-error.ts`.
 *
 * Both lines are things the code guarantees, not hopes. The turn's
 * `tool_call` / `tool_result` rows are recorded into `SessionState.turns`
 * by `step-executor.ts` as each step completes; the agent loop's `failed`
 * branch RETURNS instead of throwing (agent-loop.ts, "Symmetric with the
 * cancelled path above"), so `executeTurn` in `runtime/bootstrap.ts`
 * reaches its `sessionStore.save(finished)`, and `chat-orchestrator.ts`
 * keeps that same session as the active one. The next message in the
 * session therefore renders those `tool_result` turns back into the
 * prompt (`prompt/build-prompt-world-conversation.ts`).
 *
 * Deliberately NOT promised: automatic resumption. Nothing retries or
 * replays the dead stream — `llm/fallback/prime-stream.ts` pins the
 * invariant that a stream which already emitted output is never
 * restarted — so the operator has to ask for the continuation.
 *
 * Known imprecision, unchanged in kind from `main`: the predicate is
 * unanchored, so a gateway that quotes its own upstream inside a JSON
 * body (`{"error":{"message":"upstream: socket hang up"}}`) is a reply
 * that DID arrive and still draws line 1. Line 2 stays true either way.
 */
const DROPPED_CONNECTION_HINT = [
  "the connection to the model dropped before the reply finished",
  "  the steps that already finished are kept in this session — ask to continue from there; re-sending the whole task starts it over",
].join("\n");

/**
 * How `body` failed to be an error *sentence*, or `null` when it is one.
 *
 * The case the substitution was written for: a misconfigured `baseUrl`
 * pointed at a web server, which answers a JSON POST with a whole HTML
 * document whose only useful content is its status code.
 *
 * Two ways in, and the caller treats them differently:
 *
 * - `"document"` — the front-matter markers every real error page
 *   carries (`<!DOCTYPE html>`, `<html lang=…>`, `<HTML>`);
 * - `"fragment"` — failing those, sheer bulk *plus* at least one real
 *   tag, for the pages that arrive without a preamble (an nginx body
 *   truncated to `<center>…`, an appliance that emits
 *   `502 Bad Gateway<br/><hr/>…`).
 *
 * Length alone used to be enough, and that was the bug: a long message
 * with no markup in it is not a wall, and scraping `/\b(\d{3})\b/` out
 * of one invents an HTTP status that never existed. The case in tree is
 * the subscription-CLI provider, whose failures carry a subprocess's
 * verbatim stderr — see `HTML_TAG` for why a Node crash dump kept
 * looking like markup even after that first repair.
 */
type HtmlWallKind = "document" | "fragment";

function classifyHtmlWall(body: string): HtmlWallKind | null {
  if (HTML_DOCUMENT_MARKER.test(body)) return "document";
  if (body.length > WALL_CHARS && HTML_TAG.test(body)) return "fragment";
  return null;
}

/**
 * Compact, chat-safe agent failure text (strips HTML walls from bad URLs).
 */
export function formatAgentErrorForChat(
  category: string,
  message: string,
  local?: LocalProviderErrorContext,
): string {
  // One normalisation, used for both the body and the drop predicate, so
  // the two can never disagree about what the transport said. Before,
  // the predicate read the raw `message` while the body read this
  // collapsed form, which meant `"socket\nhang\nup"` printed the drop
  // phrase and withheld its explanation. Collapsing cannot widen the
  // anchored pattern (`/^terminated$/i` already sees a trimmed string)
  // and can only help the unanchored ones find a phrase a line break
  // had split.
  const collapsed = message.trim().replace(/\s+/g, " ");
  let body = collapsed;
  // Set when the wall below throws the transport's own words away and
  // substitutes a diagnosis of its own.
  let diagnosedAsWall = false;
  const wall = classifyHtmlWall(body);
  if (wall != null) {
    // The status is only scraped out of a *document*. `/\b(\d{3})\b/`
    // has no idea what it is reading — inside a document it is almost
    // always the status line, but inside a bulky fragment the first
    // three-digit run is as likely to be a source line number, a port
    // or a byte count, and "upstream HTTP 519 (wrong API URL or
    // provider config)" is a confident lie built out of
    // `node:events:519:28`. When we are only guessing from bulk plus a
    // tag, say what we actually know instead.
    const status =
      wall === "document" ? /\b(\d{3})\b/.exec(body)?.[1] : undefined;
    body =
      status != null
        ? `upstream HTTP ${status} (wrong API URL or provider config)`
        : "upstream returned HTML instead of JSON (check API URL and provider)";
    diagnosedAsWall = true;
  }
  if (body.length > MAX_CHARS) {
    body = `${body.slice(0, MAX_CHARS)}…`;
  }
  const base = `Turn failed [${category}]: ${body}`;
  if (category === "transport") {
    // The local arm wins the overlap on purpose, and stays byte-identical
    // to what it has always emitted. A socket that dies on a local route
    // is nearly always llama-server itself going down or restarting, and
    // "start it with: atomic-agent models start" is a FIX; the drop hint
    // below is only an explanation. Stacking both would bury the fix
    // under five lines. The `terminated` case that prompted this — a
    // cloud provider dropping mid-stream — never reaches the local arm.
    if (local?.activeProviderIsLocal) {
      return `${base}\n${formatLlamaUnreachableHint(local.llamaUrl)}`;
    }
    // Matched on `collapsed`, never on `body`: `body` has been capped at
    // MAX_CHARS, so a drop phrase that sits past that cap survives in
    // one and not the other, and the hint must key off what the
    // transport actually said. Pinned by a test that fails if this is
    // switched to `body`.
    //
    // Except when the wall above fired: then `body` is not a truncation
    // of the transport's words but a *rival diagnosis* of the same
    // failure ("upstream returned HTML instead of JSON", "upstream HTTP
    // 502"), and the two explanations are mutually exclusive — a page of
    // HTML is a reply that arrived, not a reply that was cut off.
    // Printing both told the operator two incompatible stories at once.
    // The wall wins: it is the arm that looked at the whole payload,
    // where this one only pattern-matches a phrase inside it. This
    // suppression is only safe to the extent `classifyHtmlWall` is
    // right, which is why `HTML_TAG` has to reject stack frames: a
    // crash dump walled by mistake would lose its own stderr AND this
    // explanation at once.
    if (!diagnosedAsWall && looksLikeMidStreamDrop(collapsed)) {
      return `${base}\n${DROPPED_CONNECTION_HINT}`;
    }
  }
  return base;
}
