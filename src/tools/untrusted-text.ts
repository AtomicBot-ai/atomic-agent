/**
 * Text someone else wrote (a web page, an MCP server's answer, the
 * command an agent wants to run) is put inside a fenced block the model
 * is told to read as data (ATO-1378). The fence carries a nonce, so text
 * inside cannot close the block and go on as instructions:
 *
 *   <<<UNTRUSTED LABEL nonce>>>
 *   ...
 *   <<<END UNTRUSTED LABEL nonce>>>
 *
 * Inside the block, every copy of the nonce is removed and every
 * fence-shaped line the content brought with it (`<<<UNTRUSTED ...>>>`,
 * `<<<END UNTRUSTED ...>>>`, with any nonce) is defused, so a page cannot
 * draw a fake end of block either. Used by the risk reviewer
 * (`approval/risk-review.ts`), by tool results that declare
 * `untrustedOutput` (`untrusted-tool-output.ts`) and by the browser page
 * in `### world` (`prompt/build-prompt-world-conversation.ts`).
 */
import { createHmac, randomBytes } from "node:crypto";

/** What a defused fence in the content becomes. */
export const DEFUSED_FENCE = "[fake untrusted-block marker removed]";

/**
 * A fence the content brought with it: `<<<` (spacing and case aside),
 * an optional END, the word UNTRUSTED, anything up to `>>>`. Also the
 * half-open form without `>>>`, so a broken copy is defused too.
 */
const FORGED_FENCE_SOURCE = String.raw`<\s*<\s*<\s*(?:END\s+)?UNTRUSTED\b[^\n]*?(?:>\s*>\s*>|$)`;
const FORGED_FENCE = new RegExp(FORGED_FENCE_SOURCE, "gimu");
/** The same, without `g`, so `test` keeps no state between calls. */
const HAS_FORGED_FENCE = new RegExp(FORGED_FENCE_SOURCE, "imu");

/** A fresh unguessable nonce (16 hex characters). */
export function newUntrustedNonce(): string {
  return randomBytes(8).toString("hex");
}

/** Key for {@link stableUntrustedNonce}; new on every start of the process. */
const PROCESS_KEY = randomBytes(32);

/**
 * A nonce that is the same for the same content within one process and
 * that the content's author cannot predict (an HMAC under a key made at
 * start-up). Used where the same text is rendered into many prompts, so
 * the prompt keeps the same bytes and a cached prefix stays valid.
 */
export function stableUntrustedNonce(content: string): string {
  return createHmac("sha256", PROCESS_KEY).update(content).digest("hex").slice(0, 16);
}

/** Remove the nonce and defuse fence-shaped text in `content`. */
export function sanitizeUntrustedContent(content: string, nonce: string): string {
  return content.split(nonce).join("").replace(FORGED_FENCE, DEFUSED_FENCE);
}

/**
 * Wrap `content` in a block the model is told to read as data. `label`
 * is a short upper-case name chosen by code (never by the content).
 */
export function wrapUntrusted(label: string, content: string, nonce: string): string {
  return [
    `<<<UNTRUSTED ${label} ${nonce}>>>`,
    sanitizeUntrustedContent(content, nonce),
    `<<<END UNTRUSTED ${label} ${nonce}>>>`,
  ].join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `text` is exactly one block made by {@link wrapUntrusted}
 * with `label`: it opens and closes with the same nonce and the nonce
 * appears nowhere in between. A forged block that leaves text outside
 * the fence, or reuses its nonce inside, is not one.
 */
export function isWrappedUntrusted(text: string, label: string): boolean {
  const head = new RegExp(`^<<<UNTRUSTED ${escapeRegExp(label)} ([0-9a-f]{16})>>>\\n`);
  const match = head.exec(text);
  if (match === null) return false;
  const nonce = match[1] as string;
  const tail = `\n<<<END UNTRUSTED ${label} ${nonce}>>>`;
  if (!text.endsWith(tail)) return false;
  const inner = text.slice(match[0].length, text.length - tail.length);
  return !inner.includes(nonce) && !HAS_FORGED_FENCE.test(inner);
}
