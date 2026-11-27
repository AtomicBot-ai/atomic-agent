import { isLocalProviderUrl } from "../presets/is-local-provider-url.js";

/**
 * A cloud provider saying the model the person picked cannot take tool
 * calls (ATO-1673). The agent always sends its tools, so the same
 * request fails on any retry; the fix is another model.
 *
 * It read "rejected the request (400)." with the provider's sentence, and
 * OpenRouter's 404 "No endpoints found that support tool use" read "The
 * model id or the base URL is likely wrong", which sent the person to a
 * model id that was fine. A server on this machine has its own sentence
 * and advice (`local-bad-request.ts`, ATO-1209).
 *
 * A leaf with no import from the HTTP client, so it can read it without a
 * cycle.
 */
const TOOLS_UNSUPPORTED_WORDING =
  /\bdo(?:es)?(?: not|n't) support (?:tools|tool[ _]?(?:calls?|calling|use)|function[ _]calling)\b|\b(?:tools?|tool calling|function calling) (?:is|are) not (?:supported|enabled)\b|\bno endpoints found that support tool use\b|\b(?:cannot|can ?not|can't) use tools\b/i;

/** Statuses a provider answers a model without tool support with. */
const TOOLS_UNSUPPORTED_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);

/** Whether a cloud refusal says the model takes no tools. */
export function isCloudToolsUnsupported(status: number, url: string, text: string): boolean {
  return (
    TOOLS_UNSUPPORTED_STATUSES.has(status) &&
    !isLocalProviderUrl(url) &&
    TOOLS_UNSUPPORTED_WORDING.test(text)
  );
}

/**
 * The chat sentence: who said it, what it means, what to do. Keeps the
 * status in parentheses so the desktop still reads it as the provider
 * having replied.
 */
export function cloudToolsUnsupportedSentence(who: string, status: number): string {
  return (
    `${who} says this model can't use tools (${status}), and the agent needs them to work. ` +
    `Pick a model that supports tool calling.`
  );
}

/** The part of that sentence a reader of a failed turn matches on. */
const OWN_SENTENCE = /\bsays this model can't use tools\b/;

/** Whether a turn's error message is the sentence above. */
export function saysModelCannotUseTools(message: string): boolean {
  return OWN_SENTENCE.test(message);
}
