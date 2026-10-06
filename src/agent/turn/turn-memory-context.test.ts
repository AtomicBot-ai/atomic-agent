import { describe, expect, it, vi } from "vitest";
import { createEmptySessionState, recordTurn } from "../../session/session-state.js";
import { assistantReplyTurn, userTurn } from "../../session/conversation-turn.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { LogRecord } from "../../tracing/structured-logger.js";
import type { MemoryEntry } from "../../memory/memory-store.js";
import type { MemoryContextProviderInput, RunTurnOptions } from "../agent-contract.js";
import { createSurfacedMemoryTracker, refreshMemoryContext } from "./turn-memory-context.js";

const options = (): RunTurnOptions => ({ maxSteps: 3, signal: new AbortController().signal, userMessage: "current" });
const session = () => createEmptySessionState({ id: "memory", workingDir: "/work" });
function note(id: number): MemoryEntry {
  return { id, content: "note", createdAt: 1, updatedAt: 1, source: "user", sessionId: null, workingDir: null, tags: [], recallCount: 0, lastRecalledAt: null };
}

describe("turn memory context seam", () => {
  it("projects prior history and only the four latest tool summaries while retaining provider arrays", async () => {
    let state = recordTurn(session(), userTurn("earlier"));
    state = recordTurn(state, assistantReplyTurn("answer"));
    for (let i = 0; i < 6; i += 1) state = recordTurn(state, { kind: "tool_result", tool: "os.fs.read", summary: String(i), status: "ok", at: i });
    state = recordTurn(state, userTurn("current"));
    const recalled = [note(1)];
    let input: MemoryContextProviderInput | undefined;
    const result = await refreshMemoryContext({ memoryContextProvider: { buildMemoryContext: (value) => { input = value; return { recalled, index: [] }; } } }, state, options());
    expect(input?.recentTurns).toEqual([{ role: "user", text: "earlier" }, { role: "assistant", text: "answer" }]);
    expect(input?.toolResultSummaries).toEqual(["os.fs.read: 2", "os.fs.read: 3", "os.fs.read: 4", "os.fs.read: 5"]);
    expect(result).not.toBe(state);
    expect(result.recalledNotes).toBe(recalled);
    expect(result.recalledLessons).toEqual([]);
    expect(result.recalledProcedures).toEqual([]);
  });

  it("returns the original state for disabled/ephemeral recall and recovers a failing provider without priming memory", async () => {
    const state = session();
    const provider = vi.fn(() => ({ recalled: [], index: [] }));
    expect(await refreshMemoryContext({}, state, options())).toBe(state);
    expect(await refreshMemoryContext({ memoryContextProvider: { buildMemoryContext: provider } }, state, { ...options(), ephemeral: true })).toBe(state);
    expect(provider).not.toHaveBeenCalled();
    const logs: LogRecord[] = [];
    const logger = new StructuredLogger({ level: "warn", sinks: [(record) => logs.push(record)] });
    expect(await refreshMemoryContext({ logger, memoryContextProvider: { buildMemoryContext: () => { throw new Error("closed store"); } } }, state, options())).toBe(state);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.context).toEqual({ sessionId: "memory", error: "closed store" });
  });

  it("owns fresh sets and preserves the union in first-surfaced order across later empty recalls", () => {
    const first = createSurfacedMemoryTracker({ ...session(), recalledNotes: [note(2), note(1)] });
    first.recordSurfacedNotes({ ...session(), recalledNotes: [note(1), note(3)] });
    first.recordSurfacedNotes(session());
    const second = createSurfacedMemoryTracker(session());
    expect([...first.surfacedNoteIds]).toEqual([2, 1, 3]);
    expect(second.surfacedNoteIds.size).toBe(0);
    expect(second.surfacedLessonIds).not.toBe(first.surfacedLessonIds);
    expect(second.surfacedProcedureIds).not.toBe(first.surfacedProcedureIds);
  });
});
