import type { CompletionResult } from "../completion-types.js";
import type {
  CliAdapterDescriptor,
  CliArgsInput,
  CliStreamEvent,
} from "./cli-adapter-descriptor.js";
import {
  CLAUDE_CLI_CHAT_MODELS,
  CLAUDE_CLI_CONTEXT_WINDOW,
  CLAUDE_CLI_DEFAULT_CHAT_MODEL,
} from "./claude-cli-models.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
} from "./subscription-cli-errors.js";

/**
 * Replaces Claude Code's own system prompt for the duration of one
 * completion. It has to be a replacement, not an append: the default is
 * a coding-agent prompt that plans, narrates and reaches for tools,
 * which competes with the complete two-zone prompt atomic-agent already
 * built. This is also the only steering channel we have outside that
 * prompt, so it is spent on the output contract.
 */
export const CLAUDE_CLI_SYSTEM_PROMPT =
  "You are an inference backend. The user message is a complete, " +
  "self-contained prompt that carries its own instructions and output " +
  "contract. Follow it exactly and emit only what it asks for — no " +
  "preamble, no commentary, no summary of what you are about to do. " +
  "Do not use tools; the prompt's own protocol is the only one that applies.";

/**
 * Above this the schema would eat into the argv budget for no benefit;
 * the sub-runners that set `responseFormat` all tolerate free-form
 * content, so dropping the flag degrades gracefully.
 */
const MAX_SCHEMA_ARG_BYTES = 32 * 1024;

function baseArgs(input: CliArgsInput): string[] {
  return [
    "--print",
    "--input-format",
    "text",
    "--model",
    input.model,
    "--system-prompt",
    input.systemPrompt,
    // Safety-critical, not an optimisation: Claude Code's built-in
    // Bash/Edit/Write would otherwise run on the user's machine outside
    // atomic-agent's approval ladder.
    "--tools",
    "",
    // No --mcp-config is passed, so this drops the user's MCP servers
    // rather than inheriting them into a stateless completion.
    "--strict-mcp-config",
    // atomic-agent owns session state and re-sends the whole prompt each
    // step; CLI-side history would double-count context and litter the
    // user's session list.
    "--no-session-persistence",
  ];
}

function tailArgs(input: CliArgsInput): string[] {
  const out: string[] = [];
  if (input.responseSchema) {
    const encoded = JSON.stringify(input.responseSchema);
    if (encoded.length <= MAX_SCHEMA_ARG_BYTES) {
      out.push("--json-schema", encoded);
    }
  }
  if (input.maxBudgetUsd !== undefined) {
    out.push("--max-budget-usd", String(input.maxBudgetUsd));
  }
  out.push(...input.extraArgs);
  return out;
}

interface ClaudeResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  api_error_status?: number | null;
  duration_api_ms?: number;
  permission_denials?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

/**
 * `stop_reason` doubles as a structured-output signal: with
 * `--json-schema` the CLI implements the constraint as a forced tool
 * call and reports `tool_use` even though the text in `result` is the
 * whole answer. Treat it as a normal stop — we never surface tool calls
 * from this provider.
 */
function toFinishReason(stopReason: string | null | undefined): string | null {
  if (!stopReason) return null;
  if (stopReason === "end_turn" || stopReason === "tool_use") return "stop";
  if (stopReason === "max_tokens") return "length";
  return stopReason;
}

/**
 * `modelUsage` is keyed by every model the CLI billed for this turn,
 * which includes the small helper model Claude Code uses for its own
 * side tasks (post-turn summaries). Taking the first key would report
 * `claude-haiku-4-5` as the model that served a `sonnet` request, so the
 * requested model stays authoritative and `modelUsage` is used only to
 * expand an alias into the concrete id it resolved to.
 */
function resolveModelId(
  modelUsage: Record<string, unknown> | undefined,
  requested: string,
): string {
  const keys = Object.keys(modelUsage ?? {});
  if (keys.includes(requested)) return requested;
  return keys.find((key) => key.includes(requested)) ?? requested;
}

function parseResult(stdout: string, fallbackModel: string): CompletionResult {
  let envelope: ClaudeResultEnvelope;
  try {
    envelope = JSON.parse(stdout.trim()) as ClaudeResultEnvelope;
  } catch {
    throw new SubscriptionCliInvocationError(
      `claude returned output that is not JSON: ${stdout.slice(0, 500)}`,
    );
  }
  const status = envelope.api_error_status ?? null;
  if (status === 401 || status === 403) {
    throw new SubscriptionCliAuthError(
      "claude",
      "Run `claude` in a terminal and complete /login, then retry.",
      `api_error_status ${status}`,
    );
  }
  if (envelope.is_error || (envelope.subtype && envelope.subtype !== "success")) {
    // The message is the only description of subscription rate limits and
    // usage caps, so it is passed through rather than summarised away.
    throw new SubscriptionCliInvocationError(
      `claude reported ${envelope.subtype ?? "an error"}${
        status ? ` (api status ${status})` : ""
      }: ${envelope.result ?? "no detail"}`,
    );
  }

  const usage = envelope.usage ?? {};
  const promptTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const completionTokens = usage.output_tokens ?? 0;
  const predictedMs = envelope.duration_api_ms ?? 0;
  const modelId = resolveModelId(envelope.modelUsage, fallbackModel);
  const truncated = envelope.stop_reason === "max_tokens";

  return {
    content: envelope.result ?? "",
    reasoningContent: "",
    stop: !truncated,
    truncated,
    timing: {
      promptMs: 0,
      predictedMs,
      promptTokens,
      predictedTokens: completionTokens,
    },
    cacheHitTokens: usage.cache_read_input_tokens ?? 0,
    // No slot affinity: every completion is a fresh process.
    slotId: -1,
    modelId,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    finishReason: toFinishReason(envelope.stop_reason),
  };
}

interface ClaudeStreamLine {
  type?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  rate_limit_info?: { status?: string; rateLimitType?: string };
}

function parseStreamEvent(line: string): CliStreamEvent {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "ignore" };
  let parsed: ClaudeStreamLine;
  try {
    parsed = JSON.parse(trimmed) as ClaudeStreamLine;
  } catch {
    // A partial or unrecognised line is never fatal: the terminal
    // `result` envelope carries the authoritative text either way.
    return { kind: "ignore" };
  }
  if (parsed.type === "result") return { kind: "final", raw: trimmed };
  if (parsed.type === "rate_limit_event") {
    const info = parsed.rate_limit_info ?? {};
    return info.status && info.status !== "allowed"
      ? {
          kind: "notice",
          message: `claude rate limit ${info.status}${
            info.rateLimitType ? ` (${info.rateLimitType})` : ""
          }`,
        }
      : { kind: "ignore" };
  }
  if (parsed.type === "stream_event") {
    const event = parsed.event ?? {};
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      return { kind: "delta", text: event.delta.text };
    }
  }
  return { kind: "ignore" };
}

export const claudeCliAdapter: CliAdapterDescriptor = {
  cli: "claude",
  displayName: "Claude Code subscription",
  defaultBinary: "claude",
  defaultChatModel: CLAUDE_CLI_DEFAULT_CHAT_MODEL,
  systemPrompt: CLAUDE_CLI_SYSTEM_PROMPT,
  staticModels: CLAUDE_CLI_CHAT_MODELS,
  contextWindow: CLAUDE_CLI_CONTEXT_WINDOW,
  supportsJsonSchema: true,
  streamMode: "ndjson",
  installHint:
    "Install Claude Code (https://claude.com/claude-code) and run `claude` once to sign in, or set llm.providers[].subscriptionCli.binPath to the binary's absolute path.",
  authHint: "Run `claude` in a terminal and complete /login, then retry.",
  completeArgs(input) {
    return [...baseArgs(input), "--output-format", "json", ...tailArgs(input)];
  },
  streamArgs(input) {
    return [
      ...baseArgs(input),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      // Verified requirement: `--print` with `--output-format=stream-json`
      // errors out without it.
      "--verbose",
      ...tailArgs(input),
    ];
  },
  healthArgs() {
    // Cheap liveness only. It cannot detect a signed-out CLI — that
    // surfaces on the first completion as SubscriptionCliAuthError —
    // but a real turn would cost seconds and tokens on every poll.
    return ["--version"];
  },
  parseResult,
  parseStreamEvent,
};
