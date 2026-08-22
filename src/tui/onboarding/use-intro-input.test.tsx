import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import { OnboardingScreen } from "../components/onboarding-screen.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState } from "../tui-state.js";
import { createOnboardingState } from "./onboarding-state.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
const ESCAPE_KEY = "\u001b";
/** F5 as xterm reports it — a key Ink has no `Key` field for. */
const F5_KEY = "\u001b[15~";
const pasteOf = (text: string): string => `\u001b[200~${text}\u001b[201~`;

const strip = (value: string): string =>
  value.replace(/\u001b\[[0-9;]*m/g, "");
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

function noopCallbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

interface MountedSplash {
  frame(): string;
  actions: TuiAction[];
  registry: MouseTargetRegistry;
  stdin: { write(data: string): void };
  resize(): void;
  unmount(): void;
}

function mountSplash(): MountedSplash {
  const actions: TuiAction[] = [];
  const registry = new MouseTargetRegistry();
  const onboarding = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step: "intro" as const,
  };
  const state = { ...createInitialTuiState(fakeSession(), 50), onboarding };
  const dispatch = (action: TuiAction): void => {
    actions.push(action);
  };
  const view = render(
    <MouseProvider
      registry={registry}
      dispatch={dispatch}
      callbacks={noopCallbacks()}
      getState={() => state}
    >
      <OnboardingScreen
        state={state}
        onboarding={onboarding}
        dispatch={dispatch}
        callbacks={{}}
      />
    </MouseProvider>,
  );
  return {
    frame: () => strip(view.lastFrame() ?? ""),
    actions,
    registry,
    stdin: view.stdin,
    resize: () => {
      view.stdout.emit("resize");
    },
    unmount: view.unmount,
  };
}

/** Where the splash draws its promise, in the cells a terminal reports. */
function pressAnyKeyPoint(frame: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf("press any key");
    if (x !== -1) return { x, y };
  }
  throw new Error(`the splash is not on screen:\n${frame}`);
}

/**
 * Ink commits a frame on its own throttle and React registers the click
 * target in an effect after that commit, so the splash is not clickable
 * for a frame or two. Re-sending until the registry reports the event
 * claimed is the terminal equivalent of clicking again when the first
 * one lands mid-repaint — and an unclaimed event advances nothing, so
 * the retries cannot inflate the count.
 */
async function sendUntilClaimed(
  view: MountedSplash,
  over: Partial<TuiMouseEvent> = {},
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const point = pressAnyKeyPoint(view.frame());
    if (view.registry.dispatch(mouseEvent({ ...point, ...over }))) return;
    await delay(25);
  }
  throw new Error("the splash never claimed a mouse event");
}

const dismissed = (actions: readonly TuiAction[]): boolean =>
  actions.some(
    (action) =>
      action.type === "onboarding_step_set" && action.step === "choose",
  );

describe("useIntroInput", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "intro-input-"));
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

  it("takes two clicks off the splash, exactly as it takes two keys", async () => {
    const view = mountSplash();
    await sendUntilClaimed(view);
    // The first click only finishes the reveal — the splash is still up.
    expect(dismissed(view.actions)).toBe(false);
    expect(view.frame()).toContain("press any key");
    const point = pressAnyKeyPoint(view.frame());
    expect(view.registry.dispatch(mouseEvent(point))).toBe(true);
    expect(dismissed(view.actions)).toBe(true);
    view.unmount();
  });

  it("counts a wheel notch as input", async () => {
    const view = mountSplash();
    await sendUntilClaimed(view, { kind: "wheel", button: "none", wheel: "down" });
    const point = pressAnyKeyPoint(view.frame());
    view.registry.dispatch(
      mouseEvent({ ...point, kind: "wheel", button: "none", wheel: "up" }),
    );
    expect(dismissed(view.actions)).toBe(true);
    view.unmount();
  });

  it("does not spend a key on the release or the drag that follow a press", async () => {
    const view = mountSplash();
    await sendUntilClaimed(view);
    const point = pressAnyKeyPoint(view.frame());
    for (const kind of ["release", "motion", "release"] as const) {
      expect(view.registry.dispatch(mouseEvent({ ...point, kind }))).toBe(true);
    }
    expect(dismissed(view.actions)).toBe(false);
    view.registry.dispatch(mouseEvent(point));
    expect(dismissed(view.actions)).toBe(true);
    view.unmount();
  });

  it("makes the whole surface the target, not the row the promise is on", async () => {
    const view = mountSplash();
    await sendUntilClaimed(view);
    const lines = view.frame().split("\n");
    const bottomRight = {
      x: Math.max(0, (lines.at(-1)?.length ?? 1) - 1),
      y: lines.length - 1,
    };
    expect(view.registry.dispatch(mouseEvent(bottomRight))).toBe(true);
    expect(dismissed(view.actions)).toBe(true);
    view.unmount();
  });

  it("advances on Escape, which Ink delivers 20ms late", async () => {
    const view = mountSplash();
    view.stdin.write(ESCAPE_KEY);
    await delay(60);
    expect(dismissed(view.actions)).toBe(false);
    view.stdin.write(ESCAPE_KEY);
    await delay(60);
    expect(dismissed(view.actions)).toBe(true);
    view.unmount();
  });

  it("advances on a function key, which arrives with no input and no flag", async () => {
    const view = mountSplash();
    view.stdin.write(F5_KEY);
    await delay(40);
    view.stdin.write(F5_KEY);
    await delay(40);
    expect(dismissed(view.actions)).toBe(true);
    view.unmount();
  });

  it("counts a paste that carries text but not a paste of nothing", async () => {
    const empty = mountSplash();
    empty.stdin.write(pasteOf(""));
    await delay(40);
    empty.stdin.write(pasteOf(""));
    await delay(40);
    expect(dismissed(empty.actions)).toBe(false);
    empty.unmount();

    const typed = mountSplash();
    typed.stdin.write(pasteOf("hello"));
    await delay(40);
    typed.stdin.write(pasteOf("hello"));
    await delay(40);
    expect(dismissed(typed.actions)).toBe(true);
    typed.unmount();
  });

  it("does not read a terminal resize as input", async () => {
    const view = mountSplash();
    await sendUntilClaimed(view);
    for (let count = 0; count < 3; count += 1) view.resize();
    await delay(60);
    expect(dismissed(view.actions)).toBe(false);
    expect(view.frame()).toContain("press any key");
    view.unmount();
  });
});
