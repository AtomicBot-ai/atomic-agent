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

  it("claims every key on the splash, Esc included", () => {
    const intro = base({ step: "intro" });
    expect(handleOnboardingKey("x", NO_KEY, intro)).toEqual({
      handled: true,
      actions: [],
      intent: { kind: "intro_key" },
    });
    expect(handleOnboardingKey("", key({ escape: true }), intro)).toEqual({
      handled: true,
      actions: [],
      intent: { kind: "intro_key" },
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
