import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

function makeCompletion(content: string): CompletionResult {
  return {
    content,
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];

describe("AgentLoop end-to-end with mock LLM", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-loop-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("finishes session immediately when the LLM emits a finish tool call", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "finish", args: { summary: "done" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s1", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "please wrap up",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("finish");
    expect(result.session.status).toBe("completed");
    expect(result.session.latestResult?.tool).toBe("finish");
    expect(result.session.stepCount).toBe(1);
  });

  it("throws and marks the session as failed when the LLM emits invalid tool JSON", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => makeCompletion("not a json"),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-bad", workingDir });
    await expect(
      loop.runTurn(session, {
        userMessage: "whatever",
        maxSteps: 3,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/tool-call/);
  });

  it("runTurn appends user message and exits on reply", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "hello there" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({
      id: "chat-1",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "hi",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(result.session.turnCount).toBe(1);
    const turns = result.session.turns;
    expect(turns[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "hello there",
    });
  });

  it("runTurn synthesises an assistant reply when max steps is hit", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({
            tool: "browser.read_aria",
            args: {},
          }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({
      id: "chat-stuck",
      workingDir,
    });
    // browser.read_aria is dangerous → throws since approval gate blocks
    // it here. Easier path: use a never-finishing tool. We rely on the
    // mock grammar/parsing — supply a tool that always succeeds with a
    // non-terminal result by mocking a no-op via finish+swallow. The
    // simplest is to just cap maxSteps very low and let one finishing
    // step be replaced by a non-terminal one through a custom registry.
    // Here we register a dummy noop tool inline:
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok",
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const loopNoop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "noop", args: {} })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loopNoop.runTurn(session, {
      userMessage: "do stuff",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("max_steps");
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: expect.stringContaining("max_steps"),
    });
    expect(result.session.status).toBe("stalled");
    expect(result.session.lastError).toMatch(/max_steps_reached: 2 steps/);
  });

  it("injects a transient notice into the next prompt when a no-progress loop is detected", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok",
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const prompts: string[] = [];
    const events: Array<{ type: string; tool?: string; count?: number }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ prompt }) => {
        prompts.push(prompt);
        // Always emit the same tool with the same args → guaranteed loop.
        return makeCompletion(JSON.stringify({ tool: "noop", args: {} }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_detected") {
          events.push({
            type: event.type,
            tool: event.tool,
            count: event.count,
          });
        }
      },
    });
    const session = createEmptySessionState({
      id: "s-loop",
      workingDir,
    });
    await loop.runTurn(session, {
      userMessage: "stuck",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    // The phrase "### notice" appears in the system persona regardless,
    // so we detect the notice by its body text which is only present
    // when the detector fired.
    const NOTICE_MARK = /same arguments \d+ times in a row/;
    expect(NOTICE_MARK.test(prompts[0]!)).toBe(false);
    expect(NOTICE_MARK.test(prompts[1]!)).toBe(false);
    expect(prompts.some((p) => NOTICE_MARK.test(p))).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.tool).toBe("noop");
    expect(events[0]?.count).toBeGreaterThanOrEqual(3);
  });

  it("does not inject a notice when consecutive steps differ", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run(args) {
        return {
          tool: "noop",
          status: "ok",
          summary: `noop:${(args as { n?: number })?.n ?? 0}`,
          details: {},
          truncated: false,
        };
      },
    });
    const prompts: string[] = [];
    let n = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ prompt }) => {
        prompts.push(prompt);
        n += 1;
        if (n >= 4) {
          return makeCompletion(
            JSON.stringify({ tool: "reply", args: { text: "done" } }),
          );
        }
        return makeCompletion(JSON.stringify({ tool: "noop", args: { n } }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({
      id: "s-nodiff",
      workingDir,
    });
    await loop.runTurn(session, {
      userMessage: "varied",
      maxSteps: 8,
      signal: new AbortController().signal,
    });
    const NOTICE_MARK = /same arguments \d+ times in a row/;
    expect(prompts.every((p) => !NOTICE_MARK.test(p))).toBe(true);
  });

  it("continues the turn when a tool throws and records the error as a tool result", async () => {
    const registry = buildDefaultToolRegistry();
    let flakyCalls = 0;
    registry.register({
      name: "flaky",
      description: "throws on first call, succeeds after",
      readonly: true,
      async run() {
        flakyCalls += 1;
        if (flakyCalls === 1) {
          throw new Error("locator.click: Timeout 30000ms exceeded.");
        }
        return {
          tool: "flaky",
          status: "ok",
          summary: "recovered",
          details: {},
          truncated: false,
        };
      },
    });
    let call = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        call += 1;
        if (call === 1) {
          return makeCompletion(JSON.stringify({ tool: "flaky", args: {} }));
        }
        if (call === 2) {
          return makeCompletion(JSON.stringify({ tool: "flaky", args: {} }));
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "done" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({
      id: "s-flaky",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "try something",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(result.stepCount).toBe(3);
    const toolResults = result.session.turns.filter(
      (turn): turn is Extract<typeof turn, { kind: "tool_result" }> =>
        turn.kind === "tool_result",
    );
    expect(toolResults[0]).toMatchObject({
      tool: "flaky",
      status: "error",
    });
    expect(toolResults[0]?.summary).toMatch(/Timeout/);
    expect(toolResults[1]).toMatchObject({
      tool: "flaky",
      status: "ok",
    });
  });

  it("respects an external abort signal", async () => {
    const registry = buildDefaultToolRegistry();
    const controller = new AbortController();
    controller.abort();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion('{"tool":"finish","args":{"summary":"never"}}'),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "g",
      maxSteps: 3,
      signal: controller.signal,
    });
    expect(result.reason).toBe("cancelled");
    expect(result.session.status).toBe("cancelled");
  });
});
