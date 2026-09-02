import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { reduceTuiState } from "../agent-event-reducer.js";
import { apply, fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { StatusBar } from "./status-bar.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

function offered(): TuiState {
  return reduceTuiState(createInitialTuiState(fakeSession()), {
    type: "update_available",
    current: "0.5.4",
    latest: "9.9.9",
  });
}

describe("StatusBar update banner", () => {
  it("shows the offer at the end of the bar", () => {
    const frame = strip(render(<StatusBar state={offered()} />).lastFrame() ?? "");
    expect(frame).toContain("v9.9.9");
    expect(frame).toContain("Update");
  });

  it("stays on screen after the startup modal is dismissed", () => {
    const state = apply(offered(), [{ type: "update_dismissed" }]);
    expect(state.updatePrompt).toBeNull();
    const frame = strip(render(<StatusBar state={state} />).lastFrame() ?? "");
    expect(frame).toContain("Update");
  });

  it("narrates the install instead of offering it while the installer runs", () => {
    const running = apply(offered(), [{ type: "update_started" }]);
    const frame = strip(render(<StatusBar state={running} />).lastFrame() ?? "");
    expect(frame).toContain("do not close");
    // The button is gone: a second accept mid-install has no meaning.
    expect(frame).not.toContain("Update");
  });

  it("says a restart applies it once the installer lands", () => {
    const done = apply(offered(), [
      { type: "update_started" },
      { type: "update_finished", ok: true, version: "9.9.9" },
    ]);
    const frame = strip(render(<StatusBar state={done} />).lastFrame() ?? "");
    expect(frame).toContain("restart to apply");
    expect(frame).not.toContain("Update");
  });

  it("returns to the offer — the retry path — after a failed install", () => {
    const failed = apply(offered(), [
      { type: "update_started" },
      { type: "update_finished", ok: false, error: "boom" },
    ]);
    expect(
      strip(render(<StatusBar state={failed} />).lastFrame() ?? ""),
    ).toContain("Update");
  });

  it("says nothing when no newer version exists", () => {
    const state = createInitialTuiState(fakeSession());
    const frame = strip(render(<StatusBar state={state} />).lastFrame() ?? "");
    expect(frame).not.toContain("Update");
  });

  it("pins the banner to the right edge when given the row width", () => {
    const view = render(<StatusBar state={offered()} width={78} />);
    const line = strip(view.lastFrame() ?? "").split("\n")[0] ?? "";
    // The button's trailing pad cell sits on the last column; everything
    // before the banner is left-flowing content and a stretched spacer.
    expect(line.trimEnd().endsWith("Update")).toBe(true);
    expect(line.trimEnd().length).toBeGreaterThan(60);
  });

  it("keeps the bar one row tall with the banner up", () => {
    const view = render(<StatusBar state={offered()} width={78} />);
    const rows = strip(view.lastFrame() ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(rows).toHaveLength(1);
  });
});
