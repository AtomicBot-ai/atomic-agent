import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { PLAN_CHORDS, handleAppKey } from "./app-key-bindings.js";
import type { CodingMode } from "./coding-mode.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp/smoke",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

const FLUSH_MS = 60;
const strip = (value: string): string => value.replace(/\[[0-9;]*m/g, "");
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, FLUSH_MS));

function callbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

/** A key event shaped the way Ink delivers a ctrl-modified letter. */
function ctrlKey(): Parameters<typeof handleAppKey>[1] {
  return {
    ctrl: true,
    meta: false,
    shift: false,
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    backspace: false,
    delete: false,
    tab: false,
    pageDown: false,
    pageUp: false,
  } as Parameters<typeof handleAppKey>[1];
}

function keyContext(state: TuiState, extra: Record<string, unknown>) {
  return {
    state,
    dispatch: () => {},
    callbacks: callbacks(),
    ctrlCArmed: false,
    setCtrlCArmed: () => {},
    sidebarVisible: false,
    menuLeaderArmed: false,
    setMenuLeaderArmed: () => {},
    activateMenuNode: () => {},
    activateComposerSwitch: () => {},
    ...extra,
  } as Parameters<typeof handleAppKey>[2];
}

function offerState(): TuiState {
  return {
    ...createInitialTuiState(SESSION),
    codingMode: "plan" as const,
    planHandoff: true,
  };
}

/**
 * The hand-off shipped as three buttons and nothing else — no key
 * anywhere reached them, so on a terminal without a mouse a plan could
 * be read and never acted on.
 *
 * The chords are modified for the same reason the approval verdicts are:
 * the composer stays live under the offer, so a bare letter has to stay
 * text. Two of the letters are shared with the approval prompt on
 * purpose — the two offers can never be on screen together, because an
 * approval exists only inside a running turn and the hand-off is raised
 * only by a turn that has finished.
 */
describe("the plan hand-off answers to the keyboard", () => {
  it("runs the plan under auto", () => {
    const onPlanExecute = vi.fn<(mode: CodingMode) => void>();
    const handled = handleAppKey(
      PLAN_CHORDS.auto,
      ctrlKey(),
      keyContext(offerState(), { onPlanExecute }),
    );
    expect(handled).toBe(true);
    expect(onPlanExecute).toHaveBeenCalledWith("auto");
  });

  it("runs the plan under bypass", () => {
    const onPlanExecute = vi.fn<(mode: CodingMode) => void>();
    handleAppKey(
      PLAN_CHORDS.bypass,
      ctrlKey(),
      keyContext(offerState(), { onPlanExecute }),
    );
    expect(onPlanExecute).toHaveBeenCalledWith("bypass");
  });

  it("declines the plan", () => {
    const onPlanDismiss = vi.fn();
    const handled = handleAppKey(
      PLAN_CHORDS.dismiss,
      ctrlKey(),
      keyContext(offerState(), { onPlanDismiss }),
    );
    expect(handled).toBe(true);
    expect(onPlanDismiss).toHaveBeenCalledOnce();
  });

  it("leaves the letters alone when no plan is on offer", () => {
    // Outside the offer these are ordinary characters and must reach
    // the draft — ctrl+y in particular is not ours to take.
    const onPlanExecute = vi.fn<(mode: CodingMode) => void>();
    const idle = { ...createInitialTuiState(SESSION), planHandoff: false };
    handleAppKey(
      PLAN_CHORDS.auto,
      ctrlKey(),
      keyContext(idle, { onPlanExecute }),
    );
    expect(onPlanExecute).not.toHaveBeenCalled();
  });
});

/**
 * The offer's composer line said what typing would do — and could never
 * render it. `PromptShell` resolves `rotated ?? placeholder`, and the
 * rotating pool it was handed is never empty, so the specific line lost
 * to a generic one every time.
 */
describe("the composer line while a plan is on offer", () => {
  it("says what typing into it would do", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={callbacks()} />,
    );
    await settle();
    bus.emit({ type: "coding_mode_cycled", mode: "plan" });
    // Agent events reach the reducer wrapped — `reduceTuiState` unwraps
    // `agent_event` and hands `.event` to `reduceAgentEvent`.
    bus.emit({
      type: "agent_event",
      event: { type: "turn_finished", reason: "completed", stepCount: 3 },
    });
    await settle();

    expect(strip(lastFrame() ?? "")).toContain("Type to change the plan");
    unmount();
  });
});
