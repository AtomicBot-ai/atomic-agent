import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent } from "./agent-loop.js";
import type { LlmStreamParams } from "./step-executor.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import { createTraceRecorder } from "../tracing/trace/trace-recorder.js";
import type { TraceEvent } from "../tracing/trace/trace-event.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * F50 through the loop: a `[shell, reply]` step keeps the reply as a
 * progress note and the next step runs; the turn ends on the sole
 * `reply` that follows. The model is told once per turn.
 */

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const NOTE_STEP = JSON.stringify([
  { tool: "os.shell.run", args: { cmd: "ls" } },
  { tool: "reply", args: { text: "(collecting file contents…)" } },
]);
const FINAL = JSON.stringify([{ tool: "reply", args: { text: "built it" } }]);

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
  { name: "os.shell.run", summary: "Run a command.", argsSchema: '{"cmd": string}' },
  { name: "os.fs.write", summary: "Write a file.", argsSchema: '{"path": string, "content": string}' },
  { name: "os.fs.list", summary: "List a directory.", argsSchema: '{"path": string}' },
  { name: "memory.notes.store", summary: "Store a note.", argsSchema: '{"content": string}' },
  { name: "memory.notes.recall", summary: "Recall notes.", argsSchema: '{"query": string}' },
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

describe("AgentLoop: a reply batched with work is a progress note (F50)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-progress-note-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(script: (call: number) => string) {
    const prompts: string[] = [];
    const events: AgentLoopEvent[] = [];
    const trace: TraceEvent[] = [];
    const recorder = createTraceRecorder({
      sessionId: "s-f50",
      emit: (event) => trace.push(event),
      now: () => 0,
    });
    let call = 0;
    let shellRuns = 0;
    const ran: string[] = [];
    const registry = buildDefaultToolRegistry();
    for (const [name, output] of [
      ["os.fs.write", "wrote a (12 bytes)"],
      ["os.fs.list", "a"],
      ["memory.notes.store", "stored #4"],
      ["memory.notes.recall", "#4 wrote the lighthouse story (800 words)"],
    ] as const) {
      registry.register({
        name,
        description: name,
        readonly: name === "os.fs.list" || name === "memory.notes.recall",
        run: async () => {
          ran.push(name);
          return compressToolResult({ tool: name, status: "ok", output });
        },
      });
    }
    registry.register({
      name: "os.shell.run",
      description: "Run a command.",
      readonly: false,
      run: async () => {
        shellRuns += 1;
        return compressToolResult({
          tool: "os.shell.run",
          status: "ok",
          output: "$ ls\nexit: 0",
        });
      },
    });
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params: LlmStreamParams) => {
        prompts.push(params.prompt);
        call += 1;
        return completion(script(call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      onEvent: (event) => {
        events.push(event);
        recorder.onAgentEvent(event);
      },
    });
    return { agent, prompts, events, trace, ran, shellRuns: () => shellRuns };
  }

  it("keeps the note, runs the next step, and ends on the sole reply", async () => {
    const { agent, prompts, events, trace, shellRuns } = loop((call) =>
      call === 1 ? NOTE_STEP : FINAL,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-f50", workingDir }),
      { userMessage: "build it", maxSteps: 5, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(shellRuns()).toBe(1);
    expect(prompts).toHaveLength(2);
    // The next step's prompt carries the notice on the standard channel.
    expect(prompts[1]).toContain("### notice");
    expect(prompts[1]).toContain("reply ends the turn only when it is the sole call");
    // The transcript: the shell pair, the note, then the reply that ended it.
    expect(result.session.turns.map((t) => t.kind)).toEqual([
      "user",
      "assistant_tool_call",
      "tool_result",
      "assistant_reply",
      "assistant_reply",
    ]);
    expect(result.session.turns[3]).toMatchObject({
      text: "(collecting file contents…)",
      progressNote: true,
    });
    expect(result.session.turns[4]).toMatchObject({ text: "built it" });
    expect(result.session.turns[4]).not.toHaveProperty("progressNote");
    // The step summary and the trace say what happened.
    const finished = events.filter((e) => e.type === "step_finished");
    expect(finished[0]).toMatchObject({
      summary: "progress note + 1 tool: os.shell.run[ok]",
      progressNote: true,
    });
    expect(finished[1]).not.toHaveProperty("progressNote");
    const traced = trace.filter((e) => e.type === "step_finished");
    expect(traced[0]).toMatchObject({ stepIndex: 0, progressNote: true });
    expect(traced[1]).not.toHaveProperty("progressNote");
    // Both replies reached the UI; only the first is an interim one.
    const replies = events.flatMap((e) =>
      e.type === "llm_event" && e.event.type === "assistant_reply" ? [e.event] : [],
    );
    expect(replies).toEqual([
      { type: "assistant_reply", text: "(collecting file contents…)", progressNote: true },
      { type: "assistant_reply", text: "built it" },
    ]);
  });

  it("tells the model once per turn", async () => {
    const { agent, prompts } = loop((call) => (call <= 2 ? NOTE_STEP : FINAL));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-f50-once", workingDir }),
      { userMessage: "build it", maxSteps: 5, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("reply ends the turn only when it is the sole call");
    expect(prompts[2]).not.toContain("reply ends the turn only when it is the sole call");
  });

  it("leaves the forced final step alone: [shell, reply] there still ends the turn", async () => {
    const { agent, shellRuns } = loop(() => NOTE_STEP);
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-f50-final", workingDir }),
      {
        userMessage: "build it",
        maxSteps: 1,
        taskMaxSteps: 1,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(shellRuns()).toBe(0);
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "(collecting file contents…)",
    });
    expect(result.session.turns.at(-1)).not.toHaveProperty("progressNote");
  });

  const STORY = "The lighthouse stood on the cape for a hundred years…";
  const replies = (events: AgentLoopEvent[]) =>
    events.flatMap((e) =>
      e.type === "llm_event" && e.event.type === "assistant_reply" ? [e.event] : [],
    );

  it("a reply batched only with memory.notes.store ends the turn, after the note is stored", async () => {
    const { agent, prompts, events, ran } = loop((call) =>
      call === 1
        ? JSON.stringify([
            { tool: "reply", args: { text: STORY } },
            { tool: "memory.notes.store", args: { content: "wrote the story" } },
          ])
        : FINAL,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-f50-store", workingDir }),
      { userMessage: "write a story", maxSteps: 5, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(prompts).toHaveLength(1);
    expect(ran).toEqual(["memory.notes.store"]);
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: STORY,
    });
    expect(result.session.turns.at(-1)).not.toHaveProperty("progressNote");
    expect(replies(events)).toEqual([{ type: "assistant_reply", text: STORY }]);
  });

  it("a reply batched with os.fs.write is still a progress note", async () => {
    const { agent, prompts, ran } = loop((call) =>
      call === 1
        ? JSON.stringify([
            { tool: "os.fs.write", args: { path: "a", content: "x" } },
            { tool: "reply", args: { text: "(writing the file…)" } },
          ])
        : FINAL,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-f50-write", workingDir }),
      { userMessage: "write it", maxSteps: 5, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(prompts).toHaveLength(2);
    expect(ran).toEqual(["os.fs.write"]);
    expect(result.session.turns.at(-2)).toMatchObject({
      text: "(writing the file…)",
      progressNote: true,
    });
    expect(result.session.turns.at(-1)).toMatchObject({ text: "built it" });
  });

  it("a reply batched with a recall is a progress note: the recall is work", async () => {
    const { agent, prompts, ran } = loop((call) =>
      call === 1
        ? JSON.stringify([
            { tool: "memory.notes.recall", args: { query: "story" } },
            { tool: "reply", args: { text: "(checking my notes…)" } },
          ])
        : FINAL,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-f50-recall", workingDir }),
      { userMessage: "what did I ask?", maxSteps: 5, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(prompts).toHaveLength(2);
    expect(ran).toEqual(["memory.notes.recall"]);
    expect(result.session.turns.at(-2)).toMatchObject({ progressNote: true });
  });

  it("the live story trace ends at step 0 with one reply, not six steps of the same story", async () => {
    // The hand-QA trace, step for step: store+reply, recall, store+reply,
    // list, recall+reply, reply. Only the first step may run.
    const steps = [
      [
        { tool: "memory.notes.store", args: { content: "Wrote the lighthouse story (800 words)" } },
        { tool: "reply", args: { text: STORY } },
      ],
      [{ tool: "memory.notes.recall", args: { query: "lighthouse" } }],
      [
        { tool: "memory.notes.store", args: { content: "Wrote the lighthouse story (800 words)" } },
        { tool: "reply", args: { text: STORY } },
      ],
      [{ tool: "os.fs.list", args: { path: "." } }],
      [
        { tool: "memory.notes.recall", args: { query: "lighthouse" } },
        { tool: "reply", args: { text: STORY } },
      ],
      [{ tool: "reply", args: { text: STORY } }],
    ];
    const { agent, prompts, events, ran } = loop((call) =>
      JSON.stringify(steps[call - 1] ?? steps.at(-1)),
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-f50-story", workingDir }),
      {
        userMessage: "Write a detailed 800-word story about a lighthouse.",
        maxSteps: 10,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(prompts).toHaveLength(1);
    expect(ran).toEqual(["memory.notes.store"]);
    expect(events.filter((e) => e.type === "step_finished")).toHaveLength(1);
    expect(replies(events)).toEqual([{ type: "assistant_reply", text: STORY }]);
    expect(
      result.session.turns.filter((t) => t.kind === "assistant_reply"),
    ).toHaveLength(1);
  });
});
