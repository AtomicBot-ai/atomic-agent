import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "./bootstrap.js";
import { resetConfigCache } from "../config/index.js";
import { GEMMA4_PROPS } from "../llm/model-profile.fixtures.js";
import type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
  SearchInput,
  TabInfo,
  TabsInput,
  TypeInput,
} from "../tools/browser/browser-backend.js";
import type { LogRecord } from "../telemetry/structured-logger.js";

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
      expect(names).toContain("os.clipboard.read");
      expect(names).toContain("skill.view");
      expect(names).toContain("skill.run_script");
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
              timing: { promptTokens: 1, predictedTokens: 1 },
              slotId: 0,
              cacheReused: false,
            };
          }
          const text = replies.shift() ?? "fallback";
          return {
            content: JSON.stringify({ tool: "reply", args: { text } }),
            timing: { promptTokens: 5, predictedTokens: 3 },
            slotId: 0,
            cacheReused: false,
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
      expect(runtime.skillCatalog).toHaveLength(0);
      await runtime.refreshSkills();
      expect(notified).toEqual([]);
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
      expect(runtime.grammar).toContain("root ::= channel-prelude tool-call");
      expect(runtime.grammar).toContain("<channel|>");
    } finally {
      await runtime.shutdown();
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
