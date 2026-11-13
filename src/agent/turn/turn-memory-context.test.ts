import { describe, expect, it, vi } from "vitest";
import { createEmptySessionState, recordTurn } from "../../session/session-state.js";
import { assistantReplyTurn, userTurn } from "../../session/conversation-turn.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { LogRecord } from "../../tracing/structured-logger.js";
import type { MemoryEntry } from "../../memory/memory-store.js";
import type { MemoryContextProviderInput, RunTurnOptions } from "../agent-contract.js";
import type { ProfileFact } from "../../memory/profile-store.js";
import type { SessionState } from "../../session/session-state.js";
import { buildPrompt } from "../../prompt/build-prompt.js";
import { createSurfacedMemoryTracker, profileFactsForPrompt, refreshMemoryContext } from "./turn-memory-context.js";

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

/**
 * ATO-586, decision 8: an incognito chat does not read saved memory. No
 * recalled notes, memory index, lessons or procedures, and no profile
 * facts, reach the prompt it builds; an ordinary chat is unchanged.
 */
describe("incognito chats read no memory", () => {
  const incognito = (base: SessionState = session()): SessionState => ({ ...base, incognito: { since: 1, owner: "{}" } });
  const storedNote = (): MemoryEntry => ({ ...note(7), content: "secret note: the user is planning a surprise" });
  const facts: ProfileFact[] = [{ key: "favourite_drink", value: "oolong-tea-42", updatedAt: 1, pinned: true, keywords: [] } as ProfileFact];
  const provider = () => vi.fn(() => ({ recalled: [storedNote()], index: [{ id: 7, preview: "secret note preview", tags: [], updatedAt: 1, workingDir: null, sessionId: null }] }));
  const prompt = (state: SessionState, profileFacts: readonly ProfileFact[] | undefined) => buildPrompt({
    session: recordTurn(state, userTurn("current")),
    toolDescriptors: [],
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work", hasClipboard: true, hasWmctrl: false, hasNotifications: true },
    skillCatalog: [],
    ...(profileFacts !== undefined ? { profileFacts } : {}),
  }).text;

  it("does not call the memory provider and clears any recall the state carried", async () => {
    const build = provider();
    const carried = incognito({ ...session(), recalledNotes: [storedNote()], memoryIndex: [], recalledLessons: [], recalledProcedures: [] });
    const result = await refreshMemoryContext({ memoryContextProvider: { buildMemoryContext: build } }, carried, options());
    expect(build).not.toHaveBeenCalled();
    expect(result.recalledNotes).toBeUndefined();
    expect(result.memoryIndex).toBeUndefined();
    expect(result.recalledLessons).toBeUndefined();
    expect(result.recalledProcedures).toBeUndefined();
    expect(result.incognito).toEqual(carried.incognito);
  });

  it("lists no profile facts for an incognito chat, and still does for an ordinary one", () => {
    const list = vi.fn(() => facts);
    expect(profileFactsForPrompt(list, incognito())).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(profileFactsForPrompt(list, session())).toBe(facts);
  });

  it("the built prompt of an incognito chat holds no stored note or profile fact; an ordinary chat's does", async () => {
    const deps = { memoryContextProvider: { buildMemoryContext: provider() } };
    const list = () => facts;

    const hidden = await refreshMemoryContext(deps, incognito(), options());
    const hiddenText = prompt(hidden, profileFactsForPrompt(list, hidden));
    expect(hiddenText).not.toContain("secret note");
    expect(hiddenText).not.toContain("oolong-tea-42");

    const shown = await refreshMemoryContext(deps, session(), options());
    const shownText = prompt(shown, profileFactsForPrompt(list, shown));
    expect(shownText).toContain("secret note");
    expect(shownText).toContain("oolong-tea-42");
  });
});
