import { describe, expect, it, vi } from "vitest";

import type { SessionState } from "../session/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  toSessionSummary,
  type SessionServiceDeps,
} from "./session-service.js";

function fakeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "s-1",
    workingDir: "/tmp/proj",
    status: "pending",
    knownFacts: [],
    latestResult: null,
    loadedSkills: [],
    loadedTools: [],
    worldSnapshot: null,
    stepCount: 0,
    turnCount: 0,
    turns: [],
    createdAt: 1,
    updatedAt: 2,
    lastError: null,
    ...overrides,
  } as SessionState;
}

function makeDeps(overrides: Partial<SessionServiceDeps> = {}): SessionServiceDeps {
  return {
    createSession: vi.fn(() => fakeState()),
    sessionStore: {
      load: vi.fn(() => fakeState()),
      listRecent: vi.fn(() => [fakeState()]),
      listByWorkingDir: vi.fn(() => [fakeState({ id: "s-2" })]),
      delete: vi.fn(),
    },
    turnController: { isBusy: vi.fn(() => false) },
    ...overrides,
  };
}

describe("session-service", () => {
  it("projects a summary with the busy flag from the turn controller", () => {
    const summary = toSessionSummary(fakeState(), { isBusy: () => true });
    expect(summary).toMatchObject({ id: "s-1", busy: true, status: "pending" });
    expect(summary).not.toHaveProperty("turns");
  });

  it("creates a session and returns a summary", () => {
    const deps = makeDeps();
    const summary = createSession(deps, { metadata: { a: 1 } });
    expect(deps.createSession).toHaveBeenCalledWith({ metadata: { a: 1 } });
    expect(summary.id).toBe("s-1");
  });

  it("lists by working dir when provided, else recent", () => {
    const deps = makeDeps();
    listSessions(deps, { workingDir: "/tmp/proj" });
    expect(deps.sessionStore.listByWorkingDir).toHaveBeenCalled();
    listSessions(deps, {});
    expect(deps.sessionStore.listRecent).toHaveBeenCalled();
  });

  it("throws not_found for an unknown session", () => {
    const deps = makeDeps();
    (deps.sessionStore.load as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => getSession(deps, "missing")).toThrow(RuntimeApiError);
  });

  it("reports whether a deleted session existed", () => {
    const deps = makeDeps();
    expect(deleteSession(deps, "s-1")).toEqual({ deleted: true });
    (deps.sessionStore.load as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(deleteSession(deps, "s-1")).toEqual({ deleted: false });
    expect(deps.sessionStore.delete).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-positive limit", () => {
    const deps = makeDeps();
    expect(() => listSessions(deps, { limit: -1 })).toThrow(RuntimeApiError);
  });
});
