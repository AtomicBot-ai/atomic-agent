import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { PrivacyPanel } from "./privacy-panel.js";
import type { PrivacyPanelState } from "../privacy-panel-state.js";

function panelState(
  overrides: Partial<PrivacyPanelState> = {},
): PrivacyPanelState {
  return {
    analyticsEnabled: true,
    approveEverything: false,
    busy: false,
    message: null,
    lastError: null,
    ...overrides,
  };
}

describe("PrivacyPanel — approve everything row", () => {
  it("renders the OFF state with the reassurance wording", () => {
    const { lastFrame } = render(
      <PrivacyPanel panel={panelState({ approveEverything: false })} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("approve everything");
    expect(frame).toContain("off (risky actions ask for approval first)");
    expect(frame).toContain("y — approve");
  });

  it("renders the ON state with the explicit no-asking warning", () => {
    const { lastFrame } = render(
      <PrivacyPanel panel={panelState({ approveEverything: true })} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(
      "on (the agent runs every action without asking)",
    );
  });

  it("names what stays blocked either way (hardline guards)", () => {
    const { lastFrame } = render(
      <PrivacyPanel panel={panelState({ approveEverything: true })} />,
    );
    expect(lastFrame() ?? "").toContain("Hardline guards still");
  });

  it("keeps the analytics row intact next to the new toggle", () => {
    const { lastFrame } = render(
      <PrivacyPanel
        panel={panelState({ analyticsEnabled: false, approveEverything: true })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("anonymous usage");
    expect(frame).toContain("a — analytics on");
    expect(frame).toContain("r — refresh");
  });
});
