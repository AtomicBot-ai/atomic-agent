import type { DOMElement } from "ink";
import { describe, expect, it } from "vitest";
import {
  absoluteRect,
  MOUSE_LAYER_BASE,
  MOUSE_LAYER_MODAL,
  MouseTargetRegistry,
} from "./mouse-registry.js";
import type { TuiMouseEvent } from "./mouse-event.js";

interface FakeLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Minimal stand-in for an Ink node: the registry only ever reads
 * `yogaNode.getComputedLayout()`, `parentNode` and `style`.
 */
function node(
  layout: FakeLayout,
  parent?: DOMElement,
  style: Record<string, unknown> = {},
): DOMElement {
  return {
    nodeName: "ink-box",
    attributes: {},
    childNodes: [],
    style,
    parentNode: parent,
    yogaNode: {
      getComputedLayout: () => layout,
    },
  } as unknown as DOMElement;
}

function press(x: number, y: number): TuiMouseEvent {
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

describe("absoluteRect", () => {
  it("sums the offsets of every ancestor", () => {
    const root = node({ left: 0, top: 0, width: 80, height: 24 });
    const column = node({ left: 2, top: 1, width: 78, height: 20 }, root);
    const row = node({ left: 0, top: 3, width: 78, height: 1 }, column);
    expect(absoluteRect(row)).toEqual({
      left: 2,
      top: 4,
      width: 78,
      height: 1,
    });
  });

  it("returns null for an unmounted ref", () => {
    expect(absoluteRect(null)).toBeNull();
  });

  it("clips against an ancestor that hides overflow", () => {
    const viewport = node({ left: 0, top: 0, width: 40, height: 5 }, undefined, {
      overflowY: "hidden",
    });
    const scrolled = node({ left: 0, top: 3, width: 40, height: 4 }, viewport);
    expect(absoluteRect(scrolled)).toEqual({
      left: 0,
      top: 3,
      width: 40,
      height: 2,
    });
  });

  it("drops a row scrolled fully out of a clipping viewport", () => {
    const viewport = node({ left: 0, top: 0, width: 40, height: 5 }, undefined, {
      overflowY: "hidden",
    });
    const offscreen = node({ left: 0, top: -4, width: 40, height: 1 }, viewport);
    expect(absoluteRect(offscreen)).toBeNull();
  });
});

describe("MouseTargetRegistry", () => {
  it("routes a click to the target under the pointer", () => {
    const registry = new MouseTargetRegistry();
    const root = node({ left: 0, top: 0, width: 80, height: 24 });
    const hits: string[] = [];
    registry.register({
      ref: { current: node({ left: 0, top: 0, width: 10, height: 1 }, root) },
      handler: () => {
        hits.push("first");
        return true;
      },
    });
    registry.register({
      ref: { current: node({ left: 0, top: 2, width: 10, height: 1 }, root) },
      handler: () => {
        hits.push("second");
        return true;
      },
    });
    expect(registry.dispatch(press(3, 2))).toBe(true);
    expect(hits).toEqual(["second"]);
  });

  it("reports the click position relative to the target", () => {
    const registry = new MouseTargetRegistry();
    const root = node({ left: 0, top: 0, width: 80, height: 24 });
    let seen = { x: -1, y: -1 };
    registry.register({
      ref: { current: node({ left: 5, top: 4, width: 20, height: 3 }, root) },
      handler: (hit) => {
        seen = { x: hit.localX, y: hit.localY };
        return true;
      },
    });
    registry.dispatch(press(9, 6));
    expect(seen).toEqual({ x: 4, y: 2 });
  });

  it("prefers the innermost target when boxes nest", () => {
    const registry = new MouseTargetRegistry();
    const container = node({ left: 0, top: 0, width: 40, height: 10 });
    const row = node({ left: 0, top: 2, width: 40, height: 1 }, container);
    const claimed: string[] = [];
    registry.register({
      ref: { current: container },
      handler: () => {
        claimed.push("container");
        return true;
      },
    });
    registry.register({
      ref: { current: row },
      handler: () => {
        claimed.push("row");
        return true;
      },
    });
    registry.dispatch(press(1, 2));
    expect(claimed).toEqual(["row"]);
  });

  it("falls through to the next candidate when a handler declines", () => {
    const registry = new MouseTargetRegistry();
    const container = node({ left: 0, top: 0, width: 40, height: 10 });
    const row = node({ left: 0, top: 0, width: 40, height: 1 }, container);
    const claimed: string[] = [];
    registry.register({
      ref: { current: container },
      handler: () => {
        claimed.push("container");
        return true;
      },
    });
    registry.register({
      ref: { current: row },
      handler: () => {
        claimed.push("row");
        return false;
      },
    });
    registry.dispatch(press(1, 0));
    expect(claimed).toEqual(["row", "container"]);
  });

  it("ignores clicks outside every target", () => {
    const registry = new MouseTargetRegistry();
    registry.register({
      ref: { current: node({ left: 0, top: 0, width: 4, height: 1 }) },
      handler: () => true,
    });
    expect(registry.dispatch(press(9, 9))).toBe(false);
  });

  it("lets a modal layer lock out the surfaces behind it", () => {
    const registry = new MouseTargetRegistry();
    const claimed: string[] = [];
    registry.register({
      ref: { current: node({ left: 0, top: 0, width: 40, height: 10 }) },
      layer: MOUSE_LAYER_BASE,
      handler: () => {
        claimed.push("background");
        return true;
      },
    });
    registry.register({
      ref: { current: node({ left: 0, top: 5, width: 40, height: 2 }) },
      layer: MOUSE_LAYER_MODAL,
      handler: () => {
        claimed.push("modal");
        return true;
      },
    });
    registry.setMinLayer(MOUSE_LAYER_MODAL);
    expect(registry.dispatch(press(1, 1))).toBe(false);
    registry.dispatch(press(1, 5));
    expect(claimed).toEqual(["modal"]);
  });

  it("stops routing to an unregistered target", () => {
    const registry = new MouseTargetRegistry();
    let calls = 0;
    const unregister = registry.register({
      ref: { current: node({ left: 0, top: 0, width: 4, height: 1 }) },
      handler: () => {
        calls += 1;
        return true;
      },
    });
    registry.dispatch(press(0, 0));
    unregister();
    registry.dispatch(press(0, 0));
    expect(calls).toBe(1);
  });
});
