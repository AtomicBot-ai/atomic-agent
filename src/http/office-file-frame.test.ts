import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { officeFileFrame } from "./office-file-frame.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * ATO-2518: an Office writer's `tool_result` frame names the file it made
 * or changed, so the desktop's "Changed files" row no longer depends on
 * the `tool_progress` label (the call's arguments clipped to 120
 * characters, which lose `path` when blocks or slides come first).
 */
const result = (over: Partial<CompressedToolResult> = {}): CompressedToolResult => ({
  tool: "os.fs.docx",
  status: "ok",
  summary: "created /w/report.docx with 3 paragraphs",
  details: { path: "/w/report.docx", op: "create", change: "created" },
  truncated: false,
  ...over,
});

describe("officeFileFrame", () => {
  it("names the file and whether it is new for each Office writer", () => {
    expect(officeFileFrame(result())).toEqual({ office_file: { path: "/w/report.docx", change: "created" } });
    expect(
      officeFileFrame(result({ tool: "os.fs.xlsx", details: { path: "/w/b.xlsx", op: "write", change: "updated" } })),
    ).toEqual({ office_file: { path: "/w/b.xlsx", change: "updated" } });
    expect(
      officeFileFrame(result({ tool: "os.fs.write_pptx", details: { path: "/w/d.pptx", change: "updated" } })),
    ).toEqual({ office_file: { path: "/w/d.pptx", change: "updated" } });
  });

  it("is left out for a failed call, another tool, a read, or a shape a host cannot draw", () => {
    expect(officeFileFrame(result({ status: "error" }))).toEqual({});
    expect(officeFileFrame(result({ tool: "os.fs.write" }))).toEqual({});
    expect(officeFileFrame(result({ tool: "os.fs.xlsx", details: { path: "/w/b.xlsx", op: "read" } }))).toEqual({});
    expect(officeFileFrame(result({ details: { path: "", change: "created" } }))).toEqual({});
    expect(officeFileFrame(result({ details: { path: "/w/a.docx", change: "replaced" } }))).toEqual({});
    expect(officeFileFrame(result({ details: { change: "created" } }))).toEqual({});
  });
});

describe("tool_result over SSE: office_file", () => {
  it("rides the frame of an ok Office write, even when the slides came before the path", () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    const sse = { closed: false, writeEvent: (name: string | null, payload: unknown) => written.push({ name, payload }) };
    const env = {
      completionId: "cmpl-1",
      created: 0,
      session: { id: "s-1" },
      request: { model: "atomic-agent", extensionsEnabled: true },
    } as never;
    const hook = buildStreamEventHook(sse as never, env);
    const slides = Array.from({ length: 12 }, (_, i) => ({ title: `Slide ${i + 1}`, bullets: ["a long bullet line"] }));
    const parsed: AgentLoopEvent = {
      type: "llm_event",
      event: {
        type: "tool_call_parsed",
        call: { tool: "os.fs.write_pptx", args: { slides, path: "decks/plan.pptx" } },
        batchIndex: 0,
        batchSize: 1,
      },
    };
    const executed: AgentLoopEvent = {
      type: "llm_event",
      event: {
        type: "tool_call_executed",
        result: result({ tool: "os.fs.write_pptx", details: { path: "/w/decks/plan.pptx", change: "created" } }),
        batchIndex: 0,
        batchSize: 1,
      },
    };
    hook({ type: "step_started", stepIndex: 0 });
    hook(parsed);
    hook(executed);

    const frame = written.find((w) => w.name === "tool_result")!.payload as Record<string, unknown>;
    expect(frame.office_file).toEqual({ path: "/w/decks/plan.pptx", change: "created" });
    expect(frame).not.toHaveProperty("diffstat");
  });
});
