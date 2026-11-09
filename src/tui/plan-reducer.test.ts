import { describe, expect, it } from "vitest";

import type { PlanSnapshot } from "../agent/plan/plan-snapshot.js";
import { reduceTuiState } from "./agent-event-reducer.js";
import { createInitialTuiState } from "./tui-state.js";

const session = {
  sessionId: "s1",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  completionMaxTokens: 2048,
  skillCount: 0,
  localBackendConfigured: false,
} as never;

const plan: PlanSnapshot = {
  items: [{ step: "a", status: "done" }, { step: "b", status: "in_progress" }],
  updatedAt: 1,
};
const planEvent = (p: PlanSnapshot, sessionId = "s1") => ({
  type: "agent_event" as const,
  sessionId,
  event: { type: "llm_event" as const, event: { type: "plan_updated" as const, plan: p, stepIndex: 0 } },
});

describe("live plan in the TUI state (ATO-486)", () => {
  it("starts with no plan", () => {
    expect(createInitialTuiState(session).plan).toBeNull();
  });

  it("follows plan_updated of the session on screen", () => {
    const state = reduceTuiState(createInitialTuiState(session), planEvent(plan));
    expect(state.plan).toEqual(plan);
  });

  it("hides the plan when it is cleared", () => {
    const withPlan = reduceTuiState(createInitialTuiState(session), planEvent(plan));
    const cleared = reduceTuiState(withPlan, planEvent({ items: [], updatedAt: 2 }));
    expect(cleared.plan).toBeNull();
  });

  it("ignores a background session's plan", () => {
    const state = reduceTuiState(createInitialTuiState(session), planEvent(plan, "other"));
    expect(state.plan).toBeNull();
  });

  it("restores the plan of the session switched to, and drops it for one without", () => {
    const switched = reduceTuiState(createInitialTuiState(session), {
      type: "session_switched",
      sessionId: "s2",
      workingDir: "/tmp",
      messages: [],
      plan,
    });
    expect(switched.plan).toEqual(plan);
    const fresh = reduceTuiState(switched, {
      type: "session_switched",
      sessionId: "s3",
      workingDir: "/tmp",
      messages: [],
    });
    expect(fresh.plan).toBeNull();
  });
});
