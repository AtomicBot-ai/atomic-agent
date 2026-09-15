import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { executeStep } from "./step-executor.js";
import type { StepEvent } from "./step-events.js";
import { createProgressNoteNoticeState } from "./progress-note-reply.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { replyTool } from "../tools/conversation/reply.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import type { CapabilitiesSummary } from "../prompt/stable-prefix.js";

/**
 * F50 through `executeStep`: a `reply` batched with work tools is a
 * progress note; the turn ends only on a sole `reply`, or on the forced
 * final step, which is untouched.
 */

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SHELL = { tool: "os.shell.run", args: { cmd: "ls" } };
const NOTE = { tool: "reply", args: { text: "(collecting file contents…)" } };

async function run(
  calls: unknown[],
  options: {
    terminalOnly?: boolean;
    progressNotes?: ReturnType<typeof createProgressNoteNoticeState>;
  } = {},
) {
  const registry = new ToolRegistry();
  let shellRuns = 0;
  registry.register({
    name: "os.shell.run",
    description: "shell",
    readonly: false,
    async run(args) {
      shellRuns += 1;
      return compressToolResult({
        tool: "os.shell.run",
        status: "ok",
        output: `$ ${String(args.cmd)}\nexit: 0`,
      });
    },
  });
  registry.register(replyTool);
  const grammar = await buildGrammar(
    PLAIN_INSTRUCT_PROFILE,
    join(process.cwd(), "grammars"),
  );
  const session = createEmptySessionState({ id: "s-f50", workingDir: "/w" });
  session.turns.push({ kind: "user", text: "build it", at: 1 });
  const events: StepEvent[] = [];
  const outcome = await executeStep(
    {
      session,
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: [],
      stepIndex: 0,
      signal: new AbortController().signal,
      userMessage: "build it",
      ...(options.terminalOnly ? { terminalOnly: true } : {}),
    },
    {
      registry,
      ...(options.progressNotes ? { progressNotes: options.progressNotes } : {}),
      slotManager: new SlotManager(2),
      llmComplete: async () => ({
        content: JSON.stringify(calls),
        reasoningContent: "",
        stop: true,
        truncated: false,
        timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
        cacheHitTokens: 0,
        slotId: 0,
        modelId: "mock",
      }),
      grammar,
      profile: PLAIN_INSTRUCT_PROFILE,
      onEvent: (event) => events.push(event),
    },
  );
  return { outcome, events, shellRuns: () => shellRuns };
}

describe("a reply batched with work tools is a progress note (F50)", () => {
  it("[shell, reply]: runs the shell, keeps the note, leaves the turn open", async () => {
    const { outcome, events, shellRuns } = await run([SHELL, NOTE]);
    expect(shellRuns()).toBe(1);
    expect(outcome.terminal).toBeNull();
    expect(outcome.progressNote).toBe("(collecting file contents…)");
    expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["os.shell.run", "reply"]);
    expect(outcome.toolResults[1]).toMatchObject({
      tool: "reply",
      status: "ok",
      details: { progressNote: true },
    });
    expect(outcome.trimmedBatchNotice).toContain(
      "reply ends the turn only when it is the sole call",
    );
    // The transcript: the shell's pair, then the note as a flagged reply.
    expect(outcome.nextSession.turns.slice(-3).map((t) => t.kind)).toEqual([
      "assistant_tool_call",
      "tool_result",
      "assistant_reply",
    ]);
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({ progressNote: true });
    // Events: both calls parsed as one batch of two, both answered, then
    // the interim reply the UI renders — flagged so it is not the end.
    const parsed = events.filter((e) => e.type === "tool_call_parsed");
    expect(parsed.map((e) => (e.type === "tool_call_parsed" ? e.call.tool : ""))).toEqual([
      "os.shell.run",
      "reply",
    ]);
    expect(parsed.every((e) => e.type === "tool_call_parsed" && e.batchSize === 2)).toBe(true);
    const replies = events.filter((e) => e.type === "assistant_reply");
    expect(replies).toEqual([
      { type: "assistant_reply", text: "(collecting file contents…)", progressNote: true },
    ]);
  });

  it("[reply, shell]: the reply first is the same case", async () => {
    const { outcome, shellRuns } = await run([NOTE, SHELL]);
    expect(shellRuns()).toBe(1);
    expect(outcome.terminal).toBeNull();
    expect(outcome.progressNote).toBe("(collecting file contents…)");
    expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["os.shell.run", "reply"]);
  });

  it("[reply] alone ends the turn as it always did", async () => {
    const { outcome, events } = await run([NOTE]);
    expect(outcome.terminal).toBe("turn");
    expect(outcome.progressNote).toBeUndefined();
    expect(outcome.trimmedBatchNotice).toBeUndefined();
    const reply = events.find((e) => e.type === "assistant_reply");
    expect(reply).toEqual({ type: "assistant_reply", text: "(collecting file contents…)" });
  });

  it("the forced final step with [reply] ends the turn", async () => {
    const { outcome } = await run([NOTE], { terminalOnly: true });
    expect(outcome.terminal).toBe("turn");
    expect(outcome.progressNote).toBeUndefined();
  });

  it("the forced final step with [shell, reply] delivers the reply and drops the shell, as before", async () => {
    // Today's final-step path: an approval-gated call batched with the
    // tail reply is trimmed away and the reply lands — no note.
    const { outcome, events, shellRuns } = await run([SHELL, NOTE], {
      terminalOnly: true,
    });
    expect(shellRuns()).toBe(0);
    expect(outcome.terminal).toBe("turn");
    expect(outcome.progressNote).toBeUndefined();
    expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["reply"]);
    expect(events.filter((e) => e.type === "batch_trimmed")).toHaveLength(1);
    expect(events.find((e) => e.type === "assistant_reply")).toEqual({
      type: "assistant_reply",
      text: "(collecting file contents…)",
    });
  });

  it("gives the notice once per turn through the loop's state", async () => {
    const progressNotes = createProgressNoteNoticeState();
    const first = await run([SHELL, NOTE], { progressNotes });
    expect(first.outcome.trimmedBatchNotice).toContain("progress note");
    const second = await run([SHELL, NOTE], { progressNotes });
    expect(second.outcome.progressNote).toBe("(collecting file contents…)");
    expect(second.outcome.trimmedBatchNotice).toBeUndefined();
  });
});
