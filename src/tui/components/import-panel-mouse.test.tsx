/**
 * The Import tab reads like a page of controls — four source names, a
 * column of checkboxes, `Run preview`, an apply line — and every one of
 * them used to be keyboard-only. These tests drive the real targets and
 * assert the click emits exactly what the key would.
 */

import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import {
  createInitialImportPanelState,
  type ImportFormState,
  type ImportPanelState,
} from "../import/import-panel-state.js";
import type { ImportReport } from "../../import/import-report.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState } from "../tui-state.js";
import { ImportPanel } from "./import-panel.js";

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Mounted {
  frame(): string;
  actions: TuiAction[];
  previews: ImportFormState[];
  executes: ImportFormState[];
  registry: MouseTargetRegistry;
  unmount(): void;
}

function mount(panel: ImportPanelState): Mounted {
  const actions: TuiAction[] = [];
  const previews: ImportFormState[] = [];
  const executes: ImportFormState[] = [];
  const registry = new MouseTargetRegistry();
  const callbacks: TuiAppCallbacks = {
    onImportPreview: (form) => previews.push(form),
    onImportExecute: (form) => executes.push(form),
  };
  const state = createInitialTuiState(fakeSession(), 50);
  const view = render(
    <MouseProvider
      registry={registry}
      dispatch={(action) => actions.push(action)}
      callbacks={callbacks}
      getState={() => state}
    >
      <ImportPanel panel={panel} />
    </MouseProvider>,
  );
  return {
    frame: () => strip(view.lastFrame() ?? ""),
    actions,
    previews,
    executes,
    registry,
    unmount: view.unmount,
  };
}

function pressAt(x: number, y: number): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

/** Screen cell of `label`, off the rendered frame. */
function pointOf(view: Mounted, label: string): { x: number; y: number } {
  for (const [y, line] of view.frame().split("\n").entries()) {
    const x = line.indexOf(label);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${label}" is not on screen:\n${view.frame()}`);
}

/** Ink commits on a throttle, so a target may register a frame late. */
async function clickUntilClaimed(view: Mounted, label: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const point = pointOf(view, label);
    if (view.registry.dispatch(pressAt(point.x, point.y))) return;
    await delay(25);
  }
  throw new Error(`nothing claimed a click on "${label}"`);
}

function reportPanel(
  mode: "preview" | "done",
  storeWarning?: string,
): ImportPanelState {
  const report: ImportReport = {
    items: [
      { kind: "sessions", source: "a", destination: "b", status: "migrated" },
    ],
    summary: { migrated: 1, skipped: 0, conflict: 0, error: 0 },
    executed: mode === "done",
  };
  return {
    ...createInitialImportPanelState(),
    mode,
    report,
    reportExecuted: mode === "done",
    ...(storeWarning !== undefined ? { storeWarning } : {}),
  };
}

describe("ImportPanel mouse", () => {
  it("picks the clicked source outright", async () => {
    const view = mount(createInitialImportPanelState());
    await clickUntilClaimed(view, "claude-code");
    expect(view.actions).toContainEqual({
      type: "import_source_set",
      source: "claude-code",
    });
    // The click also lands the keyboard on that row, so the two agree
    // about where the operator is.
    expect(view.actions).toContainEqual({
      type: "import_focus_set",
      focus: "sourceType",
    });
    view.unmount();
  });

  it("flips the checkbox that was clicked, and focuses its row", async () => {
    const view = mount(createInitialImportPanelState());
    await clickUntilClaimed(view, "sessions");
    expect(view.actions).toContainEqual({
      type: "import_toggled",
      field: "sessions",
    });
    expect(view.actions).toContainEqual({
      type: "import_focus_set",
      focus: "sessions",
    });
    view.unmount();
  });

  it("runs the preview from the Run row", async () => {
    const view = mount(createInitialImportPanelState());
    await clickUntilClaimed(view, "Run preview");
    expect(view.previews).toHaveLength(1);
    view.unmount();
  });

  it("applies a previewed import from its own line", async () => {
    const view = mount(reportPanel("preview"));
    await clickUntilClaimed(view, "y / Enter apply");
    expect(view.executes).toHaveLength(1);
    expect(view.actions).not.toContainEqual({ type: "import_reset" });
    view.unmount();
  });

  it("cancels a preview back to the form", async () => {
    const view = mount(reportPanel("preview"));
    await clickUntilClaimed(view, "e edit");
    expect(view.actions).toContainEqual({ type: "import_reset" });
    expect(view.executes).toHaveLength(0);
    view.unmount();
  });

  it("leaves the finished report from its own line", async () => {
    const view = mount(reportPanel("done"));
    await clickUntilClaimed(view, "back to form");
    expect(view.actions).toContainEqual({ type: "import_reset" });
    view.unmount();
  });

  it("shows unreadable stored sessions on the report", () => {
    const view = mount(
      reportPanel(
        "done",
        "2 sessions already in the store cannot be read and are not listed",
      ),
    );
    expect(view.frame()).toContain("cannot be read");
    view.unmount();
  });

  it("says nothing about the store when every row reads", () => {
    const view = mount(reportPanel("done"));
    expect(view.frame()).not.toContain("cannot be read");
    view.unmount();
  });
});
