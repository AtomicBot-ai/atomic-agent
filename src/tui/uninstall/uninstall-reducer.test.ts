import { describe, expect, it } from "vitest";

import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiState } from "../tui-state.js";
import { reduceUninstallAction } from "./uninstall-reducer.js";
import type { UninstallAction } from "./uninstall-actions.js";
import type { UninstallPreview } from "./uninstall-state.js";

const PREVIEW: UninstallPreview = {
  rows: [
    {
      path: "/Users/op/.atomic-agent",
      label: "state",
      size: "1.7 GB",
      group: "data",
    },
  ],
  total: "1.7 GB",
  devCheckout: false,
};

function base(): TuiState {
  return createInitialTuiState(fakeSession());
}

function run(
  state: TuiState,
  ...actions: readonly UninstallAction[]
): TuiState {
  let next = state;
  for (const action of actions) {
    next = reduceUninstallAction(next, action) ?? next;
  }
  return next;
}

describe("uninstall reducer", () => {
  it("declines actions that are not its own", () => {
    expect(reduceUninstallAction(base(), { type: "chat_cleared" })).toBeNull();
  });

  it("opens on the loading step with the cursor on cancel", () => {
    const state = run(base(), { type: "uninstall_opened" });
    expect(state.uninstall?.step).toBe("loading");
    expect(state.uninstall?.cursor).toBe("cancel");
  });

  it("shows the plan once it is measured", () => {
    const state = run(
      base(),
      { type: "uninstall_opened" },
      { type: "uninstall_plan_loaded", preview: PREVIEW },
    );
    expect(state.uninstall?.step).toBe("review");
    expect(state.uninstall?.preview?.total).toBe("1.7 GB");
  });

  it("ignores a plan that arrives after the operator cancelled", () => {
    const state = run(
      base(),
      { type: "uninstall_opened" },
      { type: "uninstall_closed" },
      { type: "uninstall_plan_loaded", preview: PREVIEW },
    );
    expect(state.uninstall).toBeNull();
  });

  it("will not start from the review step, however hard it is asked", () => {
    const state = run(
      base(),
      { type: "uninstall_opened" },
      { type: "uninstall_plan_loaded", preview: PREVIEW },
      { type: "uninstall_started" },
    );
    expect(state.uninstall?.step).toBe("review");
  });

  it("will not start with the wrong word typed", () => {
    const state = run(
      base(),
      { type: "uninstall_opened" },
      { type: "uninstall_plan_loaded", preview: PREVIEW },
      { type: "uninstall_review_accepted" },
      { type: "uninstall_typed_set", typed: "uninstal" },
      { type: "uninstall_started" },
    );
    expect(state.uninstall?.step).toBe("confirm");
  });

  it("starts once the word is typed out", () => {
    const state = run(
      base(),
      { type: "uninstall_opened" },
      { type: "uninstall_plan_loaded", preview: PREVIEW },
      { type: "uninstall_review_accepted" },
      { type: "uninstall_typed_set", typed: "uninstall" },
      { type: "uninstall_started" },
    );
    expect(state.uninstall?.step).toBe("closing");
  });

  it("clears the typed word when the confirm step is re-entered", () => {
    let state = run(
      base(),
      { type: "uninstall_opened" },
      { type: "uninstall_plan_loaded", preview: PREVIEW },
      { type: "uninstall_review_accepted" },
      { type: "uninstall_typed_set", typed: "uninstall" },
    );
    // Back out and come round again: the field must not be pre-armed.
    state = run(
      state,
      { type: "uninstall_closed" },
      { type: "uninstall_opened" },
      { type: "uninstall_plan_loaded", preview: PREVIEW },
      { type: "uninstall_review_accepted" },
    );
    expect(state.uninstall?.typed).toBe("");
  });

  it("does not let typing move the cursor buttons on the review step", () => {
    const state = run(
      base(),
      { type: "uninstall_opened" },
      { type: "uninstall_plan_loaded", preview: PREVIEW },
      { type: "uninstall_typed_set", typed: "uninstall" },
    );
    expect(state.uninstall?.typed).toBe("");
  });

  it("surfaces a plan failure instead of closing silently", () => {
    const state = run(
      base(),
      { type: "uninstall_opened" },
      { type: "uninstall_plan_failed", error: "EACCES" },
    );
    expect(state.uninstall?.step).toBe("failed");
    expect(state.uninstall?.errors).toEqual(["EACCES"]);
  });
});
