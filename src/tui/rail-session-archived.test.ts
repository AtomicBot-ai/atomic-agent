import { describe, expect, it } from "vitest";

import { harness, spokenTo } from "./rail-session-harness.js";

// ATO-1150: chats archived (from the desktop, or POST /api/sessions/{id}/archived)
// stay off the terminal's rail and session picker.
const archived = (id: string, text: string) => {
  const s = spokenTo(id, text);
  return { ...s, metadata: { ...s.metadata, archived: true, archivedSetAt: 1 } };
};

// The rail lists newest first with the id as the tiebreak (see
// `summaryPageOf`), so the later-made row comes first.
describe("rail session list — archived chats", () => {
  it("leaves an archived chat out of the rail and the picker", () => {
    const stored = [spokenTo("s-a", "kept"), archived("s-b", "put away"), spokenTo("s-c", "also kept")];
    const { orchestrator, rail, picker } = harness(stored);
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-c", "s-a"]);
    orchestrator.openSessionPicker();
    expect(picker().map((e) => e.sessionId)).toEqual(["s-c", "s-a"]);
  });

  it("an unarchived chat (no archived key) is listed again", () => {
    const stored = [spokenTo("s-a", "kept"), archived("s-b", "put away")];
    const { orchestrator, rail } = harness(stored);
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-a"]);
    const { archived: _gone, ...rest } = stored[1]!.metadata as Record<string, unknown>;
    stored[1] = { ...stored[1]!, metadata: { ...rest, archivedSetAt: 2 } };
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-b", "s-a"]);
  });

  it("a pinned chat that is archived is not brought back by its pin", () => {
    const stored = [spokenTo("s-a", "kept"), archived("s-b", "put away")];
    const { orchestrator, rail } = harness(stored, { pinned: ["s-b"] });
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-a"]);
  });
});
