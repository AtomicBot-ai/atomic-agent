import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { buildReport } from "../../import/index.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import { arrowKey, plainKey, returnKey } from "../mouse/synthetic-key.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import type { OnboardingImportPlan } from "./import-step.js";
import { handleOnboardingStepKey } from "./onboarding-step-keys.js";
import {
  createOnboardingState,
  type OnboardingStep,
} from "./onboarding-state.js";

function escKey(): Key {
  return { ...returnKey(), return: false, escape: true };
}

const AGENTS = [
  { id: "hermes" as const, label: "Hermes", dir: "/h", enabled: true },
  {
    id: "claude-code" as const,
    label: "Claude Code",
    dir: "/c",
    enabled: true,
  },
];

// Pick-screen row indices for the AGENTS fixture with both ticked:
// 0-1 the agents, 2 the import row, 3 the skip row (always last).
const IMPORT_ROW = 2;
const SKIP_ROW = 3;

function stateAt(
  step: OnboardingStep,
  over: Partial<NonNullable<TuiState["onboarding"]>> = {},
): TuiState {
  const onboarding = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step,
    outcome: "local" as const,
    importAgents: AGENTS,
    ...over,
  };
  return { ...createInitialTuiState(fakeSession(), 50), onboarding };
}

interface Driven {
  actions: TuiAction[];
  runs: OnboardingImportPlan[];
  handle(input: string, key: Key): boolean;
}

function drive(state: TuiState): Driven {
  const actions: TuiAction[] = [];
  const runs: Driven["runs"] = [];
  return {
    actions,
    runs,
    handle: (input, key) =>
      handleOnboardingStepKey(input, key, {
        state,
        dispatch: (action) => actions.push(action),
        callbacks: {
          onOnboardingImportRequested: (plan) => runs.push(plan),
        },
      }),
  };
}

describe("import flow reducer", () => {
  it("opens the pick screen with the detected agents", () => {
    const state = reduceTuiState(stateAt("finished"), {
      type: "onboarding_import_opened",
      agents: AGENTS,
    });
    expect(state.onboarding?.step).toBe("import_pick");
    expect(state.onboarding?.importAgents).toHaveLength(2);
    expect(state.onboarding?.cursor).toBe(0);
  });

  it("toggles agent rows by index", () => {
    let state = reduceTuiState(stateAt("finished"), {
      type: "onboarding_import_opened",
      agents: AGENTS,
    });
    state = reduceTuiState(state, {
      type: "onboarding_import_agent_toggled",
      index: 1,
    });
    expect(state.onboarding?.importAgents.map((a) => a.enabled)).toEqual([
      true,
      false,
    ]);
  });

  it("a started run freezes the screen until the report lands", () => {
    const state = reduceTuiState(stateAt("import_pick"), {
      type: "onboarding_import_run_started",
    });
    expect(state.onboarding?.busy).toBe(true);
    expect(state.onboarding?.error).toBeNull();
  });

  it("routes the report straight to import_done — there is no preview", () => {
    const report = buildReport([], true);
    let state = stateAt("import_pick");
    state = reduceTuiState(state, { type: "onboarding_import_run_started" });
    expect(state.onboarding?.busy).toBe(true);
    state = reduceTuiState(state, {
      type: "onboarding_import_report",
      report,
    });
    expect(state.onboarding?.step).toBe("import_done");
    expect(state.onboarding?.busy).toBe(false);
    expect(state.onboarding?.importReport).toBe(report);
  });

  it("drops a late report once the flow moved on", () => {
    const state = reduceTuiState(stateAt("finished"), {
      type: "onboarding_import_report",
      report: buildReport([], true),
    });
    expect(state.onboarding?.step).toBe("finished");
    expect(state.onboarding?.importReport).toBeNull();
  });

  it("surfaces a failed run as an inline error", () => {
    let state = stateAt("import_pick", { busy: true });
    state = reduceTuiState(state, {
      type: "onboarding_import_failed",
      error: "boom",
    });
    expect(state.onboarding?.busy).toBe(false);
    expect(state.onboarding?.error).toBe("boom");
    expect(state.onboarding?.step).toBe("import_pick");
  });
});

describe("import flow keys", () => {
  it("space toggles the agent under the cursor", () => {
    const driven = drive(stateAt("import_pick", { cursor: 1 }));
    expect(driven.handle(" ", plainKey())).toBe(true);
    expect(driven.actions).toEqual([
      { type: "onboarding_import_agent_toggled", index: 1 },
    ]);
  });

  it("enter on a ticked agent row imports the ticked set instead of unticking it", () => {
    const driven = drive(stateAt("import_pick", { cursor: 0 }));
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([{ type: "onboarding_import_run_started" }]);
    expect(driven.runs).toHaveLength(1);
    expect(driven.runs[0]?.agents).toEqual(AGENTS);
  });

  it("enter on an unticked agent row imports the ticked set, leaving that row alone", () => {
    const agents = [AGENTS[0]!, { ...AGENTS[1]!, enabled: false }];
    const driven = drive(
      stateAt("import_pick", { importAgents: agents, cursor: 1 }),
    );
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([{ type: "onboarding_import_run_started" }]);
    expect(driven.runs).toHaveLength(1);
    expect(driven.runs[0]?.agents).toEqual(agents);
    const options = driven.runs[0]!.options;
    expect(options.some((o) => o.agent === "hermes")).toBe(true);
    expect(options.some((o) => o.agent === "claude-code")).toBe(false);
  });

  it("with nothing ticked, enter on an agent row ticks it and imports just that agent", () => {
    const unticked = AGENTS.map((a) => ({ ...a, enabled: false }));
    const driven = drive(
      stateAt("import_pick", { importAgents: unticked, cursor: 1 }),
    );
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_import_agent_toggled", index: 1 },
      { type: "onboarding_import_run_started" },
    ]);
    expect(driven.runs).toHaveLength(1);
    expect(driven.runs[0]?.agents.map((a) => a.enabled)).toEqual([
      false,
      true,
    ]);
    const options = driven.runs[0]!.options;
    expect(options.some((o) => o.agent === "claude-code")).toBe(true);
    expect(options.some((o) => o.agent === "hermes")).toBe(false);
  });

  it("space on a ticked row still only unticks it", () => {
    const driven = drive(stateAt("import_pick", { cursor: 0 }));
    driven.handle(" ", plainKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_import_agent_toggled", index: 0 },
    ]);
    expect(driven.runs).toEqual([]);
  });

  it("enter on the import row imports the ticked agents with the defaults", () => {
    const driven = drive(stateAt("import_pick", { cursor: IMPORT_ROW }));
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([{ type: "onboarding_import_run_started" }]);
    // One run, and it is the write: no dry-run stands between the ticks
    // and the import any more.
    expect(driven.runs).toHaveLength(1);
    expect(driven.runs[0]?.agents).toEqual(AGENTS);
    // Both ticked agents contribute, non-secret domains on, secrets off.
    const options = driven.runs[0]!.options;
    expect(options.some((o) => o.agent === "hermes")).toBe(true);
    expect(options.some((o) => o.agent === "claude-code")).toBe(true);
    expect(options.every((o) => o.enabled === !o.secret)).toBe(true);
  });

  it("enter on the skip row hands over to the agent", () => {
    const driven = drive(stateAt("import_pick", { cursor: SKIP_ROW }));
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_finished", outcome: "local" },
    ]);
    expect(driven.runs).toEqual([]);
  });

  it("with everything unticked the import row does not exist and the list wraps past it", () => {
    const unticked = AGENTS.map((a) => ({ ...a, enabled: false }));
    // Rows are the two agents plus skip; the old skip index wraps to
    // the first agent, so Enter imports that agent rather than nothing.
    const driven = drive(
      stateAt("import_pick", { importAgents: unticked, cursor: SKIP_ROW }),
    );
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_import_agent_toggled", index: 0 },
      { type: "onboarding_import_run_started" },
    ]);
    expect(driven.runs[0]?.agents.map((a) => a.enabled)).toEqual([
      true,
      false,
    ]);
  });

  it("with everything unticked, enter on the skip row still skips", () => {
    const unticked = AGENTS.map((a) => ({ ...a, enabled: false }));
    // Two agents + skip: index 2 is the skip row here.
    const driven = drive(
      stateAt("import_pick", { importAgents: unticked, cursor: 2 }),
    );
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_finished", outcome: "local" },
    ]);
    expect(driven.runs).toEqual([]);
  });

  it("esc skips out of the pick screen with the earned outcome", () => {
    const driven = drive(stateAt("import_pick"));
    driven.handle("", escKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_finished", outcome: "local" },
    ]);
  });

  it("keys freeze while a run is out", () => {
    const driven = drive(stateAt("import_pick", { busy: true }));
    expect(driven.handle("", returnKey())).toBe(true);
    expect(driven.handle("", arrowKey("down"))).toBe(true);
    expect(driven.actions).toEqual([]);
    expect(driven.runs).toEqual([]);
  });

  it("any key on the report screen hands over to the agent", () => {
    const driven = drive(stateAt("import_done"));
    expect(driven.handle("x", plainKey())).toBe(true);
    expect(driven.actions).toEqual([
      { type: "onboarding_finished", outcome: "local" },
    ]);
  });
});
