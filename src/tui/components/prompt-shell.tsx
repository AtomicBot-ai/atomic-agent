import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useRotatingPlaceholder } from "../hooks/use-rotating-placeholder.js";
import { theme } from "../theme/theme.js";
import { MultiLineEditor, type MultiLineEditorProps } from "./multi-line-editor.js";

/**
 * Visual shell around `MultiLineEditor` modelled after the opencode
 * prompt: a left "tail" column terminated by a `╹` cap, optional
 * rotating placeholder, and a meta-row underneath that surfaces the
 * active model. The editor itself runs in `bare` mode so the chrome is
 * fully owned here.
 *
 * Out-of-scope (deferred for parity with opencode):
 *   - bracketed paste with image bytes (Ink delivers cooked stdin)
 *   - mouse interactions / hover (Ink has no mouse layer)
 *   - extmark "chips" inside the textarea (e.g. coloured `@file.ts`)
 *   - alpha / fade-in animations on the meta-row
 *
 * The shell does **not** open the autocomplete popup — slash-palette
 * stays where it lived before, rendered by the parent above the editor.
 */
export interface PromptShellProps
  extends Omit<MultiLineEditorProps, "bare" | "placeholder"> {
  /** Static placeholder shown when the rotating list is empty / unset. */
  placeholder?: string;
  /**
   * Optional rotating hints, cycled every `placeholderRotationMs` while
   * the input buffer is empty. The first phrase is picked at random.
   * Pass an empty array (or omit) to disable rotation and fall back to
   * the static `placeholder`.
   */
  rotatingPlaceholders?: readonly string[];
  /** Rotation period in milliseconds. Defaults to 4000. */
  placeholderRotationMs?: number;
  /** Active model alias rendered into the meta-row (e.g. `qwen3-30b`). */
  model?: string | null;
  /**
   * Optional provider hint shown after the model (e.g. `llama.cpp`).
   * Falls back to a single dot separator when both are present.
   */
  provider?: string | null;
  /**
   * Optional content rendered at the start of the meta-row, before the
   * model/provider labels. Used by the chat surface to show the live
   * LLM health pill. Separated by a dot from the model when both are
   * present.
   */
  leftSlot?: ReactElement | null;
  /** Optional content rendered on the right-hand side of the meta-row. */
  rightSlot?: ReactElement | null;
}

export function PromptShell(props: PromptShellProps): ReactElement {
  const {
    placeholder,
    rotatingPlaceholders,
    placeholderRotationMs = 4000,
    model,
    provider,
    leftSlot,
    rightSlot,
    focus,
    disabled,
    value,
    ...editorProps
  } = props;
  const rotated = useRotatingPlaceholder(
    rotatingPlaceholders ?? [],
    placeholderRotationMs,
  );
  const effectivePlaceholder =
    value.length === 0 ? (rotated ?? placeholder ?? "") : "";
  const accent = focus && !disabled ? theme.colors.accent : theme.colors.border;
  // Render the meta-row whenever any slot is occupied. With the live
  // LLM-health pill being a permanent left-slot tenant, this means the
  // row is effectively always rendered after mount — keeping the
  // layout stable so the input does not jump up by one cell the moment
  // `/props` lands.
  const showMeta =
    Boolean(model) ||
    Boolean(provider) ||
    Boolean(leftSlot) ||
    Boolean(rightSlot);
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box
        borderStyle="single"
        borderColor={accent}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={1}
        paddingTop={1}
        paddingRight={1}
        flexDirection="column"
      >
        <MultiLineEditor
          {...editorProps}
          value={value}
          focus={focus}
          disabled={disabled}
          placeholder={effectivePlaceholder}
          bare
        />
        {showMeta ? (
          <Box marginTop={1} flexDirection="row" justifyContent="space-between">
            <MetaLeft
              leftSlot={leftSlot ?? null}
              model={model ?? null}
              provider={provider ?? null}
            />
            {rightSlot ? <Box>{rightSlot}</Box> : null}
          </Box>
        ) : null}
      </Box>
      <Text color={accent}>╹</Text>
    </Box>
  );
}

interface MetaLeftProps {
  leftSlot: ReactElement | null;
  model: string | null;
  provider: string | null;
}

const MODEL_LABEL_MAX_LEN = 32;

function MetaLeft({
  leftSlot,
  model,
  provider,
}: MetaLeftProps): ReactElement {
  if (!leftSlot && !model && !provider) {
    return <Text> </Text>;
  }
  const cleanModel = model ? formatModel(model) : null;
  // Wrap the optional `leftSlot` in a `<Text>` so neighbouring spans
  // (a leading dot separator before the model) stay on the same line
  // without Yoga inserting an inline break between Box children.
  return (
    <Text>
      {leftSlot ? <Text>{leftSlot}</Text> : null}
      {leftSlot && (cleanModel || provider) ? (
        <Text color={theme.colors.muted}>
          {" "}
          {theme.glyphs.dotSeparator}{" "}
        </Text>
      ) : null}
      {cleanModel ? (
        <Text color={theme.colors.accentSoft} bold>
          {cleanModel}
        </Text>
      ) : null}
      {cleanModel && provider ? (
        <Text color={theme.colors.muted}>
          {" "}
          {theme.glyphs.dotSeparator}{" "}
        </Text>
      ) : null}
      {provider ? (
        <Text color={theme.colors.muted}>{provider}</Text>
      ) : null}
    </Text>
  );
}

function formatModel(model: string): string {
  const stripped = model.replace(/\.gguf$/i, "");
  if (stripped.length <= MODEL_LABEL_MAX_LEN) return stripped;
  return `${stripped.slice(0, MODEL_LABEL_MAX_LEN - 1)}…`;
}
