import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { handleOnboardingKey } from "./onboarding-key-bindings.js";
import { createOnboardingState, type OnboardingUiState } from "./onboarding-state.js";

const NO_KEY: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, return: false, escape: false, ctrl: false,
  shift: false, tab: false, backspace: false, delete: false, meta: false,
  home: false, end: false,
} as Key;

const key = (over: Partial<Key>): Key => ({ ...NO_KEY, ...over });
/** The flow opens on the splash; these cases are about the choice screen. */
const base = (over: Partial<OnboardingUiState> = {}): OnboardingUiState => ({
  ...createOnboardingState("http://127.0.0.1:8080"),
  step: "choose",
  ...over,
});

describe("handleOnboardingKey", () => {
  it("moves the cursor with arrows and vim keys", () => {
    expect(handleOnboardingKey("", key({ downArrow: true }), base())).toEqual({
      handled: true,
      actions: [{ type: "onboarding_cursor_moved", delta: 1 }],
    });
    expect(handleOnboardingKey("k", NO_KEY, base())).toEqual({
      handled: true,
      actions: [{ type: "onboarding_cursor_moved", delta: -1 }],
    });
  });

  it("picks the row under the cursor on Enter", () => {
    const result = handleOnboardingKey("", key({ return: true }), base({ cursor: 1 }));
    expect(result).toEqual({ handled: true, actions: [], intent: { kind: "pick", choice: "cloud" } });
  });

  it("maps the digit shortcuts positionally", () => {
    const result = handleOnboardingKey("3", NO_KEY, base());
    expect(result).toEqual({
      handled: true,
      actions: [{ type: "onboarding_cursor_set", cursor: 2 }],
      intent: { kind: "pick", choice: "custom" },
    });
  });

  it("treats Esc as skip", () => {
    expect(handleOnboardingKey("", key({ escape: true }), base())).toEqual({
      handled: true,
      actions: [],
      intent: { kind: "skip" },
    });
  });

  /**
   * The whole inventory of what a terminal can send, as Ink reports it
   * after `parse-keypress.ts`. Every one of them has to dismiss the
   * splash, because the splash says "any key" and means it.
   */
  const INTRO_INVENTORY: readonly { name: string; input: string; key: Partial<Key> }[] = [
    { name: "a letter", input: "x", key: {} },
    { name: "a digit", input: "7", key: {} },
    { name: "space", input: " ", key: {} },
    { name: "enter", input: "", key: { return: true } },
    { name: "escape", input: "", key: { escape: true } },
    { name: "tab", input: "", key: { tab: true } },
    { name: "shift+tab", input: "", key: { tab: true, shift: true } },
    { name: "backspace", input: "", key: { backspace: true } },
    { name: "delete", input: "", key: { delete: true } },
    { name: "up", input: "", key: { upArrow: true } },
    { name: "down", input: "", key: { downArrow: true } },
    { name: "left", input: "", key: { leftArrow: true } },
    { name: "right", input: "", key: { rightArrow: true } },
    { name: "home", input: "", key: { home: true } },
    { name: "end", input: "", key: { end: true } },
    { name: "page up", input: "", key: { pageUp: true } },
    { name: "page down", input: "", key: { pageDown: true } },
    // F1–F12 and Insert have no field on Ink's `Key` and their input is
    // blanked by `nonAlphanumericKeys`, so this all-empty shape is what
    // the handler actually receives for them.
    { name: "a function key", input: "", key: {} },
    { name: "alt+f", input: "f", key: { meta: true } },
    { name: "a ctrl chord that is not ctrl+c", input: "d", key: { ctrl: true } },
  ];

  for (const testCase of INTRO_INVENTORY) {
    it(`dismisses the splash on ${testCase.name}`, () => {
      const result = handleOnboardingKey(
        testCase.input,
        key(testCase.key),
        base({ step: "intro" }),
      );
      expect(result).toEqual({
        handled: true,
        actions: [],
        intent: { kind: "intro_key" },
      });
    });
  }

  it("does not claim ctrl+c on the splash either", () => {
    expect(handleOnboardingKey("c", key({ ctrl: true }), base({ step: "intro" }))).toEqual({
      handled: false,
    });
  });

  it("lets Ctrl+C through so quitting works during setup", () => {
    expect(handleOnboardingKey("c", key({ ctrl: true }), base())).toEqual({ handled: false });
  });

  it("swallows unknown keys — there is nothing behind the flow to reach", () => {
    expect(handleOnboardingKey("z", NO_KEY, base())).toEqual({ handled: true, actions: [] });
  });

  it("acts on nothing while a child owns the keyboard, but still swallows", () => {
    for (const step of ["cloud", "custom_chat_url", "custom_embedding_url"] as const) {
      const result = handleOnboardingKey("", key({ escape: true }), base({ step }));
      expect(result).toEqual({ handled: true, actions: [] });
    }
  });
});
