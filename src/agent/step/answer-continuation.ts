/**
 * Continuing an answer the server cut at its length limit (ATO-1031).
 *
 * A reply cut by `finish_reason: "length"` used to cost the whole step:
 * the turn-level retry (`truncation-recovery.ts`) runs the step again
 * from scratch, and a model that writes a long answer writes it long
 * again. When what was cut is the answer itself — a `reply` the model
 * had started writing — the text is already there. The step asks the
 * model once to write only the rest, and joins the two.
 *
 * Bounded on purpose: one continuation per step, never chained. A
 * continuation that is cut too ends the step with what arrived plus a
 * line saying it was cut (`CUT_AGAIN_NOTICE`); one that fails any other
 * way hands the step back to the old path, the original truncation error.
 *
 * Only a cut against a reply cap qualifies. A full context window
 * (`context_window`) has no room for more and is its own recovery;
 * a loop (`repetitive`) would only loop on.
 */

import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { DetectedModelFailure, TruncationCause } from "../../llm/index.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import { getReasoningTagOptions, normalizeContent } from "./step-reasoning.js";

/** Walls a continuation can get past: the reply ran out of ITS budget, not the window. */
const CONTINUABLE_CAUSES: ReadonlySet<TruncationCause> = new Set([
  "reply_cap",
  "output_limit",
  "provider_limit",
]);

/** Appended to a reply whose continuation was cut too. */
export const CUT_AGAIN_NOTICE =
  "[The answer was cut off: the model reached its reply length limit twice. Say \"continue\" to get the rest.]";

/** Is this cut one the step may try to continue? */
export function isContinuableTruncation(
  failure: Pick<DetectedModelFailure, "reason" | "truncation">,
  completion: Pick<CompletionResult, "earlyStop">,
): boolean {
  if (failure.reason !== "truncated") return false;
  const detail = failure.truncation;
  if (detail === undefined || detail.repetitive === true) return false;
  if (completion.earlyStop !== undefined) return false;
  return CONTINUABLE_CAUSES.has(detail.cause);
}

/** The opening of a grammar `reply` call's text, as `tool-call.gbnf` orders it. */
const GRAMMAR_REPLY_TEXT_OPEN =
  /^\s*\[\s*\{\s*"tool"\s*:\s*"reply"\s*,\s*"args"\s*:\s*\{\s*"text"\s*:\s*"/;

/** The opening of a native `reply` call's arguments. */
const NATIVE_REPLY_TEXT_OPEN = /^\s*\{\s*"text"\s*:\s*"/;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Decode a JSON string body that may be cut anywhere: up to the closing
 * quote when there is one, else to the end. A cut escape is dropped.
 */
export function decodePartialJsonString(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '"') break;
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = body.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }
    const simple = SIMPLE_ESCAPES[next];
    if (simple === undefined) break;
    out += simple;
    i += 2;
  }
  return out;
}

function textAfter(open: RegExp, raw: string): string | null {
  const match = open.exec(raw);
  if (match === null) return null;
  return decodePartialJsonString(raw.slice(match[0].length));
}

/**
 * The answer text a cut completion already carries, or `null` when what
 * was cut is not an answer (a tool call, a think block, nothing).
 *
 *  - grammar: the first call of the array is `reply` and its `text` had
 *    started;
 *  - native tools: one `reply` call whose `text` had started, or plain
 *    prose with no tool calls at all (delivered as a reply).
 */
export function extractPartialAnswer(
  completion: CompletionResult,
  transport: ToolCallTransport,
  profile: ModelProfile,
  assumeOpenReasoning: boolean,
): string | null {
  let text: string | null;
  if (transport === "native_tools") {
    const calls = completion.toolCalls ?? [];
    if (calls.length > 1) return null;
    if (calls.length === 1) {
      const call = calls[0]!;
      if (call.function.name !== "reply") return null;
      text = textAfter(NATIVE_REPLY_TEXT_OPEN, call.function.arguments);
    } else {
      const body = afterReasoning(completion.content, profile);
      const trimmed = body === null ? null : body.trimStart();
      text =
        trimmed === null || trimmed.startsWith("{") || trimmed.startsWith("[")
          ? null
          : trimmed;
    }
  } else {
    const body = afterReasoning(
      normalizeContent(completion, profile, assumeOpenReasoning),
      profile,
    );
    text = body === null ? null : textAfter(GRAMMAR_REPLY_TEXT_OPEN, body);
  }
  if (text === null || text.trim().length === 0) return null;
  return text;
}

/**
 * The text after the model's last closed reasoning block; `null` while a
 * block is still open (the cut came mid-thought: no answer yet). Read
 * off the raw text rather than `extractReasoning`'s body, which is
 * trimmed: a cut answer's trailing space is part of the answer.
 */
function afterReasoning(raw: string, profile: ModelProfile): string | null {
  const tags = getReasoningTagOptions(profile);
  const open = tags.openTag ?? "<think>";
  const close = tags.closeTag ?? "</think>";
  const closeAt = raw.lastIndexOf(close);
  if (closeAt >= 0) return raw.slice(closeAt + close.length);
  return raw.includes(open) ? null : raw;
}

/** Longest overlap looked for between the end of the partial and the start of the rest. */
const MAX_OVERLAP_CHARS = 400;
/** Shorter overlaps are left alone: a few shared characters are likelier chance than a repeat. */
const MIN_OVERLAP_CHARS = 12;

/**
 * Join the partial answer and its continuation. A model that restarted
 * from the top is believed over the partial; one that repeated the last
 * words it saw has them dropped once.
 */
export function joinContinuation(partial: string, rest: string): string {
  const head = partial.trimStart();
  if (rest.trimStart().startsWith(head)) return rest.trimStart();
  const limit = Math.min(MAX_OVERLAP_CHARS, head.length, rest.length);
  for (let k = limit; k >= MIN_OVERLAP_CHARS; k -= 1) {
    if (head.endsWith(rest.slice(0, k))) return head + rest.slice(k);
  }
  return head + rest;
}

/**
 * Put the joined text into the continuation's batch: its first call
 * must be a `reply` with text, and that text becomes the whole answer.
 * Anything else is not a continuation of the reply, and `null` says so.
 */
export function rewriteContinuedReply(
  batch: ToolCallBatch,
  partial: string,
): ToolCallBatch | null {
  const first = batch.calls[0];
  if (first === undefined || first.tool !== "reply") return null;
  const text = first.args.text;
  if (typeof text !== "string") return null;
  return {
    ...batch,
    calls: [
      { ...first, args: { ...first.args, text: joinContinuation(partial, text) } },
      ...batch.calls.slice(1),
    ],
  };
}

/** The batch a continuation that was cut too ends the step with. */
export function cutAgainReplyBatch(partial: string, rest: string | null): ToolCallBatch {
  const joined = rest === null ? partial.trimStart() : joinContinuation(partial, rest);
  return {
    kind: "batch",
    calls: [
      {
        tool: "reply",
        args: { text: `${joined.trimEnd()}\n\n${CUT_AGAIN_NOTICE}` },
      },
    ],
  };
}

/**
 * The block appended to the step's prompt for the continuation request.
 * It quotes the partial answer — the model has no other way to see it —
 * and asks for the rest only, in the shape the transport expects.
 */
export function formatContinuationNotice(
  partial: string,
  transport: ToolCallTransport,
): string {
  const how =
    transport === "native_tools"
      ? "Call `reply` through the function-calling interface with ONLY the remaining part as its text."
      : 'Emit a length-1 JSON array with one `reply` call whose text is ONLY the remaining part: [{"tool":"reply","args":{"text":"..."}}].';
  return [
    "### answer-continuation",
    "Your previous reply to this step was cut off at the reply length limit before it finished. Nothing has run and the user has not received it yet.",
    "This is the part you already wrote, between the markers:",
    "<<<PARTIAL",
    partial,
    "PARTIAL>>>",
    "Continue the answer exactly where it stops. Do not repeat any of it, do not start over, and keep your reasoning brief.",
    how,
  ].join("\n");
}
