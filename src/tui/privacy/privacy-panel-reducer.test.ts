import { describe, expect, it } from "vitest";

import { createInitialTuiState } from "../tui-state.js";
import type { TuiSessionInfo } from "../tui-state.js";
import { reducePrivacyAction } from "./privacy-panel-reducer.js";

function baseState() {
  const session: TuiSessionInfo = {
    sessionId: null,
    workingDir: "/tmp",
    llamaUrl: "http://localhost:19091",
    browserChannel: "chrome",
    browserHeadless: true,
    approvalRequired: false,
    maxSteps: 20,
    skillCount: 0,
  };
  return createInitialTuiState(session);
}

describe("reducePrivacyAction", () => {
  it("returns null for actions from other slices", () => {
    const state = baseState();
    expect(reducePrivacyAction(state, { type: "tab_changed" })).toBeNull();
  });

  it("folds privacy_synced into the persisted mirror", () => {
    const state = baseState();
    const next = reducePrivacyAction(state, {
      type: "privacy_synced",
      analyticsEnabled: false,
      approveEverything: false,
    });
    expect(next?.privacyPanel.analyticsEnabled).toBe(false);
    expect(next?.privacyPanel.approveEverything).toBe(false);
  });

  it("folds approveEverything=true from privacy_synced and back", () => {
    const on = reducePrivacyAction(baseState(), {
      type: "privacy_synced",
      analyticsEnabled: true,
      approveEverything: true,
    });
    expect(on?.privacyPanel.approveEverything).toBe(true);
    const off = reducePrivacyAction(on!, {
      type: "privacy_synced",
      analyticsEnabled: true,
      approveEverything: false,
    });
    expect(off?.privacyPanel.approveEverything).toBe(false);
  });

  it("marks busy on action_started and clears it on settled", () => {
    const started = reducePrivacyAction(baseState(), {
      type: "privacy_action_started",
    });
    expect(started?.privacyPanel.busy).toBe(true);
    const settled = reducePrivacyAction(started!, {
      type: "privacy_action_settled",
      message: "analytics disabled",
    });
    expect(settled?.privacyPanel.busy).toBe(false);
    expect(settled?.privacyPanel.message).toBe("analytics disabled");
  });

  it("records the error and clears busy on a failed settle", () => {
    const started = reducePrivacyAction(baseState(), {
      type: "privacy_action_started",
    });
    const settled = reducePrivacyAction(started!, {
      type: "privacy_action_settled",
      error: "boom",
    });
    expect(settled?.privacyPanel.busy).toBe(false);
    expect(settled?.privacyPanel.lastError).toBe("boom");
  });

  it("clears message + error on privacy_message_cleared", () => {
    const withMsg = reducePrivacyAction(baseState(), {
      type: "privacy_action_settled",
      message: "analytics enabled",
      error: "old error",
    });
    const cleared = reducePrivacyAction(withMsg!, {
      type: "privacy_message_cleared",
    });
    expect(cleared?.privacyPanel.message).toBeNull();
    expect(cleared?.privacyPanel.lastError).toBeNull();
  });
});
