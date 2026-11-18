import type { StepContext, StepDependencies } from "./step-contract.js";
import type { PreparedStepInference } from "./step-inference.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { StepBatchPolicy } from "./step-batch-policy.js";
import type { ParseDeps, ToolCallBatchParseResult } from "./step-parsing.js";
import { tryParseToolCalls, parseDepsFor, rawPreview, logTextPreview, replyFallbackBatch } from "./step-parsing.js";
import { validateBatch } from "./step-batch-policy.js";
import { GrammarError } from "../../llm/index.js";
import { extractReasoning, parseToolCalls } from "../../llm/grammar/tool-call-grammar.js";
import { completionAssumesOpenReasoning, getReasoningTagOptions, normalizeContent, resolveReasoning } from "./step-reasoning.js";
import { judgeRepairedBatch, repairRefusedError } from "./step-json-repair.js";

export interface StepBatchParsingArgs {
  ctx: StepContext;
  deps: StepDependencies;
  prepared: PreparedStepInference;
  completion: CompletionResult;
  policy: StepBatchPolicy;
  assumesOpenReasoning: (completion: CompletionResult) => boolean;
  /**
   * Rewrites the parsed batch before the step's policies see it; `null`
   * rejects it. The cut-answer continuation (ATO-1031) joins its reply
   * text here, so a reply batched with work is still read as a
   * progress note on the joined text.
   */
  rewrite?: (batch: ToolCallBatch) => ToolCallBatch | null;
}

export function parseStepBatch(args: StepBatchParsingArgs): ToolCallBatchParseResult {
  const { deps, prepared, completion, policy } = args;
  const { stepDescriptors, thinkingOff } = prepared;

  let parsed = tryParseToolCalls(
    completion,
    deps.profile,
    parseDepsFor(completion, deps),
    // The list the REQUEST was built from — the strict-widened map must
    // come from the same array the wire payload did.
    stepDescriptors,
    thinkingOff,
  );
  parsed = readForeignShapes(args, completion, parsed);
  parsed = admitRepairedJson(args, completion, parsed);
  parsed = admitProseWithoutGrammar(args, completion, parsed);
  if (parsed.ok && args.rewrite !== undefined) {
    const rewritten = args.rewrite(parsed.batch);
    parsed =
      rewritten === null
        ? { ok: false, error: new Error("the batch was not accepted by the step's rewrite") }
        : { ok: true, batch: rewritten };
  }
  if (parsed.ok) {
    const taken = policy.takeProgressNote(parsed.batch, completion);
    policy.setProgressNote(taken.note);
    parsed = { ok: true, batch: taken.batch };
    const validation = validateBatch(parsed.batch, deps.registry);
    if (!validation.ok) {
      // Try the cheap mechanical fixes first, in order:
      //   1. Wave split (issue #111): an oversized batch whose calls
      //      are ALL `pure_read` and schema-valid runs deterministically
      //      in bounded waves — no LLM repair round-trip.
      //   2. Approval-gated trim: a batch whose only failure is
      //      "approval-gated tools must be solo" (and is NOT oversized)
      //      trims to the first approval-gated call.
      // Anything else (terminal verbs in a batch, oversized mixed
      // batches, unknown resource class) still routes through the model
      // so it can re-plan.
      const split = policy.trySplitPureReadWaves(parsed.batch);
      if (split !== null) {
        parsed = split;
      } else {
        const trimmed = policy.tryTrimApprovalGated(parsed.batch, validation.error);
        if (trimmed !== null) {
          parsed = trimmed;
        } else {
          parsed = { ok: false, error: validation.error };
        }
      }
    }
  }
  return parsed;
}

export function finishStepBatchRepair(
  args: StepBatchParsingArgs,
  completion: CompletionResult,
  retryParseDeps: ParseDeps,
): { ok: true; batch: ToolCallBatch } {
  const { ctx, deps, prepared, policy, assumesOpenReasoning } = args;
  // The descriptors the request was BUILT from, as in the first parse:
  // the strict-widened and wire-name maps must match the wire.
  const { stepDescriptors, thinkingOff } = prepared;

  let parsed = tryParseToolCalls(
    completion,
    deps.profile,
    retryParseDeps,
    stepDescriptors,
    thinkingOff,
  );
  parsed = readForeignShapes(args, completion, parsed);
  parsed = admitRepairedJson(args, completion, parsed);
  if (parsed.ok) {
    const taken = policy.takeProgressNote(parsed.batch, completion);
    policy.setProgressNote(taken.note);
    parsed = { ok: true, batch: taken.batch };
    const validation = validateBatch(parsed.batch, deps.registry);
    if (!validation.ok) {
      // Same mechanical-fix shortcuts for the post-repair attempt:
      // if the model came back from repair with another oversized
      // pure-read batch (wave split) or another approval-gated batch
      // (trim), fix it mechanically instead of escalating to
      // `GrammarError`. Surfaces in the same event/metric pair.
      const split = policy.trySplitPureReadWaves(parsed.batch);
      if (split !== null) {
        parsed = split;
      } else {
        const trimmed = policy.tryTrimApprovalGated(parsed.batch, validation.error);
        if (trimmed !== null) {
          parsed = trimmed;
        } else {
          parsed = { ok: false, error: validation.error };
        }
      }
    }
  }
  if (!parsed.ok) {
    deps.logger?.warn("tool-call parse failed after retry", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      rawLength: completion.content.length,
      rawPreview: logTextPreview(completion.content),
    });
    // Last resort: the model talked instead of emitting a call (small
    // models routinely answer "hi" in plain prose even under the
    // grammar). Wrap that prose as a `reply` so the turn closes with
    // the model's text — same degradation the `native_tools` path
    // already applies — instead of failing the whole loop. Only
    // reasoning came back? Then there is no answer to deliver and the
    // `GrammarError` still stands.
    const fallback = replyFallbackBatch(
      completion,
      deps.profile,
      assumesOpenReasoning(completion),
    );
    if (fallback === null) {
      throw new GrammarError(
        parsed.error.message,
        rawPreview(completion.content),
        { cause: parsed.error },
      );
    }
    deps.logger?.warn("degrading unparseable completion to a reply", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      reason: parsed.error.message,
    });
    parsed = { ok: true, batch: fallback };
  }
  return parsed;
}

/**
 * A completion the server produced WITHOUT the grammar (ATO-1675) may
 * carry a call in a shape our grammar never writes: llama.cpp's generic
 * `{"tool_calls": [...]}` envelope or OpenAI `function` entries. Read
 * those on such a completion only, after our own shape failed, so the
 * grammar path and the native-tools salvage keep reading what they did.
 * A batch this finds still passes `admitRepairedJson` like any other.
 */
function readForeignShapes(
  args: Pick<StepBatchParsingArgs, "deps" | "prepared">,
  completion: CompletionResult,
  parsed: ToolCallBatchParseResult,
): ToolCallBatchParseResult {
  if (parsed.ok || completion.grammarSkipped !== true) return parsed;
  const { profile } = args.deps;
  try {
    const batch = parseToolCalls(
      normalizeContent(
        completion,
        profile,
        completionAssumesOpenReasoning(profile, "grammar", args.prepared.thinkingOff),
      ),
      getReasoningTagOptions(profile),
      { repairJson: true, foreignShapes: true },
    );
    return { ok: true, batch };
  } catch {
    return parsed;
  }
}

/**
 * A call-looking JSON value somewhere in a reply body: an object with a
 * key only a call is named with (`tool`, `action`, `function`,
 * `tool_calls`), or with both `name` and an argument key (`arguments`,
 * `args`, `parameters`) in any order, keys quoted with either quote. It
 * finds a whole call, a call inside a ```json fence, an OpenAI or
 * llama.cpp-shaped one, one whose call key comes after a long field or a
 * nested object (`{"thought": "...", "tool": ...}`, `{"args": {...},
 * "tool": ...}`), and a call cut off inside an object that opens with
 * `name`. Ordinary prose does not match: a fenced code answer, a `[1]`
 * citation, `{braces}` in a sentence, a quoted `"tool":` outside any
 * object, a JSON example with a bare `name` (a package.json).
 *
 * It is one pass over the text with a stack of open `{`/`[`, reading
 * keys only inside an object, and only the first and last `SCAN_CHARS`
 * of a long text are read, so the cost is linear in the text: it runs
 * on the step's thread, on whatever a model wrote.
 */
const SCAN_CHARS = 16_000;
const CALL_KEYS = new Set(["tool", "action", "function", "tool_calls"]);
const ARG_KEYS = new Set(["arguments", "args", "parameters"]);

/** The parts of `text` worth scanning: all of it when short, else its head and tail. */
function scanWindows(text: string): string[] {
  return text.length <= SCAN_CHARS * 2
    ? [text]
    : [text.slice(0, SCAN_CHARS), text.slice(-SCAN_CHARS)];
}

interface OpenValue {
  object: boolean;
  keys: number;
  name: boolean;
  args: boolean;
  nameFirst: boolean;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Index of the next non-space char at or after `from`, or `text.length`. */
function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text[i]!)) i += 1;
  return i;
}

/** End (exclusive) of the string opening at `start`; a raw newline ends it too. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") i += 2;
    else if (ch === quote) return i + 1;
    else if (ch === "\n") return i;
    else i += 1;
  }
  return text.length;
}

function scanForCall(text: string, endsText: boolean): boolean {
  const stack: OpenValue[] = [];
  let prev = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "{" || ch === "[") {
      stack.push({ object: ch === "{", keys: 0, name: false, args: false, nameFirst: false });
    } else if (ch === "}" || ch === "]") {
      const object = ch === "}";
      while (stack.length > 0 && stack.pop()!.object !== object) {
        // drop values a mismatched closer leaves open
      }
    } else if (
      stack.length > 0 &&
      (ch === '"' || (ch === "'" && (prev === "{" || prev === "," || prev === ":" || prev === "[")))
    ) {
      const end = stringEnd(text, i);
      const top = stack[stack.length - 1]!;
      if (top.object && text[end - 1] === ch && text[skipSpace(text, end)] === ":") {
        const key = text.slice(i + 1, end - 1);
        if (CALL_KEYS.has(key)) return true;
        if (key === "name") {
          top.name = true;
          if (top.keys === 0) top.nameFirst = true;
        }
        if (ARG_KEYS.has(key)) top.args = true;
        if (top.name && top.args) return true;
        top.keys += 1;
      }
      prev = ch;
      i = end;
      continue;
    }
    if (!isSpace(ch)) prev = ch;
    i += 1;
  }
  // Cut off inside an object that opened with `name`; a head window's
  // own cut proves nothing.
  return endsText && stack.some((open) => open.object && open.nameFirst);
}

export function callLike(text: string): boolean {
  if (!text.includes("{")) return false;
  const windows = scanWindows(text);
  return windows.some((part, index) => scanForCall(part, index === windows.length - 1));
}

/**
 * A completion the server produced WITHOUT the grammar (ATO-1675: it
 * refused ours, so the client stopped sending it) is free text, and
 * prose there is the model's answer, not a botched call: read it as a
 * `reply` at once, the way the native-tools path reads content that
 * carries no tool call, instead of spending a repair round-trip that,
 * with no grammar either, rewrites or loses the answer.
 *
 * Not `replyFallbackBatch`: that refuses any body that opens with `{`
 * or `[`, which here is an ordinary answer. The only body refused is
 * one that holds a call-looking value (`callLike`): it may be a call
 * that did not parse, or one `admitRepairedJson` refused, and goes to
 * repair as before instead of showing raw JSON to the user.
 */
function admitProseWithoutGrammar(
  args: Pick<StepBatchParsingArgs, "ctx" | "deps" | "assumesOpenReasoning">,
  completion: CompletionResult,
  parsed: ToolCallBatchParseResult,
): ToolCallBatchParseResult {
  if (parsed.ok || completion.grammarSkipped !== true) return parsed;
  const { profile } = args.deps;
  const assumeOpen = args.assumesOpenReasoning(completion);
  const text = extractReasoning(
    normalizeContent(completion, profile, assumeOpen),
    getReasoningTagOptions(profile),
  ).body.trim();
  if (text.length === 0 || callLike(text)) return parsed;
  const reasoning = resolveReasoning(completion, profile, assumeOpen);
  const fallback: ToolCallBatch = {
    kind: "batch",
    calls: [{ tool: "reply", args: { text }, ...(reasoning.length > 0 ? { reasoning } : {}) }],
    ...(reasoning.length > 0 ? { reasoning } : {}),
  };
  args.deps.logger?.info("reading a reply served without the grammar", {
    sessionId: args.ctx.session.id,
    stepIndex: args.ctx.stepIndex,
  });
  return { ok: true, batch: fallback };
}

/**
 * A batch the parser could only read after a mechanical JSON repair
 * (ATO-637) runs only when `judgeRepairedBatch` vouches for every call;
 * otherwise it is a parse failure like before, with the reason. Either
 * way the log says a repair happened, so its rate can be read off.
 */
function admitRepairedJson(
  args: Pick<StepBatchParsingArgs, "ctx" | "deps">,
  completion: CompletionResult,
  parsed: ToolCallBatchParseResult,
): ToolCallBatchParseResult {
  if (!parsed.ok || parsed.batch.jsonRepair === undefined) return parsed;
  const { ctx, deps } = args;
  const repair = parsed.batch.jsonRepair;
  const fields = {
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    fixes: repair.fixes.join(", "),
    tools: parsed.batch.calls.map((call) => call.tool).join(", "),
  };
  const verdict = judgeRepairedBatch(
    parsed.batch,
    completion,
    deps.registry,
    ctx.toolDescriptors,
  );
  if (!verdict.accept) {
    deps.logger?.info("tool-call JSON repair not used", {
      ...fields,
      reason: verdict.reason,
    });
    return { ok: false, error: repairRefusedError(verdict.reason) };
  }
  deps.logger?.info("tool-call JSON repaired", fields);
  return parsed;
}
