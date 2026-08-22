/**
 * Everything that dismisses the splash, in one place.
 *
 * The screen promises "press any key", so it listens on all three
 * channels a terminal can speak on: Ink's keystrokes, Ink's
 * bracketed-paste stream, and the decoded mouse reports the TUI parses
 * itself. Keeping them together is what makes the two-stage rule — one
 * input finishes the tagline, the next moves on — a single counter
 * rather than three that can disagree.
 *
 * The mouse half is silent when the operator turned reporting off
 * (`tui.mouse`, `--no-mouse`): `tui-command.ts` stops emitting events at
 * the source, so the target registered here simply never fires and the
 * splash stays keyboard-only.
 */
import type { DOMElement } from "ink";
import { useInput, usePaste } from "ink";
import { useCallback, useRef, useState, type RefObject } from "react";
import { useMouseTarget } from "../mouse/mouse-context.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { mouseAdvancesIntro, pasteAdvancesIntro } from "./intro-input.js";
import { handleOnboardingKey } from "./onboarding-key-bindings.js";
import type { OnboardingUiState } from "./onboarding-state.js";

export interface IntroInputResult {
  /** Attach to the box covering the splash to make all of it clickable. */
  readonly ref: RefObject<DOMElement | null>;
  /** True once the first input landed: finish the tagline immediately. */
  readonly skipAnimation: boolean;
}

export function useIntroInput(options: {
  onboarding: OnboardingUiState;
  /** Runs on the input that dismisses the splash, not on the first one. */
  onDismiss: () => void;
}): IntroInputResult {
  const { onboarding, onDismiss } = options;
  const active = onboarding.step === "intro";
  const [skipAnimation, setSkipAnimation] = useState(false);
  // The state drives the render; the ref decides. Two clicks can land
  // inside one render pass, and the second has to see what the first
  // did or the splash eats them both.
  const skipped = useRef(false);

  const advance = useCallback(() => {
    // First input finishes the reveal, second moves on: a splash that
    // cannot be hurried is a wait, and one that vanishes on the key that
    // was meant to hurry it is a screen nobody ever reads.
    if (!skipped.current) {
      skipped.current = true;
      setSkipAnimation(true);
      return;
    }
    onDismiss();
  }, [onDismiss]);

  useInput(
    (input, key) => {
      const result = handleOnboardingKey(input, key, onboarding);
      if (result.handled && result.intent?.kind === "intro_key") advance();
    },
    { isActive: active },
  );

  usePaste(
    (text) => {
      if (pasteAdvancesIntro(text)) advance();
    },
    { isActive: active },
  );

  const ref = useMouseTarget(
    (hit) => {
      if (mouseAdvancesIntro(hit.event)) advance();
      // Claimed either way. The splash owns the whole terminal while it
      // is up, so a report it did not use must not reach what is behind
      // it — the app's viewport-wide wheel target would otherwise scroll
      // a chat log nobody can see.
      return true;
    },
    // Above the base layer for the same reason: that wheel target covers
    // the viewport too, and layer is the only tie-break that does not
    // depend on which effect happened to register first.
    { layer: MOUSE_LAYER_PANEL, enabled: active },
  );

  return { ref, skipAnimation };
}
