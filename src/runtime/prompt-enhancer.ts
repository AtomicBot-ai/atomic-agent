import { buildCloudSubcallRequest } from "../llm/provider/cloud-subcall.js";
import type {
  CompletionRequest,
  CompletionResult,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import { stripTitleReasoning } from "../session/session-title.js";

/**
 * Partition the enhancer call sits in, like `title:` / `reflection:` /
 * `rewriter:`.
 *
 * The fallback chain keys its breaker state by session id. On the bare
 * id, a provider refusing THIS request would flip the conversation's own
 * sticky override and send its next real step down the chain. Rewriting
 * a draft must not be able to reroute the session it was typed in.
 */
export const PROMPT_ENHANCE_SESSION_PREFIX = "enhance:";

/** Partition suffix when no session exists yet (a fresh composer). */
const PROMPT_ENHANCE_DRAFT_ID = "draft";

/**
 * Deadline for the whole call. The person is waiting on it, so it is
 * short, and it is ours: a bare `fetch` is cut at 300 s by undici's
 * own timers (`transport-deadlines.ts`), which is far longer than a
 * one-pass rewrite should ever be allowed to hold a side-call slot.
 */
export const PROMPT_ENHANCE_TIMEOUT_MS = 60_000;

/**
 * Output bound. A rewrite is a little longer than the draft; anything
 * far beyond this is a reasoning model talking to itself, and it pays
 * for those tokens either way. Set here rather than inherited: the main
 * completion path sends no `max_tokens` at all.
 */
export const PROMPT_ENHANCE_MAX_TOKENS = 4096;

/**
 * Longest draft the enhancer accepts. Clipping is not an option here
 * the way it is for the session namer: a rewrite of half a prompt would
 * silently drop the other half of what the person wrote.
 */
export const PROMPT_ENHANCE_MAX_INPUT_CHARS = 8000;

/** System message of the templated request. */
export const PROMPT_ENHANCE_SYSTEM =
  "You rewrite requests into clear prompts for an AI agent. Answer with the rewritten prompt alone.";

/** Cache key of the rendered prefix; the system message is a constant. */
const PROMPT_ENHANCE_PREFIX_KEY = "prompt-enhance";

export const PROMPT_ENHANCE_EMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "The rewritten prompt, ready to send.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
};

export function buildPromptEnhancePrompt(draft: string): string {
  return [
    "Rewrite the request below into a clearer prompt for an AI agent.",
    "",
    "Keep the intent, facts, names, paths, code and constraints exactly as given.",
    "Do not add requirements that were not asked for, and do not answer or carry out the request.",
    "Make the goal, the relevant context and what a finished result looks like explicit where the request already implies them.",
    "Stay short: a one-line request becomes a few lines at most.",
    "Write it in the language the request is written in.",
    "Answer with the rewritten prompt alone: no preamble, no quotes, no explanation.",
    "",
    "The request:",
    draft,
  ].join("\n");
}

/** A rewrite as it came back, and whether it came from the tool arguments. */
export interface ExtractedRewrite {
  readonly text: string;
  readonly fromTool: boolean;
}

/**
 * The rewrite out of a completion, whichever shape it came back in: the
 * synthetic tool's arguments on `native_tools`, `content` for a thinking
 * model that answered in prose or a fallover to a grammar link. An empty
 * `prompt` argument falls back to `content` too.
 */
export function extractEnhancedPromptText(
  completion: Pick<CompletionResult, "content" | "toolCalls">,
): ExtractedRewrite {
  const args = completion.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.length > 0) {
    try {
      const parsed = JSON.parse(args) as { prompt?: unknown };
      if (typeof parsed.prompt === "string" && parsed.prompt.trim().length > 0) {
        return { text: parsed.prompt, fromTool: true };
      }
    } catch {
      // Fall through to the prose answer.
    }
  }
  return { text: completion.content ?? "", fromTool: false };
}

/** Markup that `stripTitleReasoning` treats as reasoning or control tokens. */
const REASONING_MARKUP =
  /<\/?(?:think|thinking|reasoning)>|<\|channel>|<channel\|>|<\|[a-z_]+\|>/i;
const REASONING_PREAMBLE =
  /^(?:here(?:'s| is) (?:a|my) )?(?:thinking|thought|reasoning) process\s*:/i;
const PROMPT_LABEL =
  /^[*_#\s]*(?:improved|rewritten|enhanced|refined)?\s*prompt\s*:\s*[*_]*\s*/i;
const WHOLE_FENCE = /^```[^\n]*\n([\s\S]*?)\n```$/u;

function carriesReasoningMarkup(text: string): boolean {
  return (
    REASONING_MARKUP.test(text) ||
    REASONING_PREAMBLE.test(text.replace(/^[\s*#_`]+/, ""))
  );
}

/**
 * The rewrite without the wrapping a model reaches for: its reasoning,
 * an `Improved prompt:` label, a code fence or quotes around the whole
 * answer. `null` when nothing is left.
 *
 * Each strip yields to the person's own text. Reasoning is only taken
 * out of a prose answer, never out of the tool arguments (those ARE the
 * answer), and not at all when the draft itself carries the same markup
 * (a prompt about `<think>` tags keeps them). A label, a fence or quotes
 * the draft itself opens with are kept for the same reason.
 */
export function sanitizeEnhancedPrompt(
  raw: string,
  options: { draft: string; fromTool?: boolean },
): string | null {
  const draft = options.draft.trim();
  let text = raw.trim();
  if (options.fromTool !== true && !carriesReasoningMarkup(draft)) {
    text = stripTitleReasoning(text).trim();
  }
  if (!PROMPT_LABEL.test(draft)) text = text.replace(PROMPT_LABEL, "");
  const fenced = WHOLE_FENCE.exec(text);
  const inner = fenced?.[1];
  // One fence around the whole answer, not two separate blocks that
  // happen to open and close it.
  if (inner !== undefined && !inner.includes("```") && !draft.startsWith("```")) {
    text = inner;
  }
  text = text.trim();
  if (!isWhollyQuoted(draft)) {
    const unquoted = unquoteWhole(text);
    if (unquoted !== null) text = unquoted;
  }
  return text.length > 0 ? text : null;
}

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "«": "»",
  "“": "”",
};

/** The inside of a quote around the whole text, or `null`. */
function unquoteWhole(text: string): string | null {
  const close = QUOTE_PAIRS[text[0] ?? ""];
  if (close === undefined || text.length < 2 || !text.endsWith(close)) return null;
  const inner = text.slice(1, -1);
  // Only a quote around the whole answer: `"a" and "b"` keeps both.
  return inner.includes(close) ? null : inner.trim();
}

function isWhollyQuoted(text: string): boolean {
  return unquoteWhole(text) !== null;
}

/**
 * A rewrite this much shorter than the draft has lost part of it (a cut
 * reply, or a strip that ate the person's text), so it is refused rather
 * than handed back. The instructions forbid dropping facts, so a real
 * rewrite does not halve a draft.
 */
export const PROMPT_ENHANCE_MIN_LENGTH_RATIO = 0.5;

export type PromptEnhanceResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

export interface PromptEnhanceDeps {
  complete: (
    params: CompletionRequest & {
      grammar: string;
      slotId: number;
      sessionId: string;
      signal: AbortSignal;
    },
  ) => Promise<Pick<CompletionResult, "content" | "toolCalls">>;
  slotId: () => number;
  /**
   * Wire shape of the link that will serve this call. On `native_tools`
   * a bare prompt with no tools comes back with an empty `content`, so a
   * cloud link is asked through `buildCloudSubcallRequest` like every
   * other sub-call.
   */
  toolTransport?: ToolCallTransport;
  /** `false` when `localModels.useServerTemplate` is `"off"`. */
  serverTemplate?: boolean;
  /** The conversation the draft was typed in, for the partition key. */
  sessionId?: string;
  /** The caller's own cancel; the deadline below applies regardless. */
  signal?: AbortSignal;
  /**
   * Where the call's own controller is held while it runs, so runtime
   * shutdown can abort it (`pendingPromptEnhances`, beside naming's).
   */
  pending?: Set<AbortController>;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * One refinement pass over a draft. Never throws and never retries: the
 * caller keeps the original text on any failure, so the worst outcome
 * is the draft the person already had.
 */
export async function enhancePrompt(
  draft: string,
  deps: PromptEnhanceDeps,
): Promise<PromptEnhanceResult> {
  const text = draft.trim();
  if (text.length === 0) return { ok: false, reason: "nothing to enhance" };
  if (text.length > PROMPT_ENHANCE_MAX_INPUT_CHARS) {
    return {
      ok: false,
      reason: `too long to enhance (over ${PROMPT_ENHANCE_MAX_INPUT_CHARS} characters)`,
    };
  }
  if (deps.signal?.aborted) return { ok: false, reason: "cancelled" };
  const abort = new AbortController();
  deps.pending?.add(abort);
  const onCallerAbort = (): void => abort.abort();
  deps.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, deps.timeoutMs ?? PROMPT_ENHANCE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const result = await deps.complete(buildEnhanceRequest(text, deps, abort.signal));
    const extracted = extractEnhancedPromptText(result);
    const rewritten = sanitizeEnhancedPrompt(extracted.text, {
      draft: text,
      fromTool: extracted.fromTool,
    });
    if (rewritten === null) {
      deps.onError?.(new Error("the model returned no usable rewrite"));
      return { ok: false, reason: "the model returned no usable rewrite" };
    }
    if (rewritten.length < text.length * PROMPT_ENHANCE_MIN_LENGTH_RATIO) {
      deps.onError?.(new Error("the rewrite came back much shorter than the draft"));
      return { ok: false, reason: "the rewrite came back much shorter than the draft" };
    }
    return { ok: true, text: rewritten };
  } catch (err) {
    deps.onError?.(err);
    if (abort.signal.aborted) {
      return { ok: false, reason: timedOut ? "timed out" : "cancelled" };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
    deps.pending?.delete(abort);
  }
}

function buildEnhanceRequest(
  text: string,
  deps: PromptEnhanceDeps,
  signal: AbortSignal,
): Parameters<PromptEnhanceDeps["complete"]>[0] {
  const sessionId = promptEnhancePartition(deps.sessionId);
  const prompt = buildPromptEnhancePrompt(text);
  if (deps.toolTransport === "native_tools") {
    return {
      ...buildCloudSubcallRequest({
        prompt,
        emitFunctionName: "emit_enhanced_prompt",
        argsSchema: PROMPT_ENHANCE_EMIT_SCHEMA,
        description: "Emit the rewritten prompt",
        sessionId,
        maxTokens: PROMPT_ENHANCE_MAX_TOKENS,
      }),
      sessionId,
      grammar: "",
      // No slot affinity on a cloud link; the prompt is used once.
      slotId: -1,
      signal,
    };
  }
  return {
    prompt,
    sessionId,
    grammar: "",
    slotId: deps.slotId(),
    maxTokens: PROMPT_ENHANCE_MAX_TOKENS,
    signal,
    // Thinking off through the model's own template, as the session
    // namer does: on raw text a thinking model opens a `<think>` block
    // and the reasoning becomes the answer.
    ...(deps.serverTemplate === false
      ? {}
      : {
          chat: {
            system: PROMPT_ENHANCE_SYSTEM,
            user: prompt,
            prefixHash: PROMPT_ENHANCE_PREFIX_KEY,
            enableThinking: false,
          },
        }),
  };
}

/** Partition key the enhancer uses for a session (or a fresh composer). */
export function promptEnhancePartition(sessionId: string | undefined): string {
  return `${PROMPT_ENHANCE_SESSION_PREFIX}${sessionId ?? PROMPT_ENHANCE_DRAFT_ID}`;
}
