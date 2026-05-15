import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { LlmFailureCategory } from "../llm/reliability/index.js";
import type { BuiltPrompt } from "../prompt/build-prompt.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";

export interface PromptCapturedTokens {
  total: number;
  stablePrefix: number;
  tail: number;
}

/**
 * Observability events emitted by `executeStep` in canonical order:
 *
 *   1. `prompt_built` (then `prompt_captured` for trace sinks)
 *   2. `llm_completed` (then `llm_raw_completion` with `attempt: 1`)
 *   3. Optional `reasoning` / `reasoning_delta` / `assistant_delta`
 *   4. Optional `parse_retry` (followed by another `llm_completed` +
 *      `llm_raw_completion` with `attempt: 2`)
 *   5. `tool_call_parsed` — once per call. For a batched step (N > 1),
 *      N events fire in batch-index order before any execution starts.
 *      `batchIndex`/`batchSize` are present on every event; single
 *      calls report `batchIndex: 0, batchSize: 1`.
 *   6. `tool_call_executed` — once per call. Order matches the order
 *      results land (within a serialised group: batch-index order;
 *      across groups: undefined). The matching `batchIndex` is carried
 *      so consumers can correlate parsed↔executed pairs.
 *   7. Optional `assistant_reply` for the `reply` terminal
 *
 * `step_error` short-circuits the sequence and carries the failure.
 */
export type StepEvent =
  | { type: "prompt_built"; prompt: BuiltPrompt; slotId: number }
  /**
   * Trace-oriented sibling of `prompt_built`: carries the salted hash of
   * the stable prefix (so per-step records stay small) together with the
   * full variable tail, token breakdown, and cache-reuse status needed to
   * replay the prompt later.
   */
  | {
      type: "prompt_captured";
      stepIndex: number;
      stablePrefixHash: string;
      tail: string;
      tokens: PromptCapturedTokens;
      slotId: number;
      cacheReused: boolean;
    }
  | { type: "llm_completed"; completion: CompletionResult }
  /**
   * Full completion payload (content, reasoning, timing) paired with the
   * attempt index (1 for the first call, 2 for the parse-retry) so the
   * trace recorder can distinguish the original inference from the
   * retry-driven one.
   */
  | {
      type: "llm_raw_completion";
      stepIndex: number;
      attempt: 1 | 2;
      completion: CompletionResult;
    }
  /**
   * Non-fatal: reasoning model emitted `<think>...</think>` blocks before
   * the tool-call JSON. Surfaced so UIs can display the model's thought
   * process without polluting the feed. Always arrives *before*
   * `tool_call_parsed` and *before* any `step_error` from the parser.
   */
  | { type: "reasoning"; stepIndex: number; text: string }
  /**
   * Streaming reasoning delta produced live while the model is still
   * generating the `<think>...</think>` prelude. Only emitted when the
   * runtime has a streaming LLM callback wired in — the final `reasoning`
   * event still arrives once the JSON body is parsed. Consumers may either
   * render both (the final event is authoritative) or ignore one.
   */
  | { type: "reasoning_delta"; stepIndex: number; text: string }
  /**
   * Streaming assistant text delta, emitted only for `reply.args.text`.
   * Other tools never produce this event so non-reply arguments (shell
   * commands, URLs, file paths, ...) are not confused with user-facing
   * text.
   */
  | { type: "assistant_delta"; text: string }
  | {
      type: "tool_call_parsed";
      call: ToolCallPayload;
      /**
       * Position of this call inside the parsed batch (0-based). For a
       * single-call step always `0`; for a batched step every parsed
       * event in the same step shares the same `batchSize` and
       * different `batchIndex` values in `[0, batchSize)`.
       */
      batchIndex: number;
      batchSize: number;
    }
  | {
      type: "tool_call_executed";
      result: CompressedToolResult;
      /** Mirrors the corresponding `tool_call_parsed.batchIndex`. */
      batchIndex: number;
      batchSize: number;
    }
  /**
   * Rare-tool execution failed; the runtime injected the full schema into
   * `session.loadedTools` so the next step can retry with valid args.
   */
  | {
      type: "rare_tool_autoloaded";
      tool: string;
      source: "auto";
      stepIndex: number;
    }
  | { type: "assistant_reply"; text: string }
  /**
   * Emitted once when the first `parseToolCall` threw and the executor
   * re-runs the LLM call to recover. Includes the failure reason so
   * postmortems can tell grammar truncation from malformed JSON.
   */
  | { type: "parse_retry"; stepIndex: number; attempt: number; reason: string }
  /**
   * Emitted in place of `parse_retry` when a multi-call batch failed
   * validation purely because it contained approval-gated tools. The
   * runtime auto-splits the batch: the first approval-gated call is
   * executed as a length-1 batch, all other calls are dropped, and a
   * `### notice` is injected into the next step's prompt so the model
   * can retry the dropped calls one-by-one. No LLM round-trip happens
   * for the trim — this avoids the bewildered-repair pathology where
   * qwen models pivot to an irrelevant length-1 tool (e.g.
   * `skill.view`).
   */
  | {
      type: "batch_trimmed";
      stepIndex: number;
      /** Original batch size emitted by the model. Always >= 2. */
      originalSize: number;
      /** Tool name of the call we kept (executed as length-1 batch). */
      kept: string;
      /** Tool names of dropped calls in original batch-index order. */
      dropped: string[];
      /** Canonical trim cause. New reasons may be added over time. */
      reason: "approval-gated-batched";
    }
  /**
   * Terminal error for this step. The `category` follows the canonical
   * LLM failure taxonomy (see `src/llm/reliability/`) and is always set
   * even when the underlying error shape is a legacy `Error` — the step
   * executor classifies unknown errors before emitting.
   */
  | { type: "step_error"; error: Error; category: LlmFailureCategory };
