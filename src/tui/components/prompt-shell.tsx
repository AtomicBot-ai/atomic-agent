import { Box } from "ink";
import type { ReactElement } from "react";
import { useRotatingPlaceholder } from "../hooks/use-rotating-placeholder.js";
import { theme } from "../theme/theme.js";
import { MultiLineEditor, type MultiLineEditorProps } from "./multi-line-editor.js";
import { PromptMetaBar } from "./prompt-meta-bar.js";

/**
 * The composer: a framed input field with a toolbar under it.
 *
 * It used to be an opencode-style left "tail" — a single border column
 * down the left of the editor, capped by a `╹`. That reads as a quote
 * block, not as a place you type into, and it gave the two things the
 * composer needs to advertise (send, reference a file) nowhere to live.
 * A closed frame plus an action bar is the shape every operator already
 * knows from every other message box they have used, and it costs one
 * row *less* than the tail did: border, editor, bar, border — where the
 * tail spent a top pad, a blank row above the meta and the cap glyph.
 *
 * The frame is deliberately the app's only fully-boxed surface besides
 * modals. Bounded height matters: Ink 7 does not clip a frame taller
 * than the terminal, it overlaps the lines above it (the hazard
 * `splash-fit.ts` exists to document), so the composer grows only with
 * the buffer the operator typed and never with its own chrome.
 *
 * Out-of-scope (deferred for parity with opencode):
 *   - bracketed paste with image bytes (Ink delivers cooked stdin)
 *   - extmark "chips" inside the textarea (e.g. coloured `@file.ts`)
 *   - alpha / fade-in animations on the action bar
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
  /** Active model alias rendered into the action bar (e.g. `qwen3-30b`). */
  model?: string | null;
  /**
   * Optional provider hint shown after the model (e.g. `llama.cpp`).
   * Falls back to a single dot separator when both are present.
   */
  provider?: string | null;
  /**
   * Optional content rendered at the start of the action bar, before the
   * model/provider labels. Used by the chat surface to show the live
   * LLM health pill. Separated by a dot from the model when both are
   * present.
   */
  leftSlot?: ReactElement | null;
  /** Optional content rendered just before the buttons on the right. */
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
    onChange,
    onSubmit,
    ...editorProps
  } = props;
  const rotated = useRotatingPlaceholder(
    rotatingPlaceholders ?? [],
    placeholderRotationMs,
  );
  const effectivePlaceholder =
    value.length === 0 ? (rotated ?? placeholder ?? "") : "";
  const accent = focus && !disabled ? theme.colors.accent : theme.colors.border;
  // Send is live on exactly the condition Enter is: a non-blank buffer
  // in an editor that is accepting input. `handleEditorSubmit` drops a
  // blank buffer anyway, but a button that visibly does nothing when
  // pressed is a bug report waiting to happen.
  const canSend = !disabled && value.trim().length > 0;
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      {/*
        The design seats the composer on its own panel rather than on the
        page. `badgeBackground` is the palette's one-step-off-the-ground
        surface, so the panel reads on every theme — and, unlike painting
        it in the accent, it leaves the editor's own (uncoloured) text
        legible, which matters because the buffer is drawn by
        `MultiLineEditor` with no foreground of its own.
      */}
      <Box
        borderStyle="round"
        borderColor={accent}
        backgroundColor={theme.colors.badgeBackground}
        flexDirection="column"
      >
        {/*
          Padding lives on the editor row, not on the frame: the action
          bar has to reach both borders for its ground to read as a
          toolbar rather than as a floating stripe.
        */}
        <Box paddingX={1} flexDirection="column">
          <MultiLineEditor
            {...editorProps}
            value={value}
            focus={focus}
            disabled={disabled}
            onChange={onChange}
            onSubmit={onSubmit}
            placeholder={effectivePlaceholder}
            bare
          />
        </Box>
        <PromptMetaBar
          leftSlot={leftSlot ?? null}
          model={model ?? null}
          provider={provider ?? null}
          rightSlot={rightSlot ?? null}
          canSend={canSend}
          // Exactly the callback Enter fires, with exactly the buffer
          // Enter would submit. A second submit path would be a second
          // place for slash-command handling and the busy-mode queue to
          // drift out of sync.
          onSend={() => onSubmit(value)}
        />
      </Box>
    </Box>
  );
}
