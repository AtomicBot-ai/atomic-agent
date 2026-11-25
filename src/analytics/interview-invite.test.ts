import { describe, expect, it } from "vitest";

import {
  buildInterviewFormUrl,
  emptyInterviewInviteState,
  INTERVIEW_FORM_URL,
  interviewInviteBlockedBy,
  INVITE_COOLDOWN_DAYS,
  INVITE_MAX_SHOWS,
  INVITE_MIN_DAYS_AFTER_INSTALL,
  mayShareInstallId,
  mergeInterviewInviteStates,
  parseFeatureFlagReply,
  parseInterviewInviteState,
  recordInviteNever,
  recordInviteShown,
  shouldShowInterviewInvite,
  TERMINAL_INVITE_LINE,
  type InterviewInviteContext,
} from "./interview-invite.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function ctx(over: Partial<InterviewInviteContext> = {}): InterviewInviteContext {
  return {
    now: NOW,
    analyticsEnabled: true,
    doNotTrack: false,
    installId: ID,
    daysSinceInstall: 30,
    busy: false,
    onboarding: false,
    error: false,
    state: emptyInterviewInviteState(),
    ...over,
  };
}

describe("interview invite: who may see it", () => {
  it("shows for an eligible install when the flag is on", () => {
    expect(interviewInviteBlockedBy(ctx())).toBeNull();
    expect(shouldShowInterviewInvite(ctx(), true)).toBe(true);
  });

  it("never shows while the flag is off", () => {
    expect(shouldShowInterviewInvite(ctx(), false)).toBe(false);
  });

  it("is blocked first by analytics off and DO_NOT_TRACK (no flag call)", () => {
    expect(interviewInviteBlockedBy(ctx({ analyticsEnabled: false }))).toBe("analytics_off");
    expect(interviewInviteBlockedBy(ctx({ doNotTrack: true }))).toBe("do_not_track");
    // Privacy wins over every other reason.
    expect(
      interviewInviteBlockedBy(ctx({ analyticsEnabled: false, busy: true, daysSinceInstall: 0 })),
    ).toBe("analytics_off");
    expect(shouldShowInterviewInvite(ctx({ doNotTrack: true }), true)).toBe(false);
  });

  it("needs a real install id", () => {
    expect(interviewInviteBlockedBy(ctx({ installId: null }))).toBe("no_install_id");
    expect(interviewInviteBlockedBy(ctx({ installId: "not-an-id" }))).toBe("no_install_id");
  });

  it("never shows again after don't ask again, whatever else holds", () => {
    const state = recordInviteNever(emptyInterviewInviteState(), NOW - 400 * DAY);
    expect(interviewInviteBlockedBy(ctx({ state }))).toBe("never");
    expect(shouldShowInterviewInvite(ctx({ state, now: NOW + 1000 * DAY }), true)).toBe(false);
  });

  it("waits 7 days after install", () => {
    expect(interviewInviteBlockedBy(ctx({ daysSinceInstall: 0 }))).toBe("too_new");
    expect(
      interviewInviteBlockedBy(ctx({ daysSinceInstall: INVITE_MIN_DAYS_AFTER_INSTALL - 1 })),
    ).toBe("too_new");
    expect(
      interviewInviteBlockedBy(ctx({ daysSinceInstall: INVITE_MIN_DAYS_AFTER_INSTALL })),
    ).toBeNull();
    expect(interviewInviteBlockedBy(ctx({ daysSinceInstall: Number.NaN }))).toBe("too_new");
  });

  it("treats an install with no recorded date as old enough", () => {
    expect(interviewInviteBlockedBy(ctx({ daysSinceInstall: undefined }))).toBeNull();
  });

  it("shows at most once per 90 days", () => {
    const once = recordInviteShown(emptyInterviewInviteState(), NOW - 10 * DAY);
    expect(interviewInviteBlockedBy(ctx({ state: once }))).toBe("cooldown");
    const edge = recordInviteShown(emptyInterviewInviteState(), NOW - INVITE_COOLDOWN_DAYS * DAY + 1);
    expect(interviewInviteBlockedBy(ctx({ state: edge }))).toBe("cooldown");
    const old = recordInviteShown(emptyInterviewInviteState(), NOW - INVITE_COOLDOWN_DAYS * DAY);
    expect(interviewInviteBlockedBy(ctx({ state: old }))).toBeNull();
  });

  it("counts a show stamped in the future (clock went back) as recent", () => {
    const future = recordInviteShown(emptyInterviewInviteState(), NOW + 5 * DAY);
    expect(interviewInviteBlockedBy(ctx({ state: future }))).toBe("cooldown");
  });

  it("shows at most 2 times in total, however long ago", () => {
    let state = emptyInterviewInviteState();
    state = recordInviteShown(state, NOW - 400 * DAY);
    expect(interviewInviteBlockedBy(ctx({ state }))).toBeNull();
    state = recordInviteShown(state, NOW - 200 * DAY);
    expect(state.shownAt).toHaveLength(INVITE_MAX_SHOWS);
    expect(interviewInviteBlockedBy(ctx({ state }))).toBe("max_shows");
    expect(interviewInviteBlockedBy(ctx({ state, now: NOW + 10_000 * DAY }))).toBe("max_shows");
  });

  it("walks the whole life of one install: 2 shows, never a third", () => {
    let state = emptyInterviewInviteState();
    let shows = 0;
    for (let day = 0; day < 1000; day++) {
      const c = ctx({ now: NOW + day * DAY, daysSinceInstall: day, state });
      if (shouldShowInterviewInvite(c, true)) {
        shows++;
        state = recordInviteShown(state, c.now);
      }
    }
    expect(shows).toBe(2);
    expect(state.shownAt[0]).toBe(NOW + INVITE_MIN_DAYS_AFTER_INSTALL * DAY);
    expect(state.shownAt[1]! - state.shownAt[0]!).toBe(INVITE_COOLDOWN_DAYS * DAY);
  });

  it("never shows during a turn, first-run setup or an error", () => {
    expect(interviewInviteBlockedBy(ctx({ onboarding: true }))).toBe("onboarding");
    expect(interviewInviteBlockedBy(ctx({ busy: true }))).toBe("busy");
    expect(interviewInviteBlockedBy(ctx({ error: true }))).toBe("error");
    for (const over of [{ onboarding: true }, { busy: true }, { error: true }]) {
      expect(shouldShowInterviewInvite(ctx(over), true)).toBe(false);
    }
  });
});

describe("interview invite: state file", () => {
  it("reads anything malformed as nothing yet", () => {
    for (const raw of [null, undefined, 3, "x", [], { shownAt: "no" }]) {
      expect(parseInterviewInviteState(raw)).toEqual({ shownAt: [], neverAt: null });
    }
  });

  it("keeps only finite timestamps, oldest first", () => {
    expect(parseInterviewInviteState({ shownAt: [30, "a", 10, Number.NaN, null, 20] }).shownAt).toEqual([
      10, 20, 30,
    ]);
  });

  it("never loses a refusal to a corrupt field", () => {
    expect(parseInterviewInviteState({ neverAt: "yes" }).neverAt).toBe(0);
    expect(parseInterviewInviteState({ neverAt: true }).neverAt).toBe(0);
    expect(parseInterviewInviteState({ neverAt: 5 }).neverAt).toBe(5);
    expect(parseInterviewInviteState({ neverAt: null }).neverAt).toBeNull();
    expect(parseInterviewInviteState({ neverAt: false }).neverAt).toBeNull();
  });

  it("merges two copies: shows once each, a refusal on either side wins", () => {
    const merged = mergeInterviewInviteStates(
      { shownAt: [1, 3], neverAt: null },
      { shownAt: [3, 2], neverAt: 9 },
    );
    expect(merged).toEqual({ shownAt: [1, 2, 3], neverAt: 9 });
    expect(mergeInterviewInviteStates({ shownAt: [], neverAt: 4 }, { shownAt: [], neverAt: 9 }).neverAt).toBe(4);
  });

  it("recording a show does not undo a refusal", () => {
    const state = recordInviteShown(recordInviteNever(emptyInterviewInviteState(), 1), 2);
    expect(state).toEqual({ shownAt: [2], neverAt: 1 });
  });
});

describe("interview invite: form link", () => {
  it("carries the install id and the source when analytics is on", () => {
    const url = new URL(
      buildInterviewFormUrl({ source: "app-terminal", installId: ID, analyticsEnabled: true, doNotTrack: false }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(INTERVIEW_FORM_URL);
    expect(url.searchParams.get("iid")).toBe(ID);
    expect(url.searchParams.get("src")).toBe("app-terminal");
    expect([...url.searchParams.keys()].sort()).toEqual(["iid", "src"]);
  });

  it("drops the id when analytics is off or DO_NOT_TRACK is set", () => {
    for (const over of [{ analyticsEnabled: false, doNotTrack: false }, { analyticsEnabled: true, doNotTrack: true }]) {
      const url = new URL(buildInterviewFormUrl({ source: "app-desktop", installId: ID, ...over }));
      expect(url.searchParams.has("iid")).toBe(false);
      expect(url.searchParams.get("src")).toBe("app-desktop");
    }
  });

  it("never puts something that is not an install id in the link", () => {
    const url = new URL(
      buildInterviewFormUrl({ source: "app-terminal", installId: "me@example.com", analyticsEnabled: true, doNotTrack: false }),
    );
    expect(url.searchParams.has("iid")).toBe(false);
    expect(mayShareInstallId({ analyticsEnabled: true, doNotTrack: false, installId: undefined })).toBe(false);
  });

  it("terminal line names the command and how to hide it", () => {
    expect(TERMINAL_INVITE_LINE).toContain("/feedback");
    expect(TERMINAL_INVITE_LINE).toContain("/feedback never");
    expect(TERMINAL_INVITE_LINE).toContain("$50");
  });
});

describe("interview invite: PostHog flag reply", () => {
  it("reads the v2 shape", () => {
    expect(parseFeatureFlagReply({ flags: { "interview-invite": { enabled: true } } }, "interview-invite")).toBe(true);
    expect(parseFeatureFlagReply({ flags: { "interview-invite": { enabled: false } } }, "interview-invite")).toBe(false);
    expect(parseFeatureFlagReply({ flags: {} }, "interview-invite")).toBe(false);
  });

  it("reads the older featureFlags shape", () => {
    expect(parseFeatureFlagReply({ featureFlags: { "interview-invite": true } }, "interview-invite")).toBe(true);
    expect(parseFeatureFlagReply({ featureFlags: { "interview-invite": "group-a" } }, "interview-invite")).toBe(true);
    expect(parseFeatureFlagReply({ featureFlags: { "interview-invite": false } }, "interview-invite")).toBe(false);
  });

  it("reads anything else as off", () => {
    for (const body of [null, "x", 1, {}, { flags: null }, { featureFlags: { other: true } }]) {
      expect(parseFeatureFlagReply(body, "interview-invite")).toBe(false);
    }
  });
});
