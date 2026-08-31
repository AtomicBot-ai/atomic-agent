import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import { reduceTuiState } from "../agent-event-reducer.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { cloudState, localState } from "./composer-switch-fixtures.js";
import { handleComposerSwitchKey } from "./composer-switch-key-bindings.js";
import type { ComposerSwitchRow } from "./composer-switch-rows.js";

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

/**
 * Drives the real reducer, so a test asserts on the state the operator
 * would end up in rather than on the list of actions that got there.
 */
function driver(initial: TuiState) {
  let state = initial;
  const picked: ComposerSwitchRow[] = [];
  const dispatch = (action: TuiAction): void => {
    state = reduceTuiState(state, action);
  };
  const press = (input: string, k: Partial<Key> = {}): boolean =>
    handleComposerSwitchKey(input, key(k), {
      state,
      dispatch,
      canOpen: true,
      activate: (row) => picked.push(row),
    });
  return { press, picked, at: () => state };
}

describe("opening the strip", () => {
  it("ctrl+r opens it on the backend control, cursor on the live route", () => {
    const app = driver(localState("external"));
    expect(app.press("r", { ctrl: true })).toBe(true);
    expect(app.at().composerSwitch).toEqual({
      kind: "backend",
      cursor: 2,
      filter: "",
    });
  });

  it("declines while another surface owns the keyboard", () => {
    const state = localState();
    const handled = handleComposerSwitchKey("r", key({ ctrl: true }), {
      state,
      dispatch: vi.fn(),
      canOpen: false,
      activate: vi.fn(),
    });
    expect(handled).toBe(false);
  });

  it("leaves every other key alone while it is closed", () => {
    const app = driver(cloudState());
    expect(app.press("r")).toBe(false);
    expect(app.press("", { escape: true })).toBe(false);
    expect(app.at().composerSwitch).toBeNull();
  });
});

describe("driving an open strip", () => {
  it("↑↓ walk the rows and clamp at both ends", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("", { upArrow: true });
    expect(app.at().composerSwitch?.cursor).toBe(0);
    app.press("", { downArrow: true });
    app.press("", { downArrow: true });
    app.press("", { downArrow: true });
    expect(app.at().composerSwitch?.cursor).toBe(2);
  });

  it("←→ walk the three controls without closing", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("", { rightArrow: true });
    expect(app.at().composerSwitch?.kind).toBe("provider");
    app.press("", { rightArrow: true });
    expect(app.at().composerSwitch?.kind).toBe("model");
    // The model switch is the right-hand end: another → is a no-op, not
    // a wrap back to the backend.
    app.press("", { rightArrow: true });
    expect(app.at().composerSwitch?.kind).toBe("model");
    app.press("", { leftArrow: true });
    expect(app.at().composerSwitch?.kind).toBe("provider");
  });

  it("←→ skip the provider switch on the managed-local route", () => {
    // That route draws no provider control — its second control is the
    // model and the third (daemon status) is a deep link, not a switch —
    // so the walk stepping onto "provider" would open a popup with no
    // control under it.
    const app = driver(localState());
    app.press("r", { ctrl: true });
    app.press("", { rightArrow: true });
    expect(app.at().composerSwitch?.kind).toBe("model");
    app.press("", { leftArrow: true });
    expect(app.at().composerSwitch?.kind).toBe("backend");
  });

  it("moving to another control re-seats the cursor on its live row", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("", { rightArrow: true });
    // openrouter is the active provider and the first row.
    expect(app.at().composerSwitch).toEqual({
      kind: "provider",
      cursor: 0,
      filter: "",
    });
  });

  it("Enter hands the selected row to the activator", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("", { downArrow: true });
    expect(app.press("", { return: true })).toBe(true);
    expect(app.picked.map((row) => row.label)).toEqual(["local"]);
  });

  it("Esc closes without picking anything", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    expect(app.press("", { escape: true })).toBe(true);
    expect(app.at().composerSwitch).toBeNull();
    expect(app.picked).toEqual([]);
  });

  it("ctrl+r closes the strip it opened", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("r", { ctrl: true });
    expect(app.at().composerSwitch).toBeNull();
  });

  it("lets ctrl-chords through so the global chords stay live from inside", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    // The `ctrl+g` leader must still arm and `ctrl+c` still abort —
    // the switch declines both so the rung below can claim them.
    expect(app.press("g", { ctrl: true })).toBe(false);
    expect(app.press("c", { ctrl: true })).toBe(false);
  });

  it("consumes ordinary typing so it cannot leak into the composer", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    expect(app.press("x")).toBe(true);
    expect(app.press("", { tab: true })).toBe(true);
  });
});

describe("the typed filter", () => {
  it("printable keys narrow the list and re-seat the cursor on top", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("", { downArrow: true });
    app.press("l");
    app.press("o");
    expect(app.at().composerSwitch).toEqual({
      kind: "backend",
      cursor: 0,
      filter: "lo",
    });
  });

  it("filters what Enter picks, not just what is drawn", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    // "loc" leaves only the local backend of cloud/local/custom.
    for (const ch of "loc") app.press(ch);
    app.press("", { return: true });
    expect(app.picked.map((row) => row.label)).toEqual(["local"]);
  });

  it("backspace shortens the query one character at a time", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("c");
    app.press("u");
    app.press("", { backspace: true });
    expect(app.at().composerSwitch?.filter).toBe("c");
    // At an empty query backspace is a no-op, not a close.
    app.press("", { backspace: true });
    app.press("", { backspace: true });
    expect(app.at().composerSwitch).not.toBeNull();
  });

  it("Esc clears the filter first and closes only when it is empty", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("q");
    expect(app.press("", { escape: true })).toBe(true);
    expect(app.at().composerSwitch).toEqual({
      kind: "backend",
      cursor: 0,
      filter: "",
    });
    app.press("", { escape: true });
    expect(app.at().composerSwitch).toBeNull();
  });

  it("walking to another control drops the previous control's filter", () => {
    const app = driver(cloudState());
    app.press("r", { ctrl: true });
    app.press("z");
    app.press("", { rightArrow: true });
    expect(app.at().composerSwitch).toEqual({
      kind: "provider",
      cursor: 0,
      filter: "",
    });
  });
});
