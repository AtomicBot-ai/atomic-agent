import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { MouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { theme } from "../theme/theme.js";
import { MultiLineEditor } from "./multi-line-editor.js";

export const HF_REF_TITLE_LINE = "Which model? (it has to be a GGUF build)";
export const HF_REF_EXAMPLES_LINE =
  "unsloth/Qwen3.5-4B-GGUF · https://huggingface.co/owner/repo · a link to one .gguf";
/** The error box is capped at this measure so long messages wrap. */
export const HF_REF_ERROR_COLUMNS = 72;

/**
 * "Name a model on Hugging Face" — one editor the first-run flow and
 * the Models pane both mount.
 *
 * Whatever the operator has on the clipboard — the repo page, a link
 * straight to one `.gguf`, or the id on its own — should work, so the
 * examples show all three rather than teaching one canonical form.
 *
 * Everything that can go wrong (a repo with no GGUF in it, a gated one,
 * a typo) is reported here, because this is the screen that asked the
 * question. The two flows differ only in where Escape goes, which is
 * why that is a prop and nothing else is.
 */
export function HfReferenceEditor(props: {
  value: string;
  busy: boolean;
  error: string | null;
  onChange(value: string): void;
  onSubmit(value: string): void;
  /** Empty the reference AND drop its error — `[ clear ]` / ctrl+l. */
  onClear(): void;
  onEscape(): void;
  mouseLayer?: number;
}): ReactElement {
  const layer = props.mouseLayer ?? MOUSE_LAYER_PANEL;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        Which model? <Text color={theme.colors.muted}>(it has to be a GGUF build)</Text>
      </Text>
      <Text color={theme.colors.muted}>{HF_REF_EXAMPLES_LINE}</Text>
      <Box marginTop={1}>
        <MultiLineEditor
          value={props.value}
          focus={!props.busy}
          disabled={props.busy}
          placeholder="owner/repo"
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          onEscape={props.onEscape}
          // On the panel layer, or a whole-surface backstop would
          // swallow the click before click-to-caret could see it.
          mouseLayer={layer}
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
            layer={layer}
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
        <Box marginTop={1} width={HF_REF_ERROR_COLUMNS}>
          <Text color={theme.colors.error} wrap="wrap">
            {props.error}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
