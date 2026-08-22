import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import { theme } from "../theme/theme.js";
import { MultiLineEditor } from "./multi-line-editor.js";

const TITLE_LINE = "Which model? (it has to be a GGUF build)";
const EXAMPLES_LINE =
  "unsloth/Qwen3.5-4B-GGUF · https://huggingface.co/owner/repo · a link to one .gguf";
/** The error box is capped at this measure so long messages wrap. */
const ERROR_COLUMNS = 72;

/** Widest line this step draws, for the block that centres it. */
export function measureOnboardingHfRefStep(error: string | null): number {
  const lines = [TITLE_LINE, EXAMPLES_LINE];
  if (error) lines.push(" ".repeat(Math.min(ERROR_COLUMNS, error.length)));
  return widestLine(lines);
}

/**
 * Name a model on Hugging Face. Whatever the operator has on the
 * clipboard — the repo page, a link straight to one `.gguf`, or the id
 * on its own — should work, so the examples show all three rather than
 * teaching one canonical form.
 *
 * Everything that can go wrong here (a repo with no GGUF in it, a gated
 * one, a typo) is reported on this screen, because this is the screen
 * that asked the question.
 */
export function OnboardingHuggingFaceRefStep(props: {
  value: string;
  busy: boolean;
  error: string | null;
  onChange(value: string): void;
  onSubmit(value: string): void;
  /** Empty the reference AND drop its error — `[ clear ]` / ctrl+l. */
  onClear(): void;
  onBack(): void;
}): ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        Which model? <Text color={theme.colors.muted}>(it has to be a GGUF build)</Text>
      </Text>
      <Text color={theme.colors.muted}>{EXAMPLES_LINE}</Text>
      <Box marginTop={1}>
        <MultiLineEditor
          value={props.value}
          focus={!props.busy}
          disabled={props.busy}
          placeholder="owner/repo"
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          onEscape={props.onBack}
          // On the flow's own layer, or the whole-surface backstop —
          // same layer, far bigger box — would swallow the click before
          // click-to-caret could see it.
          mouseLayer={MOUSE_LAYER_PANEL}
        />
      </Box>
      {/*
        Below the input, above the error box. Hidden while the lookup
        runs (the editor is read-only then and Esc already cancels) and
        while there is nothing to clear. A row wrapper so the target hugs
        the label instead of claiming the whole line — see
        `ChatCopyButton` for the precedent. The chord lives in the
        footer; the click and ctrl+l share one handler upstream.
      */}
      {!props.busy && props.value.length > 0 ? (
        <Box flexDirection="row">
          <MouseTarget
            layer={MOUSE_LAYER_PANEL}
            flexShrink={0}
            onMouse={(hit) => {
              if (!isPrimaryPress(hit.event)) return false;
              props.onClear();
              return true;
            }}
          >
            <Text color={theme.colors.muted} dimColor>
              [ clear ]
            </Text>
          </MouseTarget>
        </Box>
      ) : null}
      {props.busy ? (
        <Text color={theme.colors.muted}>asking huggingface.co…</Text>
      ) : null}
      {props.error ? (
        <Box marginTop={1} width={ERROR_COLUMNS}>
          <Text color={theme.colors.error} wrap="wrap">
            {props.error}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
