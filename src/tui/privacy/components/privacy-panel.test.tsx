import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { PrivacyPanel } from "./privacy-panel.js";
import type { PrivacyPanelState } from "../privacy-panel-state.js";

function panelState(
  overrides: Partial<PrivacyPanelState> = {},
): PrivacyPanelState {
  return {
    analyticsEnabled: true,
    busy: false,
    message: null,
    lastError: null,
    sessionGrants: { categories: [], shapes: [] },
    offline: { supported: false, enabled: false, egress: null },
    ...overrides,
  };
}

/** Ink wraps long copy at the terminal width; collapse whitespace so
 * assertions match the sentence, not the accidental line breaks. */
function flat(frame: string | undefined): string {
  return (frame ?? "").replace(/\s+/g, " ");
}

function renderFlat(overrides: Partial<PrivacyPanelState> = {}): string {
  return flat(
    render(<PrivacyPanel panel={panelState(overrides)} />).lastFrame(),
  );
}

describe("PrivacyPanel", () => {
  it("no longer renders an approvals section or ladder hotkeys", () => {
    // The approval stance is the coding-mode control in the composer;
    // this tab keeps only analytics + the read-only session grants.
    const frame = renderFlat();
    expect(frame).not.toContain("Approvals");
    expect(frame).not.toContain("approval level");
    expect(frame).not.toContain("1-5: set approval level");
  });

  it("lists active session grants, and says none when there are none", () => {
    // Default fixture has no grants → the read-only section says so.
    const empty = renderFlat();
    expect(empty).toContain("Session grants");
    expect(empty).toContain("none active");

    const withGrants = renderFlat({
      sessionGrants: { categories: ["shell", "http"], shapes: ["git"] },
    });
    expect(withGrants).toContain("shell command");
    expect(withGrants).toContain("HTTP request");
    expect(withGrants).toContain("git");
    expect(withGrants).toContain("never persisted");
  });

  it("keeps the analytics row and its hotkey hints", () => {
    const frame = renderFlat({ analyticsEnabled: false });
    expect(frame).toContain("anonymous usage");
    expect(frame).toContain("a: analytics on");
    expect(frame).toContain("r: refresh");
  });

  it("says offline mode is not available when the agent has no kill switch", () => {
    const frame = renderFlat();
    expect(frame).toContain("Offline mode");
    expect(frame).toContain("not available in this agent build");
    expect(frame).not.toContain("o: offline");
    expect(frame).not.toContain("sent out");
  });

  it("shows the agent's own counter, not a fixed zero", () => {
    const since = "2026-11-12T10:00:00.000Z";
    const frame = renderFlat({
      offline: {
        supported: true,
        enabled: false,
        egress: { bytesOut: 2048, requestsOut: 3, requestsBlocked: 0, since },
      },
    });
    expect(frame).toContain("offline mode off");
    expect(frame).toContain("2 KB sent out since");
    expect(frame).not.toContain("0 bytes");
    expect(frame).toContain("o: offline on");

    const on = renderFlat({
      offline: {
        supported: true,
        enabled: true,
        egress: { bytesOut: 0, requestsOut: 0, requestsBlocked: 4, since },
      },
    });
    expect(on).toContain("offline mode on");
    expect(on).toContain("0 bytes sent out since");
    expect(on).toContain("4 requests blocked");
    expect(on).toContain("o: offline off");
  });

  it("says so when the agent gave no readable counter", () => {
    const frame = renderFlat({
      offline: { supported: true, enabled: true, egress: null },
    });
    expect(frame).toContain("could not read the outbound counter");
    expect(frame).not.toContain("sent out since");
  });
});
