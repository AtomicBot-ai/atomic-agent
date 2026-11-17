import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordInviteNever, recordInviteShown } from "./interview-invite.js";
import {
  interviewInvitePath,
  readInterviewInviteState,
  updateInterviewInviteState,
} from "./interview-invite-store.js";

describe("interview invite store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "invite-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a missing or corrupt file as nothing yet", () => {
    expect(readInterviewInviteState(dir)).toEqual({ shownAt: [], neverAt: null });
    writeFileSync(interviewInvitePath(dir), "{not json");
    expect(readInterviewInviteState(dir)).toEqual({ shownAt: [], neverAt: null });
  });

  it("writes a show and a refusal and reads them back", () => {
    expect(updateInterviewInviteState(dir, (s) => recordInviteShown(s, 100))).toEqual({
      shownAt: [100],
      neverAt: null,
    });
    updateInterviewInviteState(dir, (s) => recordInviteNever(s, 200));
    expect(readInterviewInviteState(dir)).toEqual({ shownAt: [100], neverAt: 200 });
    expect(JSON.parse(readFileSync(interviewInvitePath(dir), "utf8"))).toEqual({
      shownAt: [100],
      neverAt: 200,
    });
  });

  it("keeps what the other app wrote meanwhile (desktop and terminal share the file)", () => {
    // The desktop wrote a refusal; the terminal's update only adds a show.
    writeFileSync(interviewInvitePath(dir), JSON.stringify({ shownAt: [5], neverAt: 7 }));
    const next = updateInterviewInviteState(dir, () => ({ shownAt: [9], neverAt: null }));
    expect(next).toEqual({ shownAt: [5, 9], neverAt: 7 });
  });

  it("returns null when the folder cannot be written", () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    expect(updateInterviewInviteState(join(blocker, "sub"), (s) => recordInviteShown(s, 1))).toBeNull();
  });
});
