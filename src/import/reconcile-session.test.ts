import { describe, expect, it } from "vitest";

import {
  assistantReplyTurn,
  userTurn,
  type ConversationTurn,
} from "../session/conversation-turn.js";
import type { SessionState } from "../session/session-state.js";
import { reconcileImportedSession } from "./reconcile-session.js";

function session(
  turns: ConversationTurn[],
  metadata: Record<string, unknown> = { importedFrom: "hermes" },
): SessionState {
  return {
    id: "hermes:s-1",
    workingDir: "/work",
    status: "completed",
    knownFacts: [],
    latestResult: null,
    loadedSkills: [],
    loadedTools: [],
    worldSnapshot: null,
    stepCount: 0,
    turnCount: 0,
    turns,
    createdAt: 1,
    updatedAt: 2,
    lastError: null,
    metadata,
  };
}

const T1 = userTurn("hi", 1);
const T2 = assistantReplyTurn("hello", 2);
const T3 = userTurn("more", 3);

function run(
  existing: SessionState | null,
  mapped: SessionState,
  flags: { execute?: boolean; overwrite?: boolean } = {},
) {
  const saved: SessionState[] = [];
  const result = reconcileImportedSession({
    existing,
    mapped,
    execute: flags.execute ?? true,
    overwrite: flags.overwrite ?? false,
    save: (state) => saved.push(state),
  });
  return { result, saved };
}

describe("reconcileImportedSession", () => {
  it("saves a session the destination does not hold yet", () => {
    const mapped = session([T1, T2]);
    const { result, saved } = run(null, mapped);
    expect(result).toEqual({ status: "migrated" });
    expect(saved).toEqual([mapped]);
  });

  it("does not write in preview mode", () => {
    const { result, saved } = run(null, session([T1]), { execute: false });
    expect(result.status).toBe("migrated");
    expect(saved).toEqual([]);
  });

  it("skips when the transcripts already match", () => {
    const { result, saved } = run(session([T1, T2]), session([T1, T2]));
    expect(result).toEqual({ status: "skipped", reason: "already matches" });
    expect(saved).toEqual([]);
  });

  it("updates when the same source grew since the last import", () => {
    const { result, saved } = run(session([T1, T2]), session([T1, T2, T3]));
    expect(result).toEqual({
      status: "migrated",
      reason: "updated (+1 turns)",
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.turns).toEqual([T1, T2, T3]);
  });

  it("keeps destination-only metadata across an update", () => {
    const existing = session([T1], {
      importedFrom: "hermes",
      llm: { providerId: "local", chatModel: "qwen" },
    });
    const mapped = session([T1, T2], { importedFrom: "hermes", title: "new" });
    const { saved } = run(existing, mapped);
    expect(saved[0]!.metadata).toEqual({
      importedFrom: "hermes",
      llm: { providerId: "local", chatModel: "qwen" },
      title: "new",
    });
  });

  it("conflicts when a grown transcript comes from a different source", () => {
    const existing = session([T1, T2], { importedFrom: "openclaw" });
    const { result, saved } = run(existing, session([T1, T2, T3]));
    expect(result.status).toBe("conflict");
    expect(saved).toEqual([]);
  });

  it("conflicts when the destination was continued locally", () => {
    // The operator imported [T1, T2] and then talked to the agent, so the
    // stored transcript is longer than what the source has. The store
    // must keep the local continuation.
    const local = assistantReplyTurn("continued here", 9);
    const existing = session([T1, T2, local]);
    const { result, saved } = run(existing, session([T1, T2]));
    expect(result.status).toBe("conflict");
    expect(saved).toEqual([]);

    // Same length, different content — also not a prefix.
    const diverged = run(session([T1, local]), session([T1, T2]));
    expect(diverged.result.status).toBe("conflict");
    expect(diverged.saved).toEqual([]);
  });

  it("conflicts when a local continuation is longer and the source also grew", () => {
    const local = assistantReplyTurn("continued here", 9);
    const { result, saved } = run(session([T1, local]), session([T1, T2, T3]));
    expect(result.status).toBe("conflict");
    expect(saved).toEqual([]);
  });

  it("conflicts when the imported session carries no source stamp", () => {
    const { result } = run(session([T1], {}), session([T1, T2], {}));
    expect(result.status).toBe("conflict");
  });

  it("overwrites a diverged destination only when asked", () => {
    const existing = session([T1, assistantReplyTurn("old", 2)]);
    const mapped = session([T1, T2]);
    const refused = run(existing, mapped);
    expect(refused.result).toEqual({
      status: "conflict",
      reason: "destination differs; use --overwrite",
    });
    expect(refused.saved).toEqual([]);

    const forced = run(existing, mapped, { overwrite: true });
    expect(forced.result).toEqual({
      status: "migrated",
      reason: "overwritten",
    });
    expect(forced.saved).toEqual([mapped]);
  });
});
