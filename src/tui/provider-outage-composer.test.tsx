import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";

/**
 * What the composer says while the provider is down, driven through the
 * real event bus rather than the reducer alone: the meta row and the
 * hint strip make one statement between them, and only a mounted app
 * shows whether the two halves still add up.
 */
const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/outage",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));
const strip = (value: string): string =>
  value.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");

function callbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

function mount() {
  const bus = makeTuiEventBus();
  const app = render(
    <TuiApp session={SESSION} bus={bus} callbacks={callbacks()} />,
  );
  const emit = (event: unknown): void => {
    bus.emitAgentEvent(event as never);
  };
  return { emit, ...app, frame: () => strip(app.lastFrame() ?? "") };
}

const WAITING = {
  type: "provider_waiting",
  attempt: 1,
  waitedMs: 0,
  maxWaitMs: 300_000,
  nextRetryMs: 2_000,
  reason: "terminated",
};

/** The meta row's Enter-routing hint — not the hint strip's chip. */
const META_HINT = "⏎ steer (ctrl+t)";

describe("the composer while the provider is down", () => {
  it("trades the meta row's Enter hint for the outage numbers", async () => {
    // The ~19 columns the hint costs are what let the readout and the
    // route both be read. Nothing is lost because the strip below keeps
    // its own `⏎` chip — which is why that chip is essential.
    const app = mount();
    app.emit({ type: "step_started", stepIndex: 0 });
    await settle();
    expect(app.frame()).toContain(META_HINT);
    app.emit(WAITING);
    await settle();
    const frame = app.frame();
    expect(frame).toContain("waiting for provider");
    expect(frame).not.toContain(META_HINT);
    expect(frame).toMatch(/\[⏎\]\s*steer/);
    app.unmount();
  });

  it("takes the readout down with the turn when Esc stops the wait", async () => {
    // The feed line the loop prints during a backoff ends "· Esc stops",
    // so this is the ending an operator reaches on purpose. The readout
    // used to survive it and go on counting — measured live at 19s and
    // climbing, fourteen seconds after the loop was dead.
    const app = mount();
    app.emit({ type: "step_started", stepIndex: 0 });
    app.emit(WAITING);
    await settle();
    expect(app.frame()).toContain("waiting for provider");
    app.emit({
      type: "turn_finished",
      turnIndex: 0,
      reason: "cancelled",
      stepCount: 1,
      durationMs: 20,
    });
    await settle();
    expect(app.frame()).not.toContain("waiting for provider");
    app.unmount();
  });

  it("does not label the next turn a retry of the abandoned one", async () => {
    // A stale outage turned the next turn's first `step_started` into
    // "the parked step going back on the wire": a brand-new healthy turn
    // reading `retrying provider (attempt 1)`, counting up, with its
    // streamed reply wiped at every step boundary.
    const app = mount();
    app.emit({ type: "step_started", stepIndex: 0 });
    app.emit(WAITING);
    app.emit({
      type: "turn_finished",
      turnIndex: 0,
      reason: "cancelled",
      stepCount: 1,
      durationMs: 20,
    });
    await settle();
    app.emit({ type: "turn_started" });
    app.emit({ type: "step_started", stepIndex: 0 });
    await settle();
    const frame = app.frame();
    expect(frame).not.toContain("retrying provider");
    // …and the hint the healthy turn is entitled to is back on the row.
    expect(frame).toContain(META_HINT);
    app.unmount();
  });

  it("keeps the given-up badge, and the Enter hint alongside it", async () => {
    // The badge is past tense and sticky until a turn actually succeeds:
    // it is what stops nine identical failures reading as nine separate
    // surprises. It has no counter to protect and 20 columns of width,
    // so the turn running underneath it keeps its Enter hint.
    const app = mount();
    app.emit({ type: "step_started", stepIndex: 0 });
    app.emit(WAITING);
    app.emit({
      type: "loop_failed",
      error: new Error("terminated"),
      category: "transport",
    });
    app.emit({
      type: "turn_finished",
      turnIndex: 0,
      reason: "failed",
      stepCount: 1,
      durationMs: 20,
    });
    await settle();
    expect(app.frame()).toContain("provider unreachable");
    app.emit({ type: "turn_started" });
    app.emit({ type: "step_started", stepIndex: 0 });
    await settle();
    const frame = app.frame();
    expect(frame).toContain("provider unreachable");
    expect(frame).toContain(META_HINT);
    app.unmount();
  });
});
