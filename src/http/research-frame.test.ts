import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";
import { researchFrame } from "./research-frame.js";

/** ATO-2507: the desktop's research card reads these off the live `tool_result` frame. */
const details = {
  reportPath: "/work/research-heat-pumps-20261127-101500.md",
  question: "How did heat pump sales change?",
  sources: "documents",
  subQuestions: ["a", "b"],
  pagesRead: 4,
  verified: 3,
  unverified: 2,
  contradictions: 1,
  judged: 1,
  skipped: 0,
  stoppedEarly: false,
};
const result = (over: Partial<CompressedToolResult> = {}): CompressedToolResult => ({
  tool: "research.deep",
  status: "ok",
  summary: "Saved the research report to /work/research-heat-pumps-20261127-101500.md",
  details,
  truncated: false,
  ...over,
});

describe("researchFrame (ATO-2507)", () => {
  it("carries an ok research.deep call's counts and report path", () => {
    expect(researchFrame(result())).toEqual({
      research: {
        reportPath: details.reportPath,
        question: details.question,
        sources: "documents",
        pagesRead: 4,
        verified: 3,
        unverified: 2,
        contradictions: 1,
        judged: 1,
        skipped: 0,
        stoppedEarly: false,
      },
    });
  });

  it("keeps a report that was not saved as a null path", () => {
    expect(researchFrame(result({ details: { ...details, reportPath: null } })).research?.reportPath).toBeNull();
  });

  it("is left out for other tools, errors and shapes a host could not trust", () => {
    expect(researchFrame(result({ tool: "files.search" }))).toEqual({});
    expect(researchFrame(result({ status: "error" }))).toEqual({});
    expect(researchFrame(result({ details: { ...details, verified: -1 } }))).toEqual({});
    expect(researchFrame(result({ details: { ...details, reportPath: 42 } }))).toEqual({});
    expect(researchFrame(result({ details: { ...details, question: undefined } }))).toEqual({});
  });

  it("reads an unknown source as the web and a missing judged count as zero", () => {
    const { judged: _judged, ...older } = details;
    void _judged;
    expect(researchFrame(result({ details: { ...older, sources: "moon" } })).research).toMatchObject({ sources: "web", judged: 0 });
  });

  it("is spread onto the SSE tool_result frame", () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    const hook = buildStreamEventHook(
      { closed: false, writeEvent: (name: string | null, payload: unknown) => { written.push({ name, payload }); } } as never,
      { completionId: "c", created: 0, session: { id: "s" }, request: { model: "m", extensionsEnabled: true } } as never,
    );
    hook({ type: "step_started", stepIndex: 0 });
    hook({ type: "llm_event", event: { type: "tool_call_parsed", call: { tool: "research.deep", args: { question: "q" } }, batchIndex: 0, batchSize: 1 } } as AgentLoopEvent);
    hook({ type: "llm_event", event: { type: "tool_call_executed", result: result(), batchIndex: 0, batchSize: 1 } } as AgentLoopEvent);
    const frame = written.find((w) => w.name === "tool_result")?.payload as Record<string, unknown> | undefined;
    expect(frame?.research).toMatchObject({ reportPath: details.reportPath, verified: 3 });
  });
});
