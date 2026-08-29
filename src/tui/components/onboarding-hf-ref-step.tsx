import type { ReactElement } from "react";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import {
  HfReferenceEditor,
  HF_REF_ERROR_COLUMNS,
  HF_REF_EXAMPLES_LINE,
  HF_REF_TITLE_LINE,
} from "./hf-reference-editor.js";

/** Widest line this step draws, for the block that centres it. */
export function measureOnboardingHfRefStep(error: string | null): number {
  const lines = [HF_REF_TITLE_LINE, HF_REF_EXAMPLES_LINE];
  if (error) lines.push(" ".repeat(Math.min(HF_REF_ERROR_COLUMNS, error.length)));
  return widestLine(lines);
}

/**
 * The first-run flow's Hugging Face reference editor: the shared
 * `HfReferenceEditor` with Escape wired back to the local-model pick
 * step. The Models pane mounts the same editor with Escape wired to its
 * own list.
 */
export function OnboardingHuggingFaceRefStep(props: {
  value: string;
  busy: boolean;
  error: string | null;
  onChange(value: string): void;
  onSubmit(value: string): void;
  onClear(): void;
  onBack(): void;
}): ReactElement {
  return (
    <HfReferenceEditor
      value={props.value}
      busy={props.busy}
      error={props.error}
      onChange={props.onChange}
      onSubmit={props.onSubmit}
      onClear={props.onClear}
      onEscape={props.onBack}
      mouseLayer={MOUSE_LAYER_PANEL}
    />
  );
}
