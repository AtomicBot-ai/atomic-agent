import { describe, expect, it, vi } from "vitest";

import { buildPrompt } from "../../prompt/build-prompt.js";
import type { MemoryEntry } from "../../memory/memory-store.js";
import type { ProfileFact } from "../../memory/profile-store.js";
import { channelGuestMetadata } from "../../session/channel-guest-session.js";
import { userTurn } from "../../session/conversation-turn.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../../session/session-state.js";
import type { RunTurnOptions } from "../agent-contract.js";
import { profileFactsForPrompt, readsNoSavedMemory, refreshMemoryContext } from "./turn-memory-context.js";

/**
 * ATO-2729: a channel guest's session (`channelGuest: true`, set by the
 * Telegram channel for a group's guests) reads none of the owner's saved
 * memory. No recalled notes, index, lessons, procedures or profile facts
 * reach a guest turn's prompt; the owner's own session still gets them.
 */
const options = (): RunTurnOptions => ({ maxSteps: 3, signal: new AbortController().signal, userMessage: "what do you know about the owner?" });
const owner = (): SessionState => createEmptySessionState({ id: "owner", workingDir: "/work" });
const guest = (base: SessionState = createEmptySessionState({ id: "guest", workingDir: "/work" })): SessionState => ({
  ...base,
  metadata: { ...base.metadata, ...channelGuestMetadata() },
});
const storedNote = (): MemoryEntry => ({
  id: 7, content: "secret note: the owner's bank is Zeta-Bank-91", createdAt: 1, updatedAt: 1, source: "user",
  sessionId: null, workingDir: null, tags: [], recallCount: 0, lastRecalledAt: null,
});
const facts: ProfileFact[] = [{
  id: 1, key: "home_city", value: "owner-city-Quillsby", validFrom: 1, updatedAt: 1, pinned: true,
  keywords: [], supersedes: null, supersededBy: null, voteScore: 0,
}];
const provider = () => vi.fn(() => ({
  recalled: [storedNote()],
  index: [{ id: 7, preview: "secret note preview", tags: [], updatedAt: 1, workingDir: null, sessionId: null }],
}));
const prompt = (state: SessionState, profileFacts: readonly ProfileFact[] | undefined) => buildPrompt({
  session: recordTurn(state, userTurn("what do you know about the owner?")),
  toolDescriptors: [],
  capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work", hasClipboard: true, hasWmctrl: false, hasNotifications: true },
  skillCatalog: [],
  ...(profileFacts !== undefined ? { profileFacts } : {}),
}).text;

describe("channel guest sessions read none of the owner's memory (ATO-2729)", () => {
  it("marks a guest session, and only a guest session, as reading no saved memory", () => {
    expect(readsNoSavedMemory(guest())).toBe(true);
    expect(readsNoSavedMemory(owner())).toBe(false);
    // A metadata value other than `true` is not a guest stamp.
    expect(readsNoSavedMemory({ ...owner(), metadata: { channelGuest: "yes" } })).toBe(false);
  });

  it("does not call the memory provider for a guest and clears any recall the state carried", async () => {
    const build = provider();
    const carried = guest({ ...owner(), recalledNotes: [storedNote()], memoryIndex: [], recalledLessons: [], recalledProcedures: [] });
    const result = await refreshMemoryContext({ memoryContextProvider: { buildMemoryContext: build } }, carried, options());
    expect(build).not.toHaveBeenCalled();
    expect(result.recalledNotes).toBeUndefined();
    expect(result.memoryIndex).toBeUndefined();
    expect(result.recalledLessons).toBeUndefined();
    expect(result.recalledProcedures).toBeUndefined();
    expect(result.metadata).toEqual(carried.metadata);
  });

  it("lists no profile facts for a guest, and still does for the owner", () => {
    const list = vi.fn(() => facts);
    expect(profileFactsForPrompt(list, guest())).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(profileFactsForPrompt(list, owner())).toBe(facts);
  });

  it("a guest turn's built prompt holds no stored note or profile fact; the owner's does", async () => {
    const deps = { memoryContextProvider: { buildMemoryContext: provider() } };
    const list = () => facts;

    const hidden = await refreshMemoryContext(deps, guest(), options());
    const hiddenText = prompt(hidden, profileFactsForPrompt(list, hidden));
    expect(hiddenText).not.toContain("secret note");
    expect(hiddenText).not.toContain("owner-city-Quillsby");

    const shown = await refreshMemoryContext(deps, owner(), options());
    const shownText = prompt(shown, profileFactsForPrompt(list, shown));
    expect(shownText).toContain("secret note");
    expect(shownText).toContain("owner-city-Quillsby");
  });
});
