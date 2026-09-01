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
import { createOnboardingState, type OnboardingStep } from "./onboarding-state.js";

function escKey(): Key {
  return { ...returnKey(), return: false, escape: true };
}

const AGENTS = [
  { id: "hermes" as const, label: "Hermes", dir: "/h", enabled: true },
  { id: "claude-code" as const, label: "Claude Code", dir: "/c", enabled: true },
];

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
  runs: Array<{ plan: OnboardingImportPlan; execute: boolean }>;
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
          onOnboardingImportRequested: (plan, execute) =>
            runs.push({ plan, execute }),
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

  it("toggles agent and option rows by index", () => {
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

    state = reduceTuiState(state, {
      type: "onboarding_import_options_opened",
      options: [
        {
          agent: "hermes",
          agentLabel: "Hermes",
          option: "sessions",
          label: "Sessions",
          description: "d",
          secret: false,
          enabled: true,
        },
      ],
    });
    expect(state.onboarding?.step).toBe("import_options");
    state = reduceTuiState(state, {
      type: "onboarding_import_option_toggled",
      index: 0,
    });
    expect(state.onboarding?.importOptions[0]?.enabled).toBe(false);
  });

  it("routes a preview report to import_preview and an executed one to import_done", () => {
    const report = buildReport([], false);
    let state = stateAt("import_options");
    state = reduceTuiState(state, { type: "onboarding_import_run_started" });
    expect(state.onboarding?.busy).toBe(true);
    state = reduceTuiState(state, {
      type: "onboarding_import_report",
      report,
      executed: false,
    });
    expect(state.onboarding?.step).toBe("import_preview");
    expect(state.onboarding?.busy).toBe(false);
    expect(state.onboarding?.importReport).toBe(report);

    const done = reduceTuiState(state, {
      type: "onboarding_import_report",
      report: buildReport([], true),
      executed: true,
    });
    expect(done.onboarding?.step).toBe("import_done");
  });

  it("drops a late report once the flow moved on", () => {
    const state = reduceTuiState(stateAt("finished"), {
      type: "onboarding_import_report",
      report: buildReport([], false),
      executed: false,
    });
    expect(state.onboarding?.step).toBe("finished");
    expect(state.onboarding?.importReport).toBeNull();
  });

  it("surfaces a failed run as an inline error", () => {
    let state = stateAt("import_options", { busy: true });
    state = reduceTuiState(state, {
      type: "onboarding_import_failed",
      error: "boom",
    });
    expect(state.onboarding?.busy).toBe(false);
    expect(state.onboarding?.error).toBe("boom");
    expect(state.onboarding?.step).toBe("import_options");
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

  it("enter on the pick screen opens the option toggles for the picked agents", () => {
    const driven = drive(stateAt("import_pick"));
    driven.handle("", returnKey());
    expect(driven.actions).toHaveLength(1);
    const action = driven.actions[0]!;
    if (action.type !== "onboarding_import_options_opened") {
      throw new Error(`unexpected ${action.type}`);
    }
    expect(action.options.some((o) => o.agent === "hermes")).toBe(true);
    expect(action.options.some((o) => o.agent === "claude-code")).toBe(true);
  });

  it("enter with every agent unticked finishes the flow instead", () => {
    const driven = drive(
      stateAt("import_pick", {
        importAgents: AGENTS.map((a) => ({ ...a, enabled: false })),
      }),
    );
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_finished", outcome: "local" },
    ]);
  });

  it("esc skips out of the pick screen with the earned outcome", () => {
    const driven = drive(stateAt("import_pick"));
    driven.handle("", escKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_finished", outcome: "local" },
    ]);
  });

  it("enter on the options screen asks the host for a dry-run", () => {
    const options = [
      {
        agent: "hermes" as const,
        agentLabel: "Hermes",
        option: "sessions",
        label: "Sessions",
        description: "d",
        secret: false,
        enabled: true,
      },
    ];
    const driven = drive(stateAt("import_options", { importOptions: options }));
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([{ type: "onboarding_import_run_started" }]);
    expect(driven.runs).toEqual([
      { plan: { agents: AGENTS, options }, execute: false },
    ]);
  });

  it("enter on an actionable preview asks for the write", () => {
    const report = buildReport([{ kind: "Hermes sessions", status: "migrated" }], false);
    const driven = drive(stateAt("import_preview", { importReport: report }));
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([{ type: "onboarding_import_run_started" }]);
    expect(driven.runs.map((r) => r.execute)).toEqual([true]);
  });

  it("enter on an empty preview finishes without writing", () => {
    const report = buildReport([{ kind: "Hermes sessions", status: "skipped" }], false);
    const driven = drive(stateAt("import_preview", { importReport: report }));
    driven.handle("", returnKey());
    expect(driven.actions).toEqual([
      { type: "onboarding_finished", outcome: "local" },
    ]);
    expect(driven.runs).toEqual([]);
  });

  it("keys freeze while a run is out", () => {
    const driven = drive(stateAt("import_options", { busy: true }));
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
