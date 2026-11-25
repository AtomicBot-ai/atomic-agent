import { describe, expect, it } from "vitest";

import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import {
  countReplanCadenceStep,
  replanCadenceEnabled,
  replanCadenceNotice,
  resetReplanCadence,
  takeReplanCadenceNotice,
} from "./replan-cadence.js";

function session(extra: Partial<SessionState> = {}): SessionState {
  return { ...createEmptySessionState({ id: "s-replan", workingDir: "/work" }), ...extra };
}

const SHELL_OK = [{ tool: "os.shell.run", status: "ok" }];
const PLAN_OK = [{ tool: "plan.update", status: "ok" }];
const PLAN_ERROR = [{ tool: "plan.update", status: "error" }];

describe("re-plan cadence (ATO-609)", () => {
  it("is off at 0 and for nonsense values", () => {
    expect(replanCadenceEnabled(0)).toBe(false);
    expect(replanCadenceEnabled(-3)).toBe(false);
    expect(replanCadenceEnabled(Number.NaN)).toBe(false);
    expect(replanCadenceEnabled(5)).toBe(true);
  });

  it("never writes the counter or a notice while off", () => {
    const state = session({ stepsSinceReplan: 99 });
    expect(countReplanCadenceStep(state, 0, SHELL_OK)).toBe(state);
    expect(resetReplanCadence(state, 0)).toBe(state);
    expect(takeReplanCadenceNotice(state, 0)).toEqual({ state, notice: undefined });
    const fresh = session();
    expect(countReplanCadenceStep(fresh, 0, SHELL_OK)).not.toHaveProperty("stepsSinceReplan");
  });

  it("counts completed steps and asks once the count reaches N", () => {
    let state = session();
    for (let step = 0; step < 3; step += 1) {
      expect(takeReplanCadenceNotice(state, 3).notice).toBeUndefined();
      state = countReplanCadenceStep(state, 3, SHELL_OK);
    }
    expect(state.stepsSinceReplan).toBe(3);
    const taken = takeReplanCadenceNotice(state, 3);
    expect(taken.notice).toContain("[plan] 3 steps into this task");
    expect(taken.notice).toContain("plan.update");
    expect(taken.state.stepsSinceReplan).toBe(0);
    // Asked once: the next step does not ask again.
    expect(takeReplanCadenceNotice(taken.state, 3).notice).toBeUndefined();
  });

  it("starts over when the model re-planned on its own, not on a failed call", () => {
    let state = session({ stepsSinceReplan: 2 });
    state = countReplanCadenceStep(state, 3, PLAN_ERROR);
    expect(state.stepsSinceReplan).toBe(3);
    state = countReplanCadenceStep(state, 3, [...SHELL_OK, ...PLAN_OK]);
    expect(state.stepsSinceReplan).toBe(0);
  });

  it("starts over on a new message and leaves a zero counter alone", () => {
    const counted = session({ stepsSinceReplan: 4 });
    expect(resetReplanCadence(counted, 5).stepsSinceReplan).toBe(0);
    const zero = session({ stepsSinceReplan: 0 });
    expect(resetReplanCadence(zero, 5)).toBe(zero);
  });

  it("names the plan's progress when there is one", () => {
    const state = session({
      plan: {
        items: [
          { step: "read the config", status: "done" },
          { step: "write the parser", status: "in_progress" },
          { step: "add tests", status: "pending" },
        ],
        updatedAt: 1,
      },
    });
    const notice = replanCadenceNotice(state, 10);
    expect(notice).toContain("[plan] 10 steps since the plan was last reviewed; it is 1/3 done.");
    expect(notice).toContain("Send the whole list with plan.update");
    expect(notice).not.toContain("no written plan");
  });
});
