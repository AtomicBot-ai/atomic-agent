import { describe, expect, it } from "vitest";

import { reduceTuiState } from "./agent-event-reducer.js";
import { reduceUiAction } from "./reduce-ui-actions.js";
import { fakeSession } from "./test-fixtures.js";
import { createInitialTuiState, type TuiState } from "./tui-state.js";
import type { BuiltPrompt } from "../prompt/build-prompt-types.js";

function prompt(pairsCap: number): BuiltPrompt {
  return {
    text: "",
    stablePrefix: "",
    tail: "",
    tokens: {
      stablePrefix: 100,
      loadedSkills: 0,
      sessionFacts: 0,
      loadedTools: 0,
      profile: 0,
      worldSnapshot: 0,
      conversation: 50,
      recalled: 0,
      memoryIndex: 0,
      taskPolicy: 0,
      total: 150,
    },
    limits: {
      total: 3000,
      stablePrefix: 1050,
      session: 450,
      worldSnapshot: 450,
      conversation: 1050,
    },
    truncated: false,
    truncation: {
      loadedSkills: false,
      sessionFacts: false,
      loadedTools: false,
      profile: false,
      worldSnapshot: false,
      conversation: false,
      recalled: false,
      memoryIndex: false,
    },
    contextWindow: 128_000,
    conversationCapEffective: 32_000,
    conversationCapAuto: false,
    droppedTurns: 0,
    conversationPairs: 1,
    droppedPairs: 0,
    conversationPairsCap: pairsCap,
    conversationBoundBy: null,
    pairCosts: [50],
  };
}

function chose(pairs: number): TuiState {
  return {
    ...createInitialTuiState(fakeSession()),
    // The first-run flow claims every action while it is open, so a
    // reducer test that left it standing would assert nothing.
    onboarding: null,
    contextPanelOpen: true,
    contextPanelPairsDraft: pairs,
  };
}

/**
 * The selector's value is not a draft — every step was already written
 * to the config. It has to outlive the panel, because
 * `conversationPairsCap` still reports whatever the *last* prompt was
 * built against until the next turn rebuilds one. Clearing it on close
 * would reopen the panel showing the number the operator just changed
 * away from, while the config said something else.
 */
describe("the task selection outlives the panel", () => {
  it("survives closing", () => {
    const next = reduceUiAction(chose(5), { type: "context_panel_closed" });
    expect(next?.contextPanelPairsDraft).toBe(5);
  });

  it("survives closing and reopening", () => {
    const closed = reduceUiAction(chose(5), { type: "context_panel_toggled" });
    const reopened = reduceUiAction(closed as TuiState, {
      type: "context_panel_toggled",
    });
    expect(reopened?.contextPanelPairsDraft).toBe(5);
    expect(reopened?.contextPanelOpen).toBe(true);
  });
});

describe("and retires when measurement agrees", () => {
  it("clears once a prompt is built against it", () => {
    // The number on screen does not move — it is simply no longer an
    // override sitting on top of a measurement that says the same thing.
    const after = reduceTuiState(chose(5), {
      type: "agent_event",
      // Step events reach the reducer wrapped in `llm_event`.
      event: { type: "llm_event", event: { type: "prompt_built", prompt: prompt(5) } },
    });
    expect(after.contextPanelPairsDraft).toBeNull();
    expect(after.contextUsage.conversationPairsCap).toBe(5);
  });

  it("stands while the last build still predates the change", () => {
    // A prompt built before the operator moved the selector must not
    // snap it back to the old value in front of them.
    const after = reduceTuiState(chose(5), {
      type: "agent_event",
      event: { type: "llm_event", event: { type: "prompt_built", prompt: prompt(20) } },
    });
    expect(after.contextPanelPairsDraft).toBe(5);
  });
});

/**
 * The action carries the value the caller persisted, not a step to
 * re-derive. Two presses inside one render tick read the same base, so a
 * delta would have the reducer land somewhere the config never did.
 */
describe("selecting a task count", () => {
  it("takes the number it was given", () => {
    const next = reduceUiAction(chose(20), { type: "context_pairs_selected", pairs: 7 });
    expect(next?.contextPanelPairsDraft).toBe(7);
  });

  it("cannot drift when two land before a render", () => {
    // Both presses were decided against the same base of 20; each wrote
    // what it decided. Replaying them must end where the writes did.
    const first = reduceUiAction(chose(20), { type: "context_pairs_selected", pairs: 19 });
    const second = reduceUiAction(first as TuiState, {
      type: "context_pairs_selected",
      pairs: 18,
    });
    expect(second?.contextPanelPairsDraft).toBe(18);
  });

  it("clamps to the range the schema accepts", () => {
    expect(
      reduceUiAction(chose(1), { type: "context_pairs_selected", pairs: 0 })
        ?.contextPanelPairsDraft,
    ).toBe(1);
    expect(
      reduceUiAction(chose(1), { type: "context_pairs_selected", pairs: 500 })
        ?.contextPanelPairsDraft,
    ).toBe(100);
  });

  it("ignores a selection while the panel is closed", () => {
    const shut: TuiState = { ...chose(20), contextPanelOpen: false };
    const next = reduceUiAction(shut, { type: "context_pairs_selected", pairs: 3 });
    expect((next ?? shut).contextPanelPairsDraft).toBe(20);
  });
});
