import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readInterviewInviteState,
  TERMINAL_INVITE_LINE,
  updateInterviewInviteState,
} from "../../analytics/index.js";
import { createInterviewInviteController, type InterviewInviteDeps } from "./interview-invite-controller.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 12);
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("interview invite controller (terminal)", () => {
  let dir: string;
  let lines: string[];
  let events: Array<[string, Record<string, unknown>]>;
  let opened: string[];
  let flag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "invite-ctl-"));
    lines = [];
    events = [];
    opened = [];
    flag = vi.fn(async () => true);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function make(over: Partial<InterviewInviteDeps> = {}, identity: { installId: string; daysSinceInstall: number | undefined } | null = { installId: ID, daysSinceInstall: 30 }) {
    return createInterviewInviteController({
      runtime: {
        interviewInviteIdentity: () => identity,
        reportInterviewInvite: (kind, props) => events.push([kind, props]),
      },
      stateDir: dir,
      emitLine: (t) => lines.push(t),
      openUrl: async (url) => {
        opened.push(url);
        return { ok: true };
      },
      isBusy: () => false,
      sawError: () => false,
      env: {},
      now: () => NOW,
      flagEnabled: flag as unknown as (id: string) => Promise<boolean>,
      ...over,
    });
  }

  it("shows the one quiet line, records it and reports it", async () => {
    await expect(make().maybeShowAtStart({ onboarding: false })).resolves.toBe(true);
    expect(lines).toEqual([TERMINAL_INVITE_LINE]);
    expect(events).toEqual([["shown", { via: "banner" }]]);
    expect(readInterviewInviteState(dir).shownAt).toEqual([NOW]);
    expect(flag).toHaveBeenCalledWith(ID);
  });

  it("does not show again in the next 90 days (no flag call either)", async () => {
    await make().maybeShowAtStart({ onboarding: false });
    flag.mockClear();
    lines = [];
    await expect(make({ now: () => NOW + 30 * DAY }).maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    expect(lines).toEqual([]);
    expect(flag).not.toHaveBeenCalled();
  });

  it("asks nothing and shows nothing with analytics off or DO_NOT_TRACK", async () => {
    await expect(make({}, null).maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    await expect(make({ env: { DO_NOT_TRACK: "1" } }).maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    expect(flag).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
    expect(events).toEqual([]);
  });

  it("shows nothing when the flag is off", async () => {
    flag.mockResolvedValue(false);
    await expect(make().maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    expect(lines).toEqual([]);
    expect(readInterviewInviteState(dir).shownAt).toEqual([]);
  });

  it("shows nothing during first-run setup, a turn, or after an error", async () => {
    await expect(make().maybeShowAtStart({ onboarding: true })).resolves.toBe(false);
    await expect(make({ isBusy: () => true }).maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    await expect(make({ sawError: () => true }).maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    expect(flag).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("holds the line back when a turn started while the flag was asked", async () => {
    let busy = false;
    flag.mockImplementation(async () => {
      busy = true;
      return true;
    });
    await expect(make({ isBusy: () => busy }).maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    expect(lines).toEqual([]);
    expect(readInterviewInviteState(dir).shownAt).toEqual([]);
  });

  it("shows nothing for an install younger than 7 days", async () => {
    await expect(make({}, { installId: ID, daysSinceInstall: 3 }).maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    expect(flag).not.toHaveBeenCalled();
  });

  it("/feedback never stores the refusal for good and reports it", async () => {
    await make().runFeedback("never");
    expect(readInterviewInviteState(dir).neverAt).toBe(NOW);
    expect(events).toEqual([["dismissed", { reason: "never" }]]);
    lines = [];
    await expect(make({ now: () => NOW + 1000 * DAY }).maybeShowAtStart({ onboarding: false })).resolves.toBe(false);
    expect(lines).toEqual([]);
  });

  it("/feedback opens the form with the id, prints the link, reports via slash", async () => {
    await make().runFeedback("open");
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!);
    expect(url.searchParams.get("iid")).toBe(ID);
    expect(url.searchParams.get("src")).toBe("app-terminal");
    expect(lines.some((l) => l.includes(opened[0]!))).toBe(true);
    expect(events).toEqual([["clicked", { via: "slash" }]]);
  });

  it("reports via menu from the Help menu, and via banner after the line", async () => {
    await make().runFeedback("open", "menu");
    expect(events.at(-1)).toEqual(["clicked", { via: "menu" }]);
    const ctl = make();
    await ctl.maybeShowAtStart({ onboarding: false });
    await ctl.runFeedback("open");
    expect(events.at(-1)).toEqual(["clicked", { via: "banner" }]);
  });

  it("/feedback still works with analytics off, without the id", async () => {
    await make({}, null).runFeedback("open");
    const url = new URL(opened[0]!);
    expect(url.searchParams.has("iid")).toBe(false);
    expect(url.searchParams.get("src")).toBe("app-terminal");
  });

  it("/feedback works even after don't ask again (the permanent entry has no limits)", async () => {
    updateInterviewInviteState(dir, () => ({ shownAt: [1, 2], neverAt: 3 }));
    await make().runFeedback("open");
    expect(opened).toHaveLength(1);
  });

  it("prints the link when the browser cannot be opened (SSH)", async () => {
    await make({ openUrl: async () => ({ ok: false, reason: "no display" }) }).runFeedback("open");
    expect(lines.some((l) => l.includes("tally.so/r/bZjNb6"))).toBe(true);
    expect(lines.some((l) => l.includes("no display"))).toBe(true);
  });
});
