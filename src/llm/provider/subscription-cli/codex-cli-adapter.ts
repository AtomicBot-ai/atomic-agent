import type { CompletionResult } from "../completion-types.js";
import type {
  CliAdapterDescriptor,
  CliArgsInput,
  CliStreamEvent,
} from "./cli-adapter-descriptor.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
  looksLikeAuthFailure,
} from "./subscription-cli-errors.js";

/**
 * Codex has no `--system-prompt`, so the steering has to ride inside the
 * prompt. Kept short and prepended once, ahead of the two-zone prompt
 * atomic-agent already built.
 */
export const CODEX_CLI_SYSTEM_PROMPT =
  "You are being used as a text completion engine, not as an agent. " +
  "Do NOT act on the request below and do NOT use any of your own tools: " +
  "no shell, no file reads or writes, no search. Your own working " +
  "directory is unrelated to the request and inspecting it is always " +
  "wrong. The message below is a complete prompt that defines its own " +
  "output protocol — usually a JSON array of tool calls to be executed " +
  "by a different program. Your entire job is to produce the next " +
  "message in that protocol, exactly as the prompt specifies. Emit only " +
  "that, with no preamble, no commentary, and no explanation of what " +
  "you would do. If the prompt asks for a file to be read, you emit the " +
  "tool call that reads it; you never read it yourself.";

function baseArgs(input: CliArgsInput): string[] {
  return [
    "exec",
    "--json",
    // Atomic owns session state and re-sends the whole prompt each step.
    "--ephemeral",
    // The working directory is the state dir, which is not a repository.
    "--skip-git-repo-check",
    // Drops the operator's own config.toml, and with it their MCP
    // servers, from what should be a stateless completion.
    "--ignore-user-config",
    // The closest Codex has to Claude's `--tools ""`. It does not remove
    // the tools, it confines them: a model-generated command cannot
    // write outside the sandbox. See the README for the honest limits.
    "-s",
    "read-only",
    // Verified: under a ChatGPT login Codex rejects every explicit model
    // id ("not supported when using Codex with a ChatGPT account") and
    // resolves one server-side, so the flag is omitted unless the
    // operator deliberately set one.
    ...(input.model ? ["-m", input.model] : []),
    // Unlike Claude's inline --json-schema, Codex reads the schema from
    // a file the provider staged for us.
    ...(input.responseSchemaPath
      ? ["--output-schema", input.responseSchemaPath]
      : []),
    ...input.extraArgs,
    // Trailing `-`: read the prompt from stdin rather than argv.
    "-",
  ];
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexEvent {
  type?: string;
  message?: string;
  item?: { type?: string; text?: string; message?: string };
  usage?: CodexUsage;
  error?: { message?: string };
}

function parseLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }
}

/**
 * Codex exits 0 even when the turn fails — a bad model id, an expired
 * login and a rate limit all produce a clean exit with a `turn.failed`
 * event. The stream is therefore the only reliable success signal, and
 * this parser treats a missing `turn.completed` as a failure rather than
 * returning empty content.
 */
function parseResult(stdout: string, fallbackModel: string): CompletionResult {
  let text = "";
  let usage: CodexUsage | undefined;
  let completed = false;
  let failure: string | null = null;

  for (const line of stdout.split("\n")) {
    const event = parseLine(line);
    if (!event) continue;
    if (event.type === "item.completed" && event.item) {
      if (event.item.type === "agent_message" && event.item.text) {
        text = event.item.text;
      } else if (event.item.type === "error" && event.item.message) {
        // Non-fatal on its own (e.g. "model metadata not found"); only
        // a turn.failed decides the turn.
        failure ??= event.item.message;
      }
    } else if (event.type === "turn.completed") {
      completed = true;
      usage = event.usage;
    } else if (event.type === "turn.failed") {
      failure = event.error?.message ?? failure ?? "turn failed";
      completed = false;
    } else if (event.type === "error" && event.message) {
      failure = event.message;
    }
  }

  if (!completed) {
    const detail = failure ?? "codex produced no turn.completed event";
    if (looksLikeAuthFailure(detail)) {
      throw new SubscriptionCliAuthError(
        "codex",
        "Run `codex login` and sign in with your ChatGPT account, then retry.",
        detail.slice(0, 500),
      );
    }
    throw new SubscriptionCliInvocationError(`codex turn failed: ${detail}`);
  }

  // `cached_input_tokens` is a subset of `input_tokens` here, unlike
  // Claude's disjoint cache counters — so it is reported, not added.
  const promptTokens = usage?.input_tokens ?? 0;
  const completionTokens =
    (usage?.output_tokens ?? 0) + (usage?.reasoning_output_tokens ?? 0);

  return {
    content: text,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens,
      predictedTokens: completionTokens,
    },
    cacheHitTokens: usage?.cached_input_tokens ?? 0,
    slotId: -1,
    modelId: fallbackModel || null,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    finishReason: "stop",
  };
}

export const codexCliAdapter: CliAdapterDescriptor = {
  cli: "codex",
  displayName: "OpenAI Codex subscription",
  defaultBinary: "codex",
  // Empty on purpose: Codex picks the model the account supports.
  defaultChatModel: "",
  staticModels: [],
  // Codex does not publish a context window per model here; this only
  // feeds compaction timing, so a conservative floor is the safe choice.
  contextWindow: 200_000,
  schemaDelivery: "file",
  // No incremental text events were observed on `exec --json` — output
  // arrives in one `item.completed`. Buffering is therefore honest
  // rather than a limitation we could paper over.
  streamMode: "none",
  systemPrompt: CODEX_CLI_SYSTEM_PROMPT,
  installHint:
    "Install the Codex CLI (`npm i -g @openai/codex`) and run `codex login`, or set llm.providers[].subscriptionCli.binPath to the binary's absolute path.",
  authHint:
    "Run `codex login` and sign in with your ChatGPT account, then retry.",
  buildStdin(prompt, systemPrompt) {
    return `${systemPrompt}\n\n${prompt}`;
  },
  completeArgs(input) {
    return baseArgs(input);
  },
  streamArgs(input) {
    // streamMode is "none", so the provider never calls this; keeping it
    // identical means a future streaming opt-in cannot drift.
    return baseArgs(input);
  },
  healthArgs() {
    return ["--version"];
  },
  parseResult,
  parseStreamEvent(): CliStreamEvent {
    return { kind: "ignore" };
  },
};
