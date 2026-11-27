import { describe, expect, it } from "vitest";

import type { SessionState } from "../session/session-state.js";
import type { SessionSummary } from "../session/session-summary.js";
import { loadResumeSession, type ResumeSessionStore } from "./run-resume-session.js";

/** ATO-2307: which saved chat `run --resume` / `--continue` goes on with. */
describe("loadResumeSession", () => {
  const rows = [
    { id: "s-new-other", workingDir: "/other" },
    { id: "s-here-2", workingDir: "/here" },
    { id: "s-here-1", workingDir: "/here" },
  ] as unknown as SessionSummary[];
  const store: ResumeSessionStore = {
    load: (id: string) =>
      rows.some((r) => r.id === id) ? ({ id } as unknown as SessionState) : null,
    listSummaryPage: () => rows,
  };

  it("--continue takes the newest chat of this folder, not a newer one elsewhere", () => {
    expect(loadResumeSession(store, "latest", "/here")).toEqual({ id: "s-here-2" });
  });

  it("--continue refuses when this folder has no chat", () => {
    expect(loadResumeSession(store, "latest", "/empty")).toEqual({
      error: "there is no saved chat in /empty to continue",
    });
  });

  it("--resume takes an exact id or a unique prefix, and names what it could not find", () => {
    expect(loadResumeSession(store, "s-here-1", "/x")).toEqual({ id: "s-here-1" });
    expect(loadResumeSession(store, "s-new", "/x")).toEqual({ id: "s-new-other" });
    expect(loadResumeSession(store, "s-here", "/x")).toMatchObject({
      error: expect.stringContaining("more than one chat"),
    });
    expect(loadResumeSession(store, "s-zzz", "/x")).toEqual({ error: "no chat with id s-zzz" });
  });
});
