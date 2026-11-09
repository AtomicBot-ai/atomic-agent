import { describe, expect, it } from "vitest";

import { dispatchSlashCommand } from "./commands/slash-command-handler.js";
import {
  formatSessionFusionNotice,
  formatStartupFusionNotice,
} from "./fusion-resume-notice.js";

const run = (runId: string, sessionId: string) => ({
  runId,
  sessionId,
  updatedAt: 1,
  summary: `unfinished Fusion run ${runId}: 1 of 3 tasks done; 2 left`,
});

describe("/fusion (ATO-617)", () => {
  it("lists, resumes and discards", () => {
    expect(dispatchSlashCommand("/fusion").fusionRunAction).toEqual({ action: "list" });
    expect(dispatchSlashCommand("/fusion resume").fusionRunAction).toEqual({ action: "resume" });
    expect(dispatchSlashCommand("/fusion resume fr-1").fusionRunAction).toEqual({
      action: "resume",
      runId: "fr-1",
    });
    expect(dispatchSlashCommand("/fusion discard fr-1").fusionRunAction).toEqual({
      action: "discard",
      runId: "fr-1",
    });
  });

  it("answers a malformed call with its usage", () => {
    for (const buffer of ["/fusion go", "/fusion resume a b", "/fusion fr-1"]) {
      const result = dispatchSlashCommand(buffer);
      expect(result.fusionRunAction).toBeUndefined();
      expect(result.systemMessage).toContain("usage: /fusion");
    }
  });
});

describe("fusion resume notices", () => {
  it("offers the session's own run on open, and says nothing without one", () => {
    expect(formatSessionFusionNotice([])).toBeNull();
    const line = formatSessionFusionNotice([run("fr-1", "s-1")])!;
    expect(line).toMatch(/^Unfinished Fusion run fr-1/);
    expect(line).toContain("/fusion resume");
    expect(line).toContain("/fusion discard");
  });

  it("points at the sessions holding runs at start-up", () => {
    expect(formatStartupFusionNotice([], null)).toBeNull();
    expect(formatStartupFusionNotice([run("fr-1", "s-1")], "s-1")).toBeNull();
    const line = formatStartupFusionNotice([run("fr-1", "s-1"), run("fr-2", "s-2")], null)!;
    expect(line).toContain("2 Fusion runs were cut off");
    expect(line).toContain("s-1");
    expect(line).toContain("/sessions");
  });
});
