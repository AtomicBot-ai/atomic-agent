import { describe, expect, it, vi } from "vitest";
import { createDragIntentTracker } from "./drag-intent.js";
import type { TuiMouseEvent } from "./mouse-event.js";

function event(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x: 10,
    y: 5,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

const press = (): TuiMouseEvent => event();
const motion = (): TuiMouseEvent => event({ kind: "motion" });
const release = (): TuiMouseEvent => event({ kind: "release", button: "none" });
const wheel = (): TuiMouseEvent =>
  event({ kind: "wheel", wheel: "down", button: "none" });

describe("createDragIntentTracker", () => {
  it("fires once for an unclaimed press followed by held motion", () => {
    const onIntent = vi.fn();
    const tracker = createDragIntentTracker(onIntent);
    tracker.observe(press(), false);
    tracker.observe(motion(), false);
    // The drag keeps producing motion reports — one gesture, one fire.
    tracker.observe(motion(), false);
    tracker.observe(motion(), false);
    expect(onIntent).toHaveBeenCalledTimes(1);
  });

  it("never fires when the press was claimed by a target", () => {
    const onIntent = vi.fn();
    const tracker = createDragIntentTracker(onIntent);
    tracker.observe(press(), true);
    tracker.observe(motion(), false);
    expect(onIntent).not.toHaveBeenCalled();
  });

  it("never fires for a press and release without motion", () => {
    const onIntent = vi.fn();
    const tracker = createDragIntentTracker(onIntent);
    tracker.observe(press(), false);
    tracker.observe(release(), false);
    // A motion arriving after the release belongs to no held button.
    tracker.observe(motion(), false);
    expect(onIntent).not.toHaveBeenCalled();
  });

  it("arms again for the next unclaimed press after a release", () => {
    const onIntent = vi.fn();
    const tracker = createDragIntentTracker(onIntent);
    tracker.observe(press(), false);
    tracker.observe(motion(), false);
    tracker.observe(release(), false);
    tracker.observe(press(), false);
    tracker.observe(motion(), false);
    expect(onIntent).toHaveBeenCalledTimes(2);
  });

  it("ignores wheel reports entirely — they neither fire nor disarm", () => {
    const onIntent = vi.fn();
    const tracker = createDragIntentTracker(onIntent);
    tracker.observe(wheel(), false);
    expect(onIntent).not.toHaveBeenCalled();
    // A scroll between the press and its motion must not eat the arm.
    tracker.observe(press(), false);
    tracker.observe(wheel(), true);
    tracker.observe(motion(), false);
    expect(onIntent).toHaveBeenCalledTimes(1);
  });

  it("only a left-button drag reads as a selection", () => {
    const onIntent = vi.fn();
    const tracker = createDragIntentTracker(onIntent);
    tracker.observe(event({ button: "right" }), false);
    tracker.observe(motion(), false);
    tracker.observe(press(), false);
    tracker.observe(event({ kind: "motion", button: "right" }), false);
    expect(onIntent).not.toHaveBeenCalled();
  });

  it("does not fire on motion with no press before it", () => {
    const onIntent = vi.fn();
    const tracker = createDragIntentTracker(onIntent);
    tracker.observe(motion(), false);
    expect(onIntent).not.toHaveBeenCalled();
  });
});
