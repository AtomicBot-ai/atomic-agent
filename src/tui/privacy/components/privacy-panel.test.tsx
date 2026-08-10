import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { PrivacyPanel } from "./privacy-panel.js";
import type { ApprovalLevel } from "../../../approval/approval-level.js";
import type { PrivacyPanelState } from "../privacy-panel-state.js";

function panelState(
  overrides: Partial<PrivacyPanelState> = {},
): PrivacyPanelState {
  return {
    analyticsEnabled: true,
    approvalLevel: 1,
    busy: false,
    message: null,
    lastError: null,
    ...overrides,
  };
}

/** Ink wraps long copy at the terminal width; collapse whitespace so
 * assertions match the sentence, not the accidental line breaks. */
function flat(frame: string | undefined): string {
  return (frame ?? "").replace(/\s+/g, " ");
}

function frameAt(level: ApprovalLevel): string {
  return flat(
    render(
      <PrivacyPanel panel={panelState({ approvalLevel: level })} />,
    ).lastFrame(),
  );
}

describe("PrivacyPanel — approval level row", () => {
  it("renders every level with its name and summary", () => {
    expect(frameAt(1)).toContain("1 (paranoid) · every gated action asks first");
    expect(frameAt(2)).toContain(
      "2 (workspace) · writes inside the project run without asking",
    );
    expect(frameAt(3)).toContain("3 (home)");
    expect(frameAt(4)).toContain("4 (operator)");
    expect(frameAt(5)).toContain(
      "5 (full trust) · the agent runs every action without asking",
    );
  });

  it("level 1 lists the full asking surface, never underselling the gate", () => {
    // The user-facing coverage list may never undersell the internal
    // category table in approval-level.ts (shell, file writes and
    // deletes, HTTP, process kills, script runs, browser navigation to
    // non-web URLs).
    const frame = frameAt(1);
    expect(frame).toContain("shell commands");
    expect(frame).toContain("file writes and deletes");
    expect(frame).toContain("HTTP requests");
    expect(frame).toContain("process kills");
    expect(frame).toContain("script runs");
    expect(frame).toContain("browser navigation");
    expect(frame).toContain("file://");
    expect(frame).toContain("javascript:");
  });

  it("mid-ladder levels accumulate their coverage copy honestly", () => {
    const l2 = frameAt(2);
    expect(l2).toContain("inside the project directory");
    expect(l2).toContain("symlinks pointing outside still ask");

    const l3 = frameAt(3);
    expect(l3).toContain("inside the project directory");
    expect(l3).toContain("home directory");
    expect(l3).toContain("Trash");
    expect(l3).toContain("archive extraction");
    expect(l3).toContain("HTTP requests");
    expect(l3).toContain("SSRF guard stays on");

    const l4 = frameAt(4);
    expect(l4).toContain("inside the project directory");
    expect(l4).toContain("home directory");
    expect(l4).toContain("shell commands the guard flags for approval");
    expect(l4).toContain("skill scripts");
    expect(l4).toContain("process kills");
  });

  it("names what stays blocked at every level (hardline guards)", () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      expect(frameAt(level)).toContain("Hardline guards still block");
    }
  });

  it("keeps the analytics row intact next to the ladder", () => {
    const { lastFrame } = render(
      <PrivacyPanel
        panel={panelState({ analyticsEnabled: false, approvalLevel: 3 })}
      />,
    );
    const frame = flat(lastFrame());
    expect(frame).toContain("anonymous usage");
    expect(frame).toContain("a: analytics on");
    expect(frame).toContain("r: refresh");
    expect(frame).toContain("1-5: set approval level");
  });
});
