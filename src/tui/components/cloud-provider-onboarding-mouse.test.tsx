/**
 * Row clicks on this screen act on ITS wizard — the one in component
 * state — never on `providersPanel.wizard`. The store slice stays
 * `null` for every test here, so any movement on screen can only have
 * come through the threaded `WizardMouseRoute`; the old handlers read
 * the store at click time, found `null`, and silently did nothing.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import { visibleKindRows } from "../providers/providers-wizard-phases.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState } from "../tui-state.js";
import { CloudProviderOnboarding } from "./cloud-provider-onboarding.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Mounted {
  frame(): string;
  /** Everything that leaked into the store — must stay wizard-free. */
  actions: TuiAction[];
  registry: MouseTargetRegistry;
  unmount(): void;
}

function mountWithMouse(): Mounted {
  const actions: TuiAction[] = [];
  const registry = new MouseTargetRegistry();
  // The store's wizard slice is null and stays null: this screen's
  // wizard lives in its own useState, which is the whole point.
  const state = createInitialTuiState(fakeSession(), 50);
  const view = render(
    <MouseProvider
      registry={registry}
      dispatch={(action) => actions.push(action)}
      callbacks={{}}
      getState={() => state}
    >
      <CloudProviderOnboarding onFinished={() => {}} onBack={() => {}} />
    </MouseProvider>,
  );
  return {
    frame: () => strip(view.lastFrame() ?? ""),
    actions,
    registry,
    unmount: view.unmount,
  };
}

function mouseEvent(over: Partial<TuiMouseEvent>): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x: 0,
    y: 0,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  };
}

/** Screen cell of `label`'s first character, off the rendered frame. */
function pointOf(view: Mounted, label: string): { x: number; y: number } {
  const lines = view.frame().split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(label);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${label}" is not on screen:\n${view.frame()}`);
}

/** Retries until a commit has registered the row targets (see the twin). */
async function sendUntilClaimed(view: Mounted, label: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const point = pointOf(view, label);
    if (view.registry.dispatch(mouseEvent(point))) return;
    await delay(25);
  }
  throw new Error(`the surface never claimed an event at "${label}"`);
}

describe("CloudProviderOnboarding mouse", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cloud-onboarding-mouse-"));
    mkdirSync(stateDir, { recursive: true });
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalEnv;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("a click on an unselected kind row moves the local wizard's cursor", async () => {
    const second = visibleKindRows(null)[1];
    if (!second) throw new Error("the kind list has fewer than two rows");
    const view = mountWithMouse();
    await sendUntilClaimed(view, second.label);
    await delay(60);
    // The frame's cursor moved, driven by the local useState wizard...
    const row = view
      .frame()
      .split("\n")
      .find((line) => line.includes(second.label));
    expect(row).toContain(`> ${second.label}`);
    // ...and nothing wizard-shaped leaked into the store's slice.
    expect(
      view.actions.every((action) => action.type !== "providers_wizard_updated"),
    ).toBe(true);
    view.unmount();
  });

  it("a click on the selected row presses the local wizard's Enter", async () => {
    const first = visibleKindRows(null)[0];
    if (!first) throw new Error("the kind list is empty");
    const view = mountWithMouse();
    await sendUntilClaimed(view, first.label);
    await delay(60);
    // Enter on the selected kind row advances the wizard off the
    // provider list — rendered from local state, so the title change is
    // the proof the click reached this screen's own wizard.
    expect(view.frame()).not.toContain("LLM provider — add provider");
    expect(
      view.actions.every((action) => action.type !== "providers_wizard_updated"),
    ).toBe(true);
    view.unmount();
  });
});
