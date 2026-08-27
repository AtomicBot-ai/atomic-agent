import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { CodingMode } from "./coding-mode.js";
import {
  EXECUTE_PLAN_MESSAGE,
  PlanHandoff,
} from "./components/plan-handoff.js";
import { reduceUiAction } from "./reduce-ui-actions.js";
import { finishTurn, startNewRun } from "./reducer-helpers.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "./tui-state.js";

function session(): TuiSessionInfo {
  return {
    sessionId: "s1",
    workingDir: "/tmp/w",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chromium",
    browserHeadless: true,
    approvalLevel: 1,
    maxSteps: 8,
    skillCount: 0,
  };
}

function stateWith(overrides: Partial<TuiState> = {}): TuiState {
  return { ...createInitialTuiState(session()), ...overrides };
}

function frame(width = 76): string {
  const { lastFrame, unmount } = render(
    <Box width={width}>
      <PlanHandoff onExecute={() => {}} onDismiss={() => {}} width={width} />
    </Box>,
  );
  const out = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  unmount();
  return out;
}

/**
 * Plan mode used to end in a dead end: the agent says what it would do
 * and is forbidden from doing any of it, so carrying it out meant
 * finding the mode control, changing it, and remembering what you were
 * going to say — with nothing on screen connecting the plan to any of
 * that.
 */
describe("the plan hand-off bar", () => {
  it("offers exactly the two answers worth offering", () => {
    // Not "which of four modes": the question is how much rope to give
    // the run about to start. Offering `default` would be offering to
    // approve every step of a plan already approved as a whole.
    const body = frame();
    expect(body).toContain("auto");
    expect(body).toContain("bypass permissions");
    expect(body).not.toContain("default");
  });

  it("says that typing is still an option", () => {
    expect(frame()).toContain("type below to change the plan");
  });

  it("offers a way to decline the plan outright", () => {
    // The bar had two buttons and a sentence, and the sentence carried
    // the whole of the third option — which made "I do not want this
    // plan" the only choice with no control attached to it. Typing
    // revises a plan; it is not how you drop one.
    expect(frame()).toContain("dismiss plan");
  });

  it("stacks rather than truncating a verb that starts work", () => {
    const narrow = frame(60).split("\n");
    expect(narrow.some((l) => l.includes("run it · auto"))).toBe(true);
    expect(
      narrow.some((l) => l.includes("run it · bypass permissions")),
      "the bypass button kept its full label",
    ).toBe(true);
    expect(narrow.some((l) => l.includes("dismiss plan"))).toBe(true);
  });

  it("hands the chosen mode to its caller", () => {
    const onExecute = vi.fn<(mode: CodingMode) => void>();
    const { unmount } = render(
      <Box width={76}>
        <PlanHandoff onExecute={onExecute} onDismiss={() => {}} width={76} />
      </Box>,
    );
    // No mouse provider here, so the faces render without targets — the
    // click path is covered by the app-level mouse tests. What matters
    // for this file is that the labels and the wiring exist.
    unmount();
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("tells the model its tools work again", () => {
    // The model has just been told, by every refusal in the turn behind
    // it, that its tools do not work. Without saying otherwise the
    // likeliest next step is another plan.
    expect(EXECUTE_PLAN_MESSAGE).toContain("Plan mode is off now");
    expect(EXECUTE_PLAN_MESSAGE).toContain("make the changes");
  });
});

describe("when the offer appears", () => {
  it("appears when a turn completes in plan mode", () => {
    const after = finishTurn(stateWith({ codingMode: "plan" }), "completed", 3);
    expect(after.planHandoff).toBe(true);
  });

  it("stays away in every other mode", () => {
    for (const mode of ["default", "auto", "bypass"] as const) {
      expect(finishTurn(stateWith({ codingMode: mode }), "completed", 3).planHandoff)
        .toBe(false);
    }
  });

  it("stays away when the turn did not finish saying it", () => {
    // A cancelled or failed turn leaves nothing to carry out, and
    // offering to run it would offer to run whatever half survived.
    for (const reason of ["cancelled", "failed"]) {
      expect(
        finishTurn(stateWith({ codingMode: "plan" }), reason, 3).planHandoff,
        reason,
      ).toBe(false);
    }
  });

  it("goes away when the next turn starts", () => {
    const showing = stateWith({ codingMode: "plan", planHandoff: true });
    expect(startNewRun(showing).planHandoff).toBe(false);
  });

  it("goes away when the mode changes by any route", () => {
    // It names plan mode in its own copy; an "it stays in plan mode"
    // hint under a chip reading `auto` is simply wrong.
    const showing = stateWith({ codingMode: "plan", planHandoff: true });
    const next = reduceUiAction(showing, {
      type: "coding_mode_cycled",
      mode: "auto",
    });
    expect(next?.planHandoff).toBe(false);
  });

  it("survives a mode change that lands back on plan", () => {
    const showing = stateWith({ codingMode: "plan", planHandoff: true });
    const next = reduceUiAction(showing, {
      type: "coding_mode_cycled",
      mode: "plan",
    });
    expect((next ?? showing).planHandoff).toBe(true);
  });
});

describe("dismissing a plan", () => {
  it("puts the bar away", () => {
    const showing = stateWith({ codingMode: "plan", planHandoff: true });
    const next = reduceUiAction(showing, { type: "plan_handoff_dismissed" });
    expect(next?.planHandoff).toBe(false);
  });

  it("leaves the mode alone", () => {
    // Declining this plan is not leaving the mode you are planning in.
    const showing = stateWith({ codingMode: "plan", planHandoff: true });
    const next = reduceUiAction(showing, { type: "plan_handoff_dismissed" });
    expect(next?.codingMode).toBe("plan");
  });

  it("is inert when no plan is on offer", () => {
    const idle = stateWith({ codingMode: "plan", planHandoff: false });
    const next = reduceUiAction(idle, { type: "plan_handoff_dismissed" });
    expect((next ?? idle).planHandoff).toBe(false);
  });
});
