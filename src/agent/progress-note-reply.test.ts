import { describe, expect, it } from "vitest";
import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { StepEvent } from "./step-events.js";
import {
  PROGRESS_NOTE_RESULT,
  createProgressNoteNoticeState,
  formatProgressNoteNotice,
  formatProgressNoteStepSummary,
  isProgressNoteResult,
  progressNoteResult,
  progressNoteText,
  recordProgressNote,
  splitProgressNoteReply,
} from "./progress-note-reply.js";

const shell: ToolCallPayload = {
  tool: "os.shell.run",
  args: { cmd: "ls" },
};
const read: ToolCallPayload = { tool: "os.fs.read", args: { path: "a" } };
const reply: ToolCallPayload = {
  tool: "reply",
  args: { text: "(collecting file contents…)" },
};
const finish: ToolCallPayload = { tool: "finish", args: { summary: "done" } };

describe("splitProgressNoteReply", () => {
  it("takes the reply out of [shell, reply] and keeps the work", () => {
    const split = splitProgressNoteReply([shell, reply]);
    expect(split).not.toBeNull();
    expect(split!.calls).toEqual([shell]);
    expect(split!.note).toBe(reply);
  });

  it("finds the reply in any position, not only the tail", () => {
    expect(splitProgressNoteReply([reply, shell])!.calls).toEqual([shell]);
    expect(splitProgressNoteReply([read, reply, read])!.calls).toEqual([
      read,
      read,
    ]);
  });

  it("leaves a sole reply alone: that is the end of the turn", () => {
    expect(splitProgressNoteReply([reply])).toBeNull();
  });

  it("leaves the forced final step's batch exactly as it is", () => {
    expect(splitProgressNoteReply([shell, reply], { terminalOnly: true })).toBeNull();
  });

  it("does not split a batch with no work in it, nor one without a reply", () => {
    expect(splitProgressNoteReply([reply, reply])).toBeNull();
    expect(splitProgressNoteReply([reply, finish])).toBeNull();
    expect(splitProgressNoteReply([shell, finish])).toBeNull();
    expect(splitProgressNoteReply([read, read])).toBeNull();
  });

  it("ignores a reply with no text — the validator refuses that one", () => {
    const blank: ToolCallPayload = { tool: "reply", args: { text: "  " } };
    expect(splitProgressNoteReply([shell, blank])).toBeNull();
  });

  it("reads the note's text back", () => {
    expect(progressNoteText(reply)).toBe("(collecting file contents…)");
  });
});

describe("the note's result, summary and notice", () => {
  it("stands in for the reply as an ok result flagged progressNote", () => {
    const result = progressNoteResult();
    expect(result).toMatchObject({
      tool: "reply",
      status: "ok",
      details: { progressNote: true },
    });
    expect(result.summary).toContain(PROGRESS_NOTE_RESULT);
    expect(isProgressNoteResult(result)).toBe(true);
    expect(
      isProgressNoteResult(
        compressToolResult({ tool: "reply", status: "ok", output: "hi" }),
      ),
    ).toBe(false);
  });

  it("summarises the step as a note plus the tools that ran", () => {
    const ran = compressToolResult({
      tool: "os.shell.run",
      status: "ok",
      output: "$ ls",
    });
    const failed = compressToolResult({
      tool: "os.fs.read",
      status: "error",
      output: "ENOENT",
    });
    expect(formatProgressNoteStepSummary([ran, progressNoteResult()])).toBe(
      "progress note + 1 tool: os.shell.run[ok]",
    );
    expect(
      formatProgressNoteStepSummary([ran, failed, progressNoteResult()]),
    ).toBe("progress note + 2 tools: os.shell.run[ok], os.fs.read[error]");
  });

  it("tells the model the rule in the notice", () => {
    const notice = formatProgressNoteNotice();
    expect(notice).toContain("progress note");
    expect(notice).toContain("reply ends the turn only when it is the sole call");
  });

  it("remembers that the turn was told, once", () => {
    const state = createProgressNoteNoticeState();
    expect(state.noticed()).toBe(false);
    state.markNoticed();
    expect(state.noticed()).toBe(true);
  });
});

describe("recordProgressNote", () => {
  it("answers the note's call, flags the transcript row and emits an interim reply", () => {
    const events: StepEvent[] = [];
    const session = createEmptySessionState({ id: "s-note", workingDir: "/w" });
    const { state, result } = recordProgressNote({
      state: session,
      note: reply,
      batchIndex: 1,
      batchSize: 2,
      onEvent: (event) => events.push(event),
    });
    expect(isProgressNoteResult(result)).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_executed",
      "assistant_reply",
    ]);
    expect(events[0]).toMatchObject({ batchIndex: 1, batchSize: 2 });
    expect(events[1]).toMatchObject({
      text: "(collecting file contents…)",
      progressNote: true,
    });
    expect(state.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "(collecting file contents…)",
      progressNote: true,
    });
  });
});
