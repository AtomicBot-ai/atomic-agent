import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../../config/index.js";
import { getConfig } from "../../../config/index.js";
import { VisionUnsupportedError } from "../llm-provider.js";
import {
  getProviderFactory,
  type LlmProviderConfigEntry,
} from "../registry/provider-types.js";
import { registerBuiltInProviderKinds } from "../registry/register-built-in-providers.js";
import { claudeCliAdapter } from "./claude-cli-adapter.js";
import type { CliRunOptions, CliRunOutcome } from "./run-cli-completion.js";
import { SubscriptionCliProvider } from "./subscription-cli-provider.js";
import { SubscriptionCliNotInstalledError } from "./subscription-cli-errors.js";

const SUCCESS = JSON.stringify({
  subtype: "success",
  is_error: false,
  result: "hello",
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 3 },
});

function stubRunner(stdout: string, calls: CliRunOptions[] = []) {
  return async (options: CliRunOptions): Promise<CliRunOutcome> => {
    calls.push(options);
    return { stdout, stderr: "", exitCode: 0, durationMs: 1 };
  };
}

function makeProvider(overrides: Partial<Parameters<typeof buildOptions>[0]> = {}) {
  return new SubscriptionCliProvider(buildOptions(overrides));
}

function buildOptions(overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-cli",
    descriptor: claudeCliAdapter,
    cwd: "/tmp",
    runCliImpl: stubRunner(SUCCESS),
    ...overrides,
  } as ConstructorParameters<typeof SubscriptionCliProvider>[0];
}

describe("SubscriptionCliProvider capabilities", () => {
  it("declares the native transport with no vision and no slot affinity", () => {
    const provider = makeProvider();
    // native_tools, despite never returning tool_calls: it routes
    // step-executor down its guarded recovery ladder instead of the
    // repair path, which would cost a second CLI invocation.
    expect(provider.capabilities.toolTransport).toBe("native_tools");
    expect(provider.toolCallAdapter).not.toBeNull();
    expect(provider.streamConsumer).toBeNull();
    expect(provider.capabilities.vision).toBe(false);
    expect(provider.capabilities.supportsSlotAffinity).toBe(false);
    expect(provider.capabilities.supportsPromptCache).toBe(true);
    expect(provider.capabilities.contextWindow).toBeGreaterThan(0);
  });

  it("rejects vision instead of pretending", async () => {
    await expect(
      makeProvider().describeImage({ prompt: "x", images: [] }),
    ).rejects.toBeInstanceOf(VisionUnsupportedError);
  });

  it("lists models without spawning anything", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    expect(await provider.listModels()).toContain("sonnet");
    expect(calls).toHaveLength(0);
  });

  it("closes without error", async () => {
    await expect(makeProvider().close()).resolves.toBeUndefined();
  });
});

describe("SubscriptionCliProvider.complete", () => {
  it("sends the prompt on stdin and never on argv", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    const prompt = "P".repeat(200_000);
    const result = await provider.complete({ prompt });

    expect(result.content).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(prompt);
    expect(calls[0]?.args.some((arg) => arg.includes("PPPP"))).toBe(false);
  });

  it("uses the configured model and appends extraArgs", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({
      model: "opus",
      extraArgs: ["--effort", "high"],
      runCliImpl: stubRunner(SUCCESS, calls),
    });
    await provider.complete({ prompt: "x" });
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args.slice(-2)).toEqual(["--effort", "high"]);
  });

  it("forwards the abort signal to the child", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    const controller = new AbortController();
    await provider.complete({ prompt: "x", signal: controller.signal });
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("passes responseFormat through as --json-schema", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    await provider.complete({
      prompt: "x",
      responseFormat: { name: "vote", schema: { type: "object" } },
    });
    expect(calls[0]?.args).toContain("--json-schema");
  });
});

describe("SubscriptionCliProvider.completeStream", () => {
  it("falls back to one buffered chunk when streaming is disabled", async () => {
    const provider = makeProvider({ streaming: false });
    const deltas: string[] = [];
    const iterator = provider.completeStream({ prompt: "x" });
    let next = await iterator.next();
    while (!next.done) {
      if (next.value.delta) deltas.push(next.value.delta);
      next = await iterator.next();
    }
    expect(deltas).toEqual(["hello"]);
    expect(next.value.content).toBe("hello");
  });

  it("streams deltas and returns the parsed final envelope", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "he" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "llo" },
        },
      }),
      SUCCESS.replace('"subtype"', '"type":"result","subtype"'),
    ];
    const provider = makeProvider({
      streamCliImpl: async function* () {
        for (const line of lines) yield line;
      },
    });
    const deltas: string[] = [];
    const iterator = provider.completeStream({ prompt: "x" });
    let next = await iterator.next();
    while (!next.done) {
      if (next.value.delta) deltas.push(next.value.delta);
      next = await iterator.next();
    }
    expect(deltas).toEqual(["he", "llo"]);
    expect(next.value.content).toBe("hello");
  });

  it("emits the final text once when no delta was recognised", async () => {
    // Safety net for a stream schema we do not control: a mismatch must
    // degrade to buffered behaviour, never to an empty turn.
    const provider = makeProvider({
      streamCliImpl: async function* () {
        yield JSON.stringify({ type: "stream_event", event: { type: "unknown" } });
        yield SUCCESS.replace('"subtype"', '"type":"result","subtype"');
      },
    });
    const deltas: string[] = [];
    const iterator = provider.completeStream({ prompt: "x" });
    let next = await iterator.next();
    while (!next.done) {
      if (next.value.delta) deltas.push(next.value.delta);
      next = await iterator.next();
    }
    expect(deltas).toEqual(["hello"]);
  });

  it("fails loudly when the stream ends with no result envelope", async () => {
    const provider = makeProvider({
      streamCliImpl: async function* () {
        yield JSON.stringify({ type: "system" });
      },
    });
    const iterator = provider.completeStream({ prompt: "x" });
    await expect(
      (async () => {
        let next = await iterator.next();
        while (!next.done) next = await iterator.next();
      })(),
    ).rejects.toThrow(/without a result envelope/);
  });

  it("routes rate-limit notices to onNotice instead of failing", async () => {
    const notices: string[] = [];
    const provider = makeProvider({
      onNotice: (message: string) => notices.push(message),
      streamCliImpl: async function* () {
        yield JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        });
        yield SUCCESS.replace('"subtype"', '"type":"result","subtype"');
      },
    });
    const iterator = provider.completeStream({ prompt: "x" });
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    expect(notices).toEqual(["claude rate limit rejected (five_hour)"]);
  });
});

describe("SubscriptionCliProvider.health", () => {
  it("is reachable when the version probe exits cleanly", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({
      runCliImpl: stubRunner("2.1.220 (Claude Code)", calls),
    });
    const health = await provider.health();
    expect(health.reachable).toBe(true);
    expect(calls[0]?.args).toEqual(["--version"]);
    // A health probe must never send a prompt or cost tokens.
    expect(calls[0]?.input).toBeUndefined();
  });

  it("reports an actionable message when the binary is missing", async () => {
    const provider = makeProvider({
      runCliImpl: async () => {
        throw new SubscriptionCliNotInstalledError("claude", "Install it.");
      },
    });
    const health = await provider.health();
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(/not found on PATH/);
  });
});

describe("registry factory", () => {
  it("builds the provider from a subscription-cli entry", async () => {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory("subscription-cli");
    expect(factory).toBeDefined();
    const entry: LlmProviderConfigEntry = {
      id: "claude-cli",
      kind: "subscription-cli",
      defaultChatModel: "opus",
      subscriptionCli: { cli: "claude" },
    };
    const provider = await factory!({
      config: getConfig() as AtomicAgentConfig,
      entry,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    });
    expect(provider).toBeInstanceOf(SubscriptionCliProvider);
    expect(provider.id).toBe("claude-cli");
  });

  it("refuses an entry with no subscriptionCli block", () => {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory("subscription-cli")!;
    // Config parsing rejects this first; the factory guard is the
    // backstop for an entry built in code rather than loaded from disk.
    expect(() =>
      factory({
        config: getConfig() as AtomicAgentConfig,
        entry: { id: "claude-cli", kind: "subscription-cli" },
        logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      }),
    ).toThrow(/requires a subscriptionCli block/);
  });
});
