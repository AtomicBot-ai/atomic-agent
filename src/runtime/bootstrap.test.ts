import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, managedLocalLlmHealthFailureHint } from "./bootstrap.js";
import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import type {
  BotFactory,
  BotInstance,
} from "../channels/telegram/index.js";
import type {
  ApprovalGate,
  ApprovalRequest,
} from "../approval/approval-gate.js";
import type { ChannelStatus } from "./channel-status.js";
import { GEMMA4_PROPS } from "../llm/model-profile.fixtures.js";
import type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
  ScrollInput,
  ScrollResult,
  SearchInput,
  TabInfo,
  TabsInput,
  TypeInput,
} from "../tools/browser/browser-backend.js";
import type { LogRecord } from "../tracing/structured-logger.js";

class FakeBackend implements BrowserBackend {
  public shutdowns = 0;
  async ensureReady(): Promise<void> {}
  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
  async snapshot(): Promise<AriaSnapshot> {
    return {
      url: "https://example.com/",
      title: "Example",
      digest: "deadbeef",
      refs: [],
      text: "url: https://example.com/\ntitle: Example\n",
    };
  }
  async navigate(input: NavigateInput): Promise<{ url: string; title: string }> {
    return { url: input.url, title: "Example" };
  }
  async click(input: ClickInput): Promise<{ clickedRef: string }> {
    return { clickedRef: input.ref };
  }
  async type(input: TypeInput): Promise<{ typedLength: number }> {
    return { typedLength: input.text.length };
  }
  async search(input: SearchInput): Promise<{ url: string }> {
    return { url: `https://search.example/?q=${input.query}` };
  }
  async tabs(_input: TabsInput): Promise<{ tabs: TabInfo[] }> {
    return { tabs: [] };
  }
  async hasRef(): Promise<boolean> {
    return false;
  }
  async scroll(_input: ScrollInput): Promise<ScrollResult> {
    return { scrollY: 0, scrollHeight: 0, viewportHeight: 800 };
  }
}

describe("createAgentRuntime", () => {
  let stateDir: string;
  let workingDir: string;
  let backend: FakeBackend;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-"));
    // Project-local skills dir so the skill loader has somewhere to look.
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    backend = new FakeBackend();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("wires the full tool catalog (browser + os + skill + finish)", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
      },
    });
    try {
      const names = runtime.toolRegistry.list().map((t) => t.name).sort();
      expect(names).toContain("finish");
      expect(names).toContain("browser.navigate");
      expect(names).toContain("browser.click");
      expect(names).toContain("browser.type");
      expect(names).toContain("browser.read_aria");
      expect(names).toContain("os.shell.run");
      expect(names).toContain("os.fs.read");
      expect(names).toContain("os.fs.write");
      expect(names).toContain("os.fs.trash");
      expect(names).toContain("os.clipboard.read");
      expect(names).toContain("skill.view");
      expect(names).toContain("skill.run_script");
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps the ApprovalGate the single live switch: a no-approval boot flips back to interactive", async () => {
    // Locked invariant: tools always register `approvalRequired: true`;
    // boot flags land in the gate's auto-approve mode. A tool-level
    // `false` would freeze this boot's value forever and the second
    // half of this test would hang waiting for a prompt that never fires.
    const prompts: ApprovalRequest[] = [];
    let gate: ApprovalGate | null = null;
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      handlers: {
        onApprovalRequest: (request) => {
          prompts.push(request);
          gate?.resolve({
            approvalId: request.approvalId,
            approved: false,
            reason: "test-denied",
          });
        },
      },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    gate = runtime.approvals;
    try {
      const ctx = {
        workingDir,
        sessionId: "s-approve-flip",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
      // Auto-approve boot: dangerous navigation runs without a prompt.
      await runtime.toolRegistry.invoke(
        "browser.navigate",
        { url: "file:///etc/hosts" },
        ctx,
      );
      expect(prompts).toHaveLength(0);

      runtime.setApprovalRequired(true);
      await expect(
        runtime.toolRegistry.invoke(
          "browser.navigate",
          { url: "file:///etc/hosts" },
          ctx,
        ),
      ).rejects.toThrow(/approval denied/);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.tool).toBe("browser.navigate");
    } finally {
      await runtime.shutdown();
    }
  });

  it("builds a capabilities summary and grammar", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.capabilities.workingDir).toBe(workingDir);
      expect(runtime.capabilities.browserChannel).toBeDefined();
      expect(runtime.grammar).toContain("tool-name");
      expect(runtime.toolDescriptors.length).toBeGreaterThan(5);
    } finally {
      await runtime.shutdown();
    }
  });

  it("runs a turn to session completion when LLM emits finish", async () => {
    const events: string[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      handlers: {
        onAgentEvent: (e) => events.push(e.type),
      },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async () => ({
          content: JSON.stringify({
            tool: "finish",
            args: { summary: "done" },
          }),
          timing: { promptTokens: 10, predictedTokens: 5 },
          slotId: 0,
          cacheReused: false,
        }),
      },
    });
    try {
      const session = runtime.createSession();
      const result = await runtime.runTurn(session, "wrap up", { maxSteps: 3 });
      expect(result.reason).toBe("finish");
      expect(result.session.status).toBe("completed");
      expect(events).toContain("step_started");
      expect(events).toContain("step_finished");
      expect(events).toContain("loop_completed");
    } finally {
      await runtime.shutdown();
    }
  });

  it("shutdown closes the browser backend and is idempotent", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    await runtime.shutdown();
    await runtime.shutdown();
    expect(backend.shutdowns).toBe(1);
  });

  it("multi-turn chat: two consecutive runTurn calls accumulate transcript", async () => {
    const replies = ["hi back", "second answer"];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async (params) => {
          // Reflection runner shares the main llmComplete; short-circuit
          // its calls with a NONE completion so the scripted `replies`
          // queue only serves the actual agent turns.
          if (params.sessionId.startsWith("reflection:")) {
            return {
              content: "NONE\n",
              reasoningContent: "",
              stop: true,
              truncated: false,
              timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
              cacheHitTokens: 0,
              slotId: params.slotId,
              modelId: null,
            };
          }
          // Sub-calls (query-rewriter, link-gen, …) use slotId -1 — do not
          // consume the scripted agent reply queue.
          if (params.slotId === -1) {
            return {
              content: "<rewritten_query>NONE</rewritten_query>\n",
              reasoningContent: "",
              stop: true,
              truncated: false,
              timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
              cacheHitTokens: 0,
              slotId: -1,
              modelId: null,
            };
          }
          const text = replies.shift() ?? "fallback";
          return {
            content: JSON.stringify({ tool: "reply", args: { text } }),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: { promptMs: 0, predictedMs: 0, promptTokens: 5, predictedTokens: 3 },
            cacheHitTokens: 0,
            slotId: params.slotId,
            modelId: null,
          };
        },
      },
    });
    try {
      const initial = runtime.createSession();
      const first = await runtime.runTurn(initial, "hi", { maxSteps: 3 });
      expect(first.reason).toBe("reply");
      expect(first.session.turnCount).toBe(1);
      const second = await runtime.runTurn(first.session, "more please", {
        maxSteps: 3,
      });
      expect(second.reason).toBe("reply");
      expect(second.session.turnCount).toBe(2);
      const kinds = second.session.turns.map((t) => t.kind);
      expect(kinds).toEqual([
        "user",
        "assistant_reply",
        "user",
        "assistant_reply",
      ]);
      expect((second.session.turns[1] as { text: string }).text).toBe("hi back");
      expect((second.session.turns[3] as { text: string }).text).toBe(
        "second answer",
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("runtime.runTurn appends user message and reaches a reply", async () => {
    const events: string[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      handlers: { onAgentEvent: (e) => events.push(e.type) },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async () => ({
          content: JSON.stringify({
            tool: "reply",
            args: { text: "hi back" },
          }),
          timing: { promptTokens: 5, predictedTokens: 3 },
          slotId: 0,
          cacheReused: false,
        }),
      },
    });
    try {
      const session = runtime.createSession();
      expect(session.turns).toEqual([]);
      const result = await runtime.runTurn(session, "hello", { maxSteps: 5 });
      expect(result.reason).toBe("reply");
      expect(result.session.turnCount).toBe(1);
      expect(result.session.turns[0]).toMatchObject({ kind: "user", text: "hello" });
      expect(result.session.turns.at(-1)).toMatchObject({
        kind: "assistant_reply",
        text: "hi back",
      });
      const reloaded = runtime.sessionStore.load(session.id)!;
      expect(reloaded.turnCount).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("refreshSkills rebuilds the catalog and notifies listeners", async () => {
    let notified: Array<{ name: string }> = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      handlers: {
        onSkillRegistryChange: (entries) => {
          notified = entries.map((e) => ({ name: e.name }));
        },
      },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      const names = runtime.skillCatalog.map((e) => e.name).sort();
      expect(names).toContain("skill-creator");
      expect(names).toContain("wttr-weather");
      expect(names).not.toContain("exa-web-search");
      await runtime.refreshSkills();
      expect(notified.map((e) => e.name).sort()).toEqual(names);
    } finally {
      await runtime.shutdown();
    }
  });

  it("uses llamaProps override to resolve a gemma 4 grammar", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaProps: GEMMA4_PROPS,
      },
    });
    try {
      expect(runtime.grammar).toContain(
        "root ::= channel-prelude tool-call-array",
      );
      expect(runtime.grammar).toContain("<channel|>");
    } finally {
      await runtime.shutdown();
    }
  });

  it("starts the scheduler by default and stops it before taskStore closes", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.scheduler).not.toBeNull();
    } finally {
      await runtime.shutdown();
    }
    // A double shutdown after the scheduler has stopped must not
    // re-throw — ordering invariant: scheduler.stop before taskStore.close.
    await runtime.shutdown();
  });

  it("registers the five tasks.* agent tools when enabled", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      const names = runtime.toolRegistry.list().map((t) => t.name);
      expect(names).toContain("tasks.schedule");
      expect(names).toContain("tasks.cron");
      expect(names).toContain("tasks.list");
      expect(names).toContain("tasks.cancel");
      expect(names).toContain("tasks.show");
    } finally {
      await runtime.shutdown();
    }
  });

  it("disables scheduler and tasks.* tools when tasks.enabled=false", async () => {
    process.env.ATOMIC_AGENT_TASKS_ENABLED = "false";
    resetConfigCache();
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.scheduler).toBeNull();
      const names = runtime.toolRegistry.list().map((t) => t.name);
      expect(names).not.toContain("tasks.schedule");
      expect(names).not.toContain("tasks.cron");
    } finally {
      await runtime.shutdown();
      delete process.env.ATOMIC_AGENT_TASKS_ENABLED;
      resetConfigCache();
    }
  });

  it("managedLocalLlmHealthFailureHint documents CLI daemon control", () => {
    expect(managedLocalLlmHealthFailureHint(18991)).toContain("atomic-agent models start");
    expect(managedLocalLlmHealthFailureHint(18991)).toContain("127.0.0.1:18991");
  });

  // -----------------------------------------------------------------
  // Telegram channel construction + shutdown ordering. The three
  // construction branches (`enabled=false`, `enabled=true` with no
  // env token, `enabled=true` with a fake bot factory) are exercised
  // separately and then the shutdown-order invariant —
  // `telegramChannel.stop()` must run before `sessionStore.close()` —
  // is asserted via `vi.fn().mock.invocationCallOrder` so a future
  // refactor of the shutdown sequence will fail loudly.
  // -----------------------------------------------------------------

  /** Write a config v9 file with `telegram.enabled` overridden. */
  function enableTelegramInConfig(): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      telegram: { ...USER_CONFIG_DEFAULTS.telegram, enabled: true },
    });
    resetConfigCache();
  }

  /** Build a fake `BotFactory` whose `stop` is a recordable spy. */
  function makeFakeBotFactory(): {
    factory: BotFactory;
    stopSpy: ReturnType<typeof vi.fn>;
  } {
    const stopSpy = vi.fn(async () => undefined);
    const factory: BotFactory = () => {
      const bot: BotInstance = {
        api: {
          sendMessage: vi.fn(async () => ({ message_id: 1 })),
          getMe: vi.fn(async () => ({ id: 1, username: "test_bot" })),
          setMyCommands: vi.fn(async () => undefined),
        },
        setTextHandler: () => undefined,
        start: () => undefined,
        stop: stopSpy,
      };
      return bot;
    };
    return { factory, stopSpy };
  }

  /** Spin until `predicate` is true or `timeoutMs` elapses. */
  async function waitFor(
    predicate: () => boolean,
    { timeoutMs = 1000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  it("telegramChannel is constructed but stays disabled when telegram.enabled is false (default)", async () => {
    // Slice 3B invariant: the channel is *always* constructed so the
    // TUI live-control surface can flip `enabled=true` without
    // restarting the runtime. With the default config (`enabled=false`)
    // the channel stays in `disabled` state and emits no lifecycle
    // events because `start()` is never called.
    const statuses: ChannelStatus[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      handlers: { onChannelStatus: (s) => statuses.push(s) },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.telegramChannel).not.toBeNull();
      expect(runtime.telegramChannel!.state()).toBe("disabled");
      expect(statuses).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("telegramChannel is constructed but reports `down` when token is missing", async () => {
    enableTelegramInConfig();
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const statuses: ChannelStatus[] = [];
    try {
      const runtime = await createAgentRuntime({
        workingDir,
        approvalRequired: false,
        handlers: { onChannelStatus: (s) => statuses.push(s) },
        overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
      });
      try {
        expect(runtime.telegramChannel).not.toBeNull();
        await waitFor(() => runtime.telegramChannel!.state() === "down");
        expect(runtime.telegramChannel!.lastError()).toBe(
          "missing TELEGRAM_BOT_TOKEN",
        );
        expect(statuses.at(-1)).toMatchObject({
          channel: "telegram",
          state: "down",
          lastError: "missing TELEGRAM_BOT_TOKEN",
        });
      } finally {
        await runtime.shutdown();
      }
    } finally {
      if (previousToken !== undefined) {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }
  });

  it("telegramChannel reaches `up` when enabled and a fake bot factory is wired", async () => {
    enableTelegramInConfig();
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "1234:test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const statuses: ChannelStatus[] = [];
    const { factory } = makeFakeBotFactory();
    try {
      const runtime = await createAgentRuntime({
        workingDir,
        approvalRequired: false,
        handlers: { onChannelStatus: (s) => statuses.push(s) },
        overrides: {
          browserBackend: backend,
          skipLlamaHealthCheck: true,
          telegramBotFactory: factory,
        },
      });
      try {
        expect(runtime.telegramChannel).not.toBeNull();
        await waitFor(() => runtime.telegramChannel!.state() === "up");
        expect(runtime.telegramChannel!.lastError()).toBeNull();
        expect(statuses.map((s) => s.state)).toContain("starting");
        expect(statuses.map((s) => s.state)).toContain("up");
      } finally {
        await runtime.shutdown();
      }
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("shutdown stops the Telegram channel before closing the session store", async () => {
    enableTelegramInConfig();
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "1234:test-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { factory, stopSpy } = makeFakeBotFactory();
    try {
      const runtime = await createAgentRuntime({
        workingDir,
        approvalRequired: false,
        overrides: {
          browserBackend: backend,
          skipLlamaHealthCheck: true,
          telegramBotFactory: factory,
        },
      });
      // Wait until the channel is `up` so shutdown actually has a bot
      // instance to stop — otherwise the `bot.stop()` branch is skipped
      // and the test would only assert that close ran.
      await waitFor(() => runtime.telegramChannel!.state() === "up");
      const closeSpy = vi.spyOn(runtime.sessionStore, "close");

      await runtime.shutdown();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const stopOrder = stopSpy.mock.invocationCallOrder[0]!;
      const closeOrder = closeSpy.mock.invocationCallOrder[0]!;
      expect(stopOrder).toBeLessThan(closeOrder);
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("warns once and falls back to plain profile when props probing fails", async () => {
    const logs: LogRecord[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      handlers: {
        logSinks: [(record) => logs.push(record)],
      },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaPropsError: new Error("boom"),
        llamaComplete: async () => ({
          content: JSON.stringify({
            tool: "reply",
            args: { text: "hi back" },
          }),
          timing: { promptTokens: 5, predictedTokens: 3 },
          slotId: 0,
          cacheReused: false,
        }),
      },
    });
    try {
      const result = await runtime.runTurn(runtime.createSession(), "hello", { maxSteps: 2 });
      expect(result.reason).toBe("reply");
      expect(runtime.grammar).toContain("root ::= tool-call");
      const warnings = logs.filter(
        (record) => record.level === "warn" && record.message === "model profile probe failed; using plain fallback",
      );
      expect(warnings).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });
});
