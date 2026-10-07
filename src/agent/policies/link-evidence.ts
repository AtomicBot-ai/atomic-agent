import type { ConversationTurn } from "../../session/conversation-turn.js";

/**
 * Links need a source.
 *
 * A final `reply` that hands the operator a link is read as the link a
 * tool found. Live, it was not: `os.web.search` returned the right URL
 * and the reply printed it with a slug word dropped — a page that does
 * not exist, on the right site, presented as the search result. Nothing
 * compared the reply with the turn's tool results.
 *
 * This does, for http(s) links only. Every URL in the reply is matched
 * against the URLs the transcript already holds: the operator's
 * messages, the arguments of the calls made, the tool results, and
 * earlier delivered replies. A link that matches none of them, on a host this
 * turn's tool results did return links for, is the mangling case — the
 * model meant a link it was given and wrote a different one. It earns
 * one `### notice` and one more step, the same shape as
 * `claim-evidence.ts`: the reply is not delivered, the model is told
 * which link, and the exit is named (copy it from the result, or drop
 * it). Once per turn: a second reply that still carries it is delivered,
 * and the trace marks it.
 *
 * Held to warn-once and kept narrow on purpose. It runs only when this
 * turn's tool results returned at least one link, so a reply that cites
 * a URL from memory with no tool in sight is left alone (a different
 * problem), and a link on a host no result mentioned is left alone too.
 * A link the reply shortens to a parent path of a known one ("the repo"
 * for a file in it) counts as known. Values other than links — a GPU
 * name, a price — are not checked.
 */

/** A link in the reply that no source in the transcript holds. */
export interface UnsourcedLink {
  /** The URL as the reply wrote it, trailing punctuation trimmed. */
  url: string;
}

/** The links a reply is checked against, read from the transcript. */
export interface LinkSources {
  /** Normalised keys of every URL the transcript holds. */
  known: ReadonlySet<string>;
  /**
   * Hosts of the URLs this turn's tool results returned. Empty when this
   * turn's results held no link — then nothing is checked.
   */
  turnResultHosts: ReadonlySet<string>;
}

/** The most links a notice names; the rest are counted, not quoted. */
const MAX_NAMED = 5;

/**
 * What ends a link besides whitespace and ASCII delimiters: the quotes,
 * brackets and sentence punctuation of other scripts (`«…»`, `“…”`,
 * `「…」`, `（…）`, `。，、；：！？`, `…`, dashes), the CJK punctuation and
 * fullwidth blocks, and CJK script itself — Chinese and Japanese text
 * runs on with no space after a link (`见https://…，谢谢`). Cyrillic and
 * other letters stay in, so an IRI path like `/wiki/Москва` is whole.
 */
const NON_ASCII_STOPS =
  "«»“”‘’„‟‹›「」『』（）【】〔〕〖〗《》〈〉。，、；：！？…‥—–" +
  "\\u3000-\\u303F\\uFF00-\\uFFEF" +
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";

const URL_RE = new RegExp(
  `\\bhttps?:\\/\\/[^\\s<>"'\`[\\]{}|\\\\^${NON_ASCII_STOPS}]+`,
  "giu",
);

/** Characters a sentence or markup puts after a link, not part of it. */
const TRAILING = /[.,;:!?'"*_~>]+$/;

/**
 * Trim what prose or markdown wrapped around a link: trailing sentence
 * punctuation, emphasis markers, and a closing `)` with no opening one
 * inside the link (`[text](https://…)`, "(see https://…)").
 */
function trimLink(raw: string): string {
  let url = raw.replace(/&amp;/g, "&");
  for (;;) {
    const before = url;
    url = url.replace(TRAILING, "");
    if (url.endsWith(")")) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) url = url.slice(0, -1);
    }
    if (url === before) return url;
  }
}

/** Every http(s) link in `text`, as written, in order, without repeats. */
export function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = trimLink(match[0]);
    if (!/^https?:\/\/[^/?#]+/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/**
 * The form two spellings of one link share: scheme and `www.` ignored,
 * host lower-cased, percent-encoding decoded, the fragment dropped, and
 * a trailing slash on the path ignored. `null` for a link that does not
 * parse.
 */
export function normalizeLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = linkHost(parsed);
  const path = safeDecode(parsed.pathname).replace(/\/+$/, "");
  const query = parsed.search.length > 1 ? safeDecode(parsed.search) : "";
  return `${host}${path}${query}`;
}

function linkHost(parsed: URL): string {
  return parsed.host.toLowerCase().replace(/^www\./, "");
}

function hostOf(url: string): string | null {
  try {
    return linkHost(new URL(url));
  } catch {
    return null;
  }
}

/**
 * Whether the normalised `key` is a known link, or a parent of one cut
 * at a path or query boundary — a reply that names the repository a
 * result linked a file in has not changed the link.
 */
function isKnown(key: string, known: ReadonlySet<string>): boolean {
  if (known.has(key)) return true;
  for (const candidate of known) {
    if (
      candidate.startsWith(key) &&
      (candidate[key.length] === "/" || candidate[key.length] === "?")
    ) {
      return true;
    }
  }
  return false;
}

/** The text of a call's arguments, for the links it was given. */
function argsText(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
}

/**
 * What the transcript holds, for the reply now being checked. Known
 * links come from the whole transcript; the hosts that arm the check
 * come only from this turn's tool results (everything after the last
 * `user` turn, as `turnToolCalls` reads a turn).
 *
 * `observed` is other text the model was shown alongside the transcript
 * (the browser page's ARIA snapshot, whose `/url:` lines are the page's
 * links). Its links count as known, so a reply that quotes a link off
 * the open page is not held; they do not arm the check.
 */
export function linkSources(
  turns: readonly ConversationTurn[],
  observed: readonly string[] = [],
): LinkSources {
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.kind === "user") {
      start = i + 1;
      break;
    }
  }
  const known = new Set<string>();
  const turnResultHosts = new Set<string>();
  const add = (text: string, fromTurnResult: boolean): void => {
    for (const url of extractLinks(text)) {
      const key = normalizeLink(url);
      if (key === null) continue;
      known.add(key);
      if (fromTurnResult) {
        const host = hostOf(url);
        if (host !== null) turnResultHosts.add(host);
      }
    }
  };
  for (const text of observed) add(text, false);
  turns.forEach((turn, i) => {
    switch (turn.kind) {
      case "user":
        add(turn.text, false);
        break;
      case "assistant_reply":
        // An earlier answer the operator already has; a progress note is
        // the model's own words mid-turn, not a source.
        if (turn.progressNote !== true) add(turn.text, false);
        break;
      case "assistant_tool_call":
        // A held `reply` is recorded as a call and its refusal as a
        // result; neither is a source for the link it carried.
        if (turn.tool !== "reply") add(argsText(turn.args), false);
        break;
      case "tool_result":
        if (turn.tool !== "reply") add(turn.summary, i >= start);
        break;
    }
  });
  return { known, turnResultHosts };
}

/**
 * The links in `replyText` no source holds, on a host this turn's
 * results returned links for. Empty when this turn's results held no
 * link at all.
 */
export function unsourcedLinks(
  replyText: string,
  sources: LinkSources,
): UnsourcedLink[] {
  if (sources.turnResultHosts.size === 0) return [];
  const out: UnsourcedLink[] = [];
  for (const url of extractLinks(replyText)) {
    const key = normalizeLink(url);
    const host = hostOf(url);
    if (key === null || host === null) continue;
    if (!sources.turnResultHosts.has(host)) continue;
    if (isKnown(key, sources.known)) continue;
    out.push({ url });
  }
  return out;
}

function quoteLinks(links: readonly UnsourcedLink[]): string {
  const named = links
    .slice(0, MAX_NAMED)
    .map((link) => `"${link.url}"`)
    .join(", ");
  const rest = links.length - MAX_NAMED;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/**
 * The next-step notice. Names the link as written, says no result holds
 * it, and names both exits — copy the link from the result, or drop it
 * — so the model does not answer with the same link again.
 */
export function formatUnsourcedLinkNotice(
  links: readonly UnsourcedLink[],
): string {
  const one = links.length === 1;
  return `Your reply links ${quoteLinks(links)} but no tool result this turn holds ${one ? "that link" : "those links"}. Copy each link exactly as the tool result gave it, or remove it, then reply again.`;
}

/** The tool result that stands in for the reply that was not delivered. */
export function formatUnsourcedLinkRefusal(
  links: readonly UnsourcedLink[],
): string {
  return `not delivered: the reply links ${quoteLinks(links)}, which no tool result this turn holds. Copy the link exactly as the result gave it, or remove it, then reply again.`;
}
