import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TuiMouseEvent } from "./mouse-event.js";
import {
  createSelectionPassthrough,
  DEFAULT_SELECTION_WINDOW_MS,
  type SelectionSuspendable,
} from "./selection-passthrough.js";

function press(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x: 4,
    y: 7,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

interface FakeTracking extends SelectionSuspendable {
  suspends: number;
  resumes: number;
}

function makeTracking(): FakeTracking {
  let suspended = false;
  return {
    suspends: 0,
    resumes: 0,
    suspend(): void {
      suspended = true;
      this.suspends += 1;
    },
    resume(): void {
      suspended = false;
      this.resumes += 1;
    },
    isSuspended: () => suspended,
  };
}

describe("createSelectionPassthrough", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the terminal back its drag on a shift-modified press", () => {
    const tracking = makeTracking();
    const messages: string[] = [];
    const passthrough = createSelectionPassthrough({
      tracking: () => tracking,
      notify: (m) => messages.push(m),
    });
    expect(passthrough.observe(press({ shift: true }))).toBe(true);
    expect(tracking.isSuspended()).toBe(true);
    expect(messages[0]).toContain("drag to select");
  });

  it("opens the same window on an alt-modified press", () => {
    // iTerm2 reserves Option for its native bypass; a terminal that
    // reports the alt-press instead is one that needs the window.
    const tracking = makeTracking();
    const messages: string[] = [];
    const passthrough = createSelectionPassthrough({
      tracking: () => tracking,
      notify: (m) => messages.push(m),
    });
    expect(passthrough.observe(press({ alt: true }))).toBe(true);
    expect(tracking.isSuspended()).toBe(true);
    expect(messages[0]).toContain("drag to select");
  });

  it("leaves ordinary clicks alone so existing targets keep working", () => {
    const tracking = makeTracking();
    const passthrough = createSelectionPassthrough({ tracking: () => tracking });
    expect(passthrough.observe(press())).toBe(false);
    expect(passthrough.observe(press({ ctrl: true }))).toBe(false);
    expect(
      passthrough.observe({ ...press({ shift: true }), kind: "release" }),
    ).toBe(false);
    expect(
      passthrough.observe({
        ...press({ shift: true }),
        kind: "wheel",
        wheel: "up",
        button: "none",
      }),
    ).toBe(false);
    expect(tracking.suspends).toBe(0);
  });

  it("restores reporting when the window expires", () => {
    const tracking = makeTracking();
    const messages: string[] = [];
    const passthrough = createSelectionPassthrough({
      tracking: () => tracking,
      notify: (m) => messages.push(m),
    });
    passthrough.observe(press({ shift: true }));
    vi.advanceTimersByTime(DEFAULT_SELECTION_WINDOW_MS - 1);
    expect(tracking.isSuspended()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracking.isSuspended()).toBe(false);
    expect(messages[1]).toContain("mouse back on");
  });

  it("does not extend the window with a report that was already in flight", () => {
    const tracking = makeTracking();
    const passthrough = createSelectionPassthrough({
      tracking: () => tracking,
      windowMs: 1_000,
    });
    passthrough.observe(press({ shift: true }));
    vi.advanceTimersByTime(900);
    // A press the terminal had already sent before it saw our disable.
    expect(passthrough.observe(press({ shift: true }))).toBe(true);
    expect(tracking.suspends).toBe(1);
    vi.advanceTimersByTime(100);
    expect(tracking.isSuspended()).toBe(false);
  });

  it("resumes early on request", () => {
    const tracking = makeTracking();
    const passthrough = createSelectionPassthrough({ tracking: () => tracking });
    passthrough.observe(press({ shift: true }));
    passthrough.resumeNow();
    expect(tracking.isSuspended()).toBe(false);
    // The pending timer must be gone, not merely ineffective.
    vi.advanceTimersByTime(DEFAULT_SELECTION_WINDOW_MS);
    expect(tracking.resumes).toBe(1);
  });

  it("does nothing when mouse support is off entirely", () => {
    const passthrough = createSelectionPassthrough({ tracking: () => null });
    expect(passthrough.observe(press({ shift: true }))).toBe(false);
  });

  it("never resumes a controller that was switched off mid-window", () => {
    // `/mouse off` during the window: the operator asked for reporting to
    // stay gone, and the pending timer must not undo that.
    const tracking = makeTracking();
    let live: SelectionSuspendable | null = tracking;
    const passthrough = createSelectionPassthrough({ tracking: () => live });
    passthrough.observe(press({ shift: true }));
    live = null;
    vi.advanceTimersByTime(DEFAULT_SELECTION_WINDOW_MS);
    expect(tracking.resumes).toBe(0);
  });

  it("drops the pending resume on dispose", () => {
    const tracking = makeTracking();
    const passthrough = createSelectionPassthrough({ tracking: () => tracking });
    passthrough.observe(press({ shift: true }));
    passthrough.dispose();
    vi.advanceTimersByTime(DEFAULT_SELECTION_WINDOW_MS);
    expect(tracking.resumes).toBe(0);
  });

  it("beginWindow('drag') opens the window and tells the operator to drag again", () => {
    const tracking = makeTracking();
    const messages: string[] = [];
    const passthrough = createSelectionPassthrough({
      tracking: () => tracking,
      notify: (m) => messages.push(m),
    });
    passthrough.beginWindow("drag");
    expect(tracking.isSuspended()).toBe(true);
    // The triggering drag is already lost to reporting — the notice has
    // to say what to do NOW, not describe the gesture that happened.
    expect(messages[0]).toContain("drag again to select");
    // Same timer, same auto-resume as the modifier path.
    vi.advanceTimersByTime(DEFAULT_SELECTION_WINDOW_MS);
    expect(tracking.isSuspended()).toBe(false);
    expect(messages[1]).toContain("mouse back on");
  });

  it("beginWindow neither restarts nor extends a window already open", () => {
    const tracking = makeTracking();
    const passthrough = createSelectionPassthrough({
      tracking: () => tracking,
      windowMs: 1_000,
    });
    passthrough.observe(press({ shift: true }));
    vi.advanceTimersByTime(900);
    passthrough.beginWindow("drag");
    expect(tracking.suspends).toBe(1);
    vi.advanceTimersByTime(100);
    expect(tracking.isSuspended()).toBe(false);
  });

  it("beginWindow does nothing while mouse support is off entirely", () => {
    const messages: string[] = [];
    const passthrough = createSelectionPassthrough({
      tracking: () => null,
      notify: (m) => messages.push(m),
    });
    passthrough.beginWindow("drag");
    expect(messages).toEqual([]);
  });
});
