import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { MouseProvider } from "../mouse/mouse-context.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { SkillsControls } from "./skills-controls.js";

describe("cloud skills mouse controls", () => {
  it("clicks the same global, project and bulk actions as keyboard shortcuts", async () => {
    const state = createInitialTuiState(fakeSession()); state.uiMode = "debug"; state.activeTab = "skills";
    state.skillsPanel = { ...state.skillsPanel, workspace: "/selected", projectSkillsEnabled: true,
      rows: [{ name: "example", description: "Example", version: "1", source: "project", disabled: false }] };
    const registry = new MouseTargetRegistry();
    const callbacks = { onApprovalDecision() {}, onAbort() {}, onQuit() {}, onMessageSubmitted() {},
      onSkillToggleRequested: vi.fn(), onWorkspaceSkillToggleRequested: vi.fn(), onProjectSkillsToggleRequested: vi.fn() };
    const view = render(<MouseProvider registry={registry} getState={() => state} dispatch={() => {}} callbacks={callbacks}>
      <SkillsControls panel={state.skillsPanel} />
    </MouseProvider>);
    try {
      for (const label of ["[w", "[e", "[p"]) {
        let claimed = false;
        for (let tries = 0; tries < 40 && !claimed; tries++) {
          const lines = (view.lastFrame() ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n");
          const y = lines.findIndex(line => line.includes(label)); const x = lines[y]?.indexOf(label) ?? -1;
          if (x >= 0) claimed = registry.dispatch({ kind: "press", button: "left", wheel: null, x, y, shift: false, alt: false, ctrl: false });
          if (!claimed) await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(claimed).toBe(true);
      }
      expect(callbacks.onSkillToggleRequested).toHaveBeenCalledWith("example");
      expect(callbacks.onWorkspaceSkillToggleRequested).toHaveBeenCalledWith("example");
      expect(callbacks.onProjectSkillsToggleRequested).toHaveBeenCalledOnce();
    } finally { view.unmount(); }
  });
});
