import { buildCloudSubcallRequest } from "../llm/provider/cloud-subcall.js";
import type {
  CompletionRequest,
  CompletionResult,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import { stripTitleReasoning } from "../session/session-title.js";

/**
 * One plain request to the current model for a client that only wants
 * text back (the desktop Studio's "Improve prompt", `POST /api/complete`).
 *
 * No tools, no turn, no session: nothing is written to the store and
 * nothing appears in the sidebar. It goes through the runtime's own
 * `llmComplete`, so the route is the one a chat step would take (local
 * llama-server / Core, a cloud key, a subscription, the fallback chain)
 * and a client never has to copy that routing.
 */

/**
 * Partition the call sits in, like `title:` / `enhance:`. The fallback
 * chain keys its breaker state by session id; a provider refusing this
 * request must not flip any conversation's own sticky override.
 */
export const PLAIN_COMPLETE_PARTITION = "complete:api";

/** Deadline for the whole call; a person is usually waiting on it. */
export const PLAIN_COMPLETE_TIMEOUT_MS = 60_000;

/** Output bound when the caller names none. */
export const PLAIN_COMPLETE_DEFAULT_MAX_TOKENS = 1024;

/**
 * Highest output bound a caller may ask for. The main completion path
 * sends no `max_tokens` at all; this endpoint always does, so a reasoning
 * model cannot hold a side-call slot for an unbounded answer.
 */
export const PLAIN_COMPLETE_MAX_TOKENS_CAP = 4096;

/** Longest prompt accepted. Refused, not clipped: half a prompt is a different prompt. */
export const PLAIN_COMPLETE_MAX_PROMPT_CHARS = 16_000;

/** Longest system message accepted. */
export const PLAIN_COMPLETE_MAX_SYSTEM_CHARS = 4_000;

/** System message when the caller sends none. */
export const PLAIN_COMPLETE_DEFAULT_SYSTEM =
  "You are a helpful assistant. Answer with the requested text alone.";

/** Cache key prefix of the rendered chat prefix on a llama-server link. */
const PLAIN_COMPLETE_PREFIX_KEY = "plain-complete";

export const PLAIN_COMPLETE_EMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    text: { type: "string", description: "The answer, as plain text." },
  },
  required: ["text"],
  additionalProperties: false,
};

export interface PlainCompleteInput {
  readonly prompt: string;
  readonly system?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export type PlainCompleteResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string; readonly kind: "invalid" | "failed" | "cancelled" | "timeout" };

export interface PlainCompleteDeps {
  complete: (
    params: CompletionRequest & {
      grammar: string;
      slotId: number;
      sessionId: string;
      signal: AbortSignal;
    },
  ) => Promise<Pick<CompletionResult, "content" | "toolCalls">>;
  slotId: () => number;
  /** Wire shape of the link that will serve the call. */
  toolTransport?: ToolCallTransport;
  /** `false` when `localModels.useServerTemplate` is `"off"`. */
  serverTemplate?: boolean;
  /** Where the call's controller is held so runtime shutdown can abort it. */
  pending?: Set<AbortController>;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

/** Validate a request before any model is touched. `null` when it is fine. */
export function validatePlainCompleteInput(input: {
  prompt: unknown;
  system?: unknown;
  maxTokens?: unknown;
}): string | null {
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    return "prompt must be a non-empty string";
  }
  if (input.prompt.length > PLAIN_COMPLETE_MAX_PROMPT_CHARS) {
    return `prompt is too long (over ${PLAIN_COMPLETE_MAX_PROMPT_CHARS} characters)`;
  }
  if (input.system !== undefined) {
    if (typeof input.system !== "string") return "system must be a string";
    if (input.system.length > PLAIN_COMPLETE_MAX_SYSTEM_CHARS) {
      return `system is too long (over ${PLAIN_COMPLETE_MAX_SYSTEM_CHARS} characters)`;
    }
  }
  if (input.maxTokens !== undefined) {
    if (
      typeof input.maxTokens !== "number" ||
      !Number.isInteger(input.maxTokens) ||
      input.maxTokens < 1
    ) {
      return "max_tokens must be a positive integer";
    }
  }
  return null;
}

/** The output bound actually sent: the caller's, clamped to the cap. */
export function plainCompleteMaxTokens(requested: number | undefined): number {
  if (requested === undefined) return PLAIN_COMPLETE_DEFAULT_MAX_TOKENS;
  return Math.min(Math.max(1, Math.floor(requested)), PLAIN_COMPLETE_MAX_TOKENS_CAP);
}

/**
 * The answer out of a completion, whichever shape it came back in: the
 * synthetic tool's `text` argument on a `native_tools` link, otherwise
 * `content` with any reasoning block taken out.
 */
export function extractPlainCompleteText(
  completion: Pick<CompletionResult, "content" | "toolCalls">,
): string {
  const args = completion.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.length > 0) {
    try {
      const parsed = JSON.parse(args) as { text?: unknown };
      if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
        return parsed.text.trim();
      }
    } catch {
      // Fall through to the prose answer.
    }
  }
  return stripTitleReasoning(completion.content ?? "").trim();
}

/** The request handed to `llmComplete`. Exported for tests. */
export function buildPlainCompleteRequest(
  input: PlainCompleteInput,
  deps: Pick<PlainCompleteDeps, "toolTransport" | "serverTemplate" | "slotId">,
  signal: AbortSignal,
): Parameters<PlainCompleteDeps["complete"]>[0] {
  const sessionId = PLAIN_COMPLETE_PARTITION;
  const maxTokens = plainCompleteMaxTokens(input.maxTokens);
  const system = input.system && input.system.trim().length > 0
    ? input.system
    : PLAIN_COMPLETE_DEFAULT_SYSTEM;
  if (deps.toolTransport === "native_tools") {
    // A cloud link answers a bare prompt with no tools with an empty
    // `content`, so it is asked through one synthetic emit function like
    // every other sub-call. The system text rides in the prompt.
    return {
      ...buildCloudSubcallRequest({
        prompt: `${system}\n\n${input.prompt}`,
        emitFunctionName: "emit_answer",
        argsSchema: PLAIN_COMPLETE_EMIT_SCHEMA,
        description: "Emit the answer",
        sessionId,
        maxTokens,
      }),
      sessionId,
      grammar: "",
      slotId: -1,
      signal,
    };
  }
  return {
    prompt: `${system}\n\n${input.prompt}`,
    sessionId,
    grammar: "",
    slotId: deps.slotId(),
    maxTokens,
    signal,
    // Thinking off through the model's own template, as the session
    // namer and `/enhance` do: on raw text a thinking model opens a
    // `<think>` block and the reasoning becomes the answer.
    ...(deps.serverTemplate === false
      ? {}
      : {
          chat: {
            system,
            user: input.prompt,
            prefixHash: `${PLAIN_COMPLETE_PREFIX_KEY}:${hashText(system)}`,
            enableThinking: false,
          },
        }),
  };
}

/**
 * One pass, never throws, never retries. A bad request is refused before
 * the model is touched; a failed or empty answer comes back as a reason.
 */
export async function completePlain(
  input: PlainCompleteInput,
  deps: PlainCompleteDeps,
): Promise<PlainCompleteResult> {
  const invalid = validatePlainCompleteInput(input);
  if (invalid !== null) return { ok: false, reason: invalid, kind: "invalid" };
  if (input.signal?.aborted) return { ok: false, reason: "cancelled", kind: "cancelled" };
  const abort = new AbortController();
  deps.pending?.add(abort);
  const onCallerAbort = (): void => abort.abort();
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, deps.timeoutMs ?? PLAIN_COMPLETE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const result = await deps.complete(buildPlainCompleteRequest(input, deps, abort.signal));
    const text = extractPlainCompleteText(result);
    if (text.length === 0) {
      deps.onError?.(new Error("the model returned an empty answer"));
      return { ok: false, reason: "the model returned an empty answer", kind: "failed" };
    }
    return { ok: true, text };
  } catch (err) {
    deps.onError?.(err);
    if (abort.signal.aborted) {
      return timedOut
        ? { ok: false, reason: "timed out", kind: "timeout" }
        : { ok: false, reason: "cancelled", kind: "cancelled" };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err), kind: "failed" };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
    deps.pending?.delete(abort);
  }
}

/** Short, stable, non-cryptographic hash (FNV-1a) for the prefix cache key. */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
