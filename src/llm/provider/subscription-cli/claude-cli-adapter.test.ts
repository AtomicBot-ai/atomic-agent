import { describe, expect, it } from "vitest";

import { claudeCliAdapter } from "./claude-cli-adapter.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
} from "./subscription-cli-errors.js";

const input = {
  model: "sonnet",
  systemPrompt: "SYSTEM",
  extraArgs: [] as readonly string[],
};

/** Captured verbatim from `claude -p --output-format json` v2.1.220. */
const REAL_ENVELOPE = JSON.stringify({
  is_error: false,
  duration_api_ms: 4630,
  num_turns: 1,
  stop_reason: "end_turn",
  session_id: "32c150e6-44a2-422d-a03d-76b18b607b71",
  total_cost_usd: 0.0363007,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 5777,
    cache_read_input_tokens: 3289,
    output_tokens: 4,
  },
  modelUsage: {
    "claude-sonnet-5": { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  },
  permission_denials: [],
  subtype: "success",
  api_error_status: null,
  result: "OK",
  type: "result",
});

describe("claudeCliAdapter argv", () => {
  it("passes the headless, tool-free, stateless flag set", () => {
    const args = claudeCliAdapter.completeArgs(input);
    expect(args).toContain("--print");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "sonnet",
    ]);
    expect(
      args.slice(
        args.indexOf("--output-format"),
        args.indexOf("--output-format") + 2,
      ),
    ).toEqual(["--output-format", "json"]);
    expect(
      args.slice(
        args.indexOf("--system-prompt"),
        args.indexOf("--system-prompt") + 2,
      ),
    ).toEqual(["--system-prompt", "SYSTEM"]);
  });

  it("never passes flags that would defeat subscription auth or the approval ladder", () => {
    for (const build of [
      claudeCliAdapter.completeArgs,
      claudeCliAdapter.streamArgs,
    ]) {
      const args = build({ ...input, responseSchema: { type: "object" } });
      // --bare makes the CLI read ANTHROPIC_API_KEY only, never OAuth.
      expect(args).not.toContain("--bare");
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--allow-dangerously-skip-permissions");
      expect(args).not.toContain("--add-dir");
      expect(args).not.toContain("--permission-mode");
    }
  });

  it("never places the prompt on argv", () => {
    // Regression guard for E2BIG: a two-zone prompt exceeds the 128 KiB
    // single-argument limit, so it must travel on stdin.
    const prompt = "P".repeat(200_000);
    const args = claudeCliAdapter.completeArgs(input);
    expect(args.some((arg) => arg.includes(prompt))).toBe(false);
    expect(args.join(" ").length).toBeLessThan(4096);
  });

  it("adds --verbose only on the streaming path", () => {
    expect(claudeCliAdapter.completeArgs(input)).not.toContain("--verbose");
    const streamArgs = claudeCliAdapter.streamArgs(input);
    // Verified: `--print` + `--output-format stream-json` errors without it.
    expect(streamArgs).toContain("--verbose");
    expect(streamArgs).toContain("--include-partial-messages");
    expect(
      streamArgs.slice(
        streamArgs.indexOf("--output-format"),
        streamArgs.indexOf("--output-format") + 2,
      ),
    ).toEqual(["--output-format", "stream-json"]);
  });

  it("passes --json-schema only when a schema is set and small enough", () => {
    expect(claudeCliAdapter.completeArgs(input)).not.toContain("--json-schema");

    const schema = { type: "object", properties: { name: { type: "string" } } };
    const withSchema = claudeCliAdapter.completeArgs({
      ...input,
      responseSchema: schema,
    });
    expect(
      withSchema[withSchema.indexOf("--json-schema") + 1],
    ).toBe(JSON.stringify(schema));

    const huge = { type: "object", description: "x".repeat(40_000) };
    expect(
      claudeCliAdapter.completeArgs({ ...input, responseSchema: huge }),
    ).not.toContain("--json-schema");
  });

  it("appends extraArgs verbatim, last", () => {
    const args = claudeCliAdapter.completeArgs({
      ...input,
      extraArgs: ["--effort", "high"],
      maxBudgetUsd: 5,
    });
    expect(args.slice(-2)).toEqual(["--effort", "high"]);
    expect(args).toContain("--max-budget-usd");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("5");
  });

  it("health uses --version, not a real turn", () => {
    expect(claudeCliAdapter.healthArgs()).toEqual(["--version"]);
  });
});

describe("claudeCliAdapter parseResult", () => {
  it("maps the real success envelope", () => {
    const result = claudeCliAdapter.parseResult(REAL_ENVELOPE, "sonnet");
    expect(result.content).toBe("OK");
    expect(result.finishReason).toBe("stop");
    expect(result.truncated).toBe(false);
    expect(result.stop).toBe(true);
    expect(result.slotId).toBe(-1);
    expect(result.modelId).toBe("claude-sonnet-5");
    expect(result.cacheHitTokens).toBe(3289);
    // prompt tokens = fresh + cache-write + cache-read, matching the
    // OpenAI `prompt_tokens` semantics the usage meter expects.
    expect(result.usage).toEqual({
      promptTokens: 2 + 5777 + 3289,
      completionTokens: 4,
      totalTokens: 2 + 5777 + 3289 + 4,
    });
    expect(result.timing.predictedMs).toBe(4630);
  });

  it("treats a tool_use stop as a normal stop", () => {
    // --json-schema is implemented as a forced tool call, so a perfectly
    // successful structured completion reports stop_reason tool_use.
    const result = claudeCliAdapter.parseResult(
      JSON.stringify({
        subtype: "success",
        is_error: false,
        result: '{"name":"Ada"}',
        stop_reason: "tool_use",
      }),
      "sonnet",
    );
    expect(result.finishReason).toBe("stop");
    expect(result.content).toBe('{"name":"Ada"}');
  });

  it("reports truncation on max_tokens", () => {
    const result = claudeCliAdapter.parseResult(
      JSON.stringify({
        subtype: "success",
        is_error: false,
        result: "half",
        stop_reason: "max_tokens",
      }),
      "sonnet",
    );
    expect(result.truncated).toBe(true);
    expect(result.stop).toBe(false);
    expect(result.finishReason).toBe("length");
  });

  it("ignores the internal helper model in modelUsage", () => {
    // Observed live: a `sonnet` turn also bills a haiku helper turn for
    // Claude Code's own post-turn summary. Reporting haiku as the model
    // that served the completion would corrupt cost and model analytics.
    const result = claudeCliAdapter.parseResult(
      JSON.stringify({
        subtype: "success",
        result: "hi",
        modelUsage: {
          "claude-haiku-4-5-20251001": { outputTokens: 13 },
          "claude-sonnet-5": { outputTokens: 4 },
        },
      }),
      "sonnet",
    );
    expect(result.modelId).toBe("claude-sonnet-5");
  });

  it("keeps the requested model when only a helper model was billed", () => {
    const result = claudeCliAdapter.parseResult(
      JSON.stringify({
        subtype: "success",
        result: "hi",
        modelUsage: { "claude-haiku-4-5-20251001": { outputTokens: 13 } },
      }),
      "sonnet",
    );
    expect(result.modelId).toBe("sonnet");
  });

  it("falls back to the configured model when modelUsage is absent", () => {
    const result = claudeCliAdapter.parseResult(
      JSON.stringify({ subtype: "success", result: "hi" }),
      "opus",
    );
    expect(result.modelId).toBe("opus");
  });

  it("throws on an error envelope and keeps the message", () => {
    expect(() =>
      claudeCliAdapter.parseResult(
        JSON.stringify({
          subtype: "error_during_execution",
          is_error: true,
          result: "5-hour limit reached; resets at 14:00",
        }),
        "sonnet",
      ),
    ).toThrow(/5-hour limit reached/);
  });

  it("maps a 401 to an auth error", () => {
    expect(() =>
      claudeCliAdapter.parseResult(
        JSON.stringify({ subtype: "success", api_error_status: 401 }),
        "sonnet",
      ),
    ).toThrow(SubscriptionCliAuthError);
  });

  it("throws rather than silently returning empty on non-JSON output", () => {
    expect(() => claudeCliAdapter.parseResult("not json", "sonnet")).toThrow(
      SubscriptionCliInvocationError,
    );
  });
});

describe("claudeCliAdapter parseStreamEvent", () => {
  it("extracts text deltas", () => {
    expect(
      claudeCliAdapter.parseStreamEvent(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "1\n2" },
          },
        }),
      ),
    ).toEqual({ kind: "delta", text: "1\n2" });
  });

  it("marks the terminal result envelope", () => {
    const line = JSON.stringify({ type: "result", subtype: "success" });
    expect(claudeCliAdapter.parseStreamEvent(line)).toEqual({
      kind: "final",
      raw: line,
    });
  });

  it("surfaces a throttled rate-limit event as a notice, ignores allowed", () => {
    expect(
      claudeCliAdapter.parseStreamEvent(
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
        }),
      ),
    ).toEqual({ kind: "ignore" });
    expect(
      claudeCliAdapter.parseStreamEvent(
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        }),
      ),
    ).toEqual({ kind: "notice", message: "claude rate limit rejected (five_hour)" });
  });

  it("ignores unknown, empty and malformed lines instead of failing", () => {
    for (const line of [
      "",
      "   ",
      "{ not json",
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
    ]) {
      expect(claudeCliAdapter.parseStreamEvent(line)).toEqual({ kind: "ignore" });
    }
  });
});
