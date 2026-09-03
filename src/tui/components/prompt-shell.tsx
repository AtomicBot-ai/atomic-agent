import { Box } from "ink";
import type { ReactElement } from "react";
import type { ComposerBackendMeta } from "../composer-switch/composer-switch-rows.js";
import { useRotatingPlaceholder } from "../hooks/use-rotating-placeholder.js";
import { readableOn } from "../theme/readable-foreground.js";
import { theme } from "../theme/theme.js";
import { ComposerSendButton } from "./composer-send-button.js";
import { ComposerStopButton } from "./composer-stop-button.js";
import { MultiLineEditor, type MultiLineEditorProps } from "./multi-line-editor.js";
import { PromptMetaBar } from "./prompt-meta-bar.js";

/**
 * The composer: a framed input field with Send in it and a toolbar under
 * it.
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
 * Send sits **inside** the field, on the right of the buffer row, rather
 * than on the bar under it: it is the verb for the text beside it, and
 * keeping it out of the bar leaves that row free for the status readouts
 * the chat surface passes in.
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
  /**
   * The route's backend kind (cloud / local / custom) and its health
   * dot, rendered as the first of the action bar's three controls.
   */
  backend?: ComposerBackendMeta | null;
  /** Active model alias rendered into the action bar (e.g. `qwen3-30b`). */
  model?: string | null;
  /**
   * Optional provider hint shown after the model (e.g. `llama.cpp`).
   * Falls back to a single dot separator when both are present.
   */
  provider?: string | null;
  /**
   * Turns the model slot into a `download model` call to action —
   * managed-local route with nothing on disk to run.
   */
  needsModelDownload?: boolean;
  /**
   * Optional content rendered at the start of the action bar, before the
   * model/provider labels. Used by the chat surface to show the live
   * LLM health pill. Separated by a dot from the model when both are
   * present.
   */
  leftSlot?: ReactElement | null;
  /** Optional content rendered at the toolbar's right end. */
  rightSlot?: ReactElement | null;
  /** Optional context readout, rendered at the action bar's right end. */
  contextSlot?: ReactElement | null;
  modeSlot?: ReactElement | null;
  /**
   * A turn is in flight. Puts the stop chip into the field, next to
   * Send — the one moment the composer has a destructive verb to offer.
   */
  running?: boolean;
  /**
   * Stop the running turn. The chat surface passes the same path Esc
   * takes; the chip renders only when both `running` and this are set.
   */
  onStop?: () => void;
}

export function PromptShell(props: PromptShellProps): ReactElement {
  const {
    placeholder,
    rotatingPlaceholders,
    placeholderRotationMs = 4000,
    backend,
    model,
    provider,
    needsModelDownload,
    leftSlot,
    rightSlot,
    contextSlot,
    modeSlot,
    running,
    onStop,
    focus,
    disabled,
    value,
    onChange,
    onSubmit,
    mouseLayer,
    ...editorProps
  } = props;
  // Rotate only while the phrase is on screen. `effectivePlaceholder`
  // below already blanks it for a non-empty buffer; without the same
  // condition on the timer, typing left a four-second full-frame repaint
  // running behind the composer for the rest of the session.
  const placeholderVisible = value.length === 0;
  const rotated = useRotatingPlaceholder(
    rotatingPlaceholders ?? [],
    placeholderRotationMs,
    placeholderVisible,
  );
  const effectivePlaceholder = placeholderVisible
    ? (rotated ?? placeholder ?? "")
    : "";
  const accent = focus && !disabled ? theme.colors.accent : theme.colors.border;
  // Measured, not assumed: `readableOn` weighs the panel's ground
  // against both ends of the palette's chip pair and takes the better
  // one, so the buffer stays legible whichever side of the line the
  // active theme sits on.
  const composerInk = readableOn(theme.colors.badgeBackground);
  // Send is live on exactly the condition Enter is: a non-blank buffer
  // in an editor that is accepting input. `handleEditorSubmit` drops a
  // blank buffer anyway, but a button that visibly does nothing when
  // pressed is a bug report waiting to happen.
  const canSend = !disabled && value.trim().length > 0;
  return (
    // The breathing row that used to be `marginTop={1}` here lives in
    // `ComposerOverlay` now: a margin inside the overlay's mouse
    // backstop would count into its rectangle and turn the one
    // see-through row above the frame click-dead.
    <Box flexDirection="column" flexShrink={0}>
      {/*
        The design seats the composer on its own panel rather than on the
        page. `badgeBackground` is the palette's one-step-off-the-ground
        surface, so the panel reads on every theme.

        It used to rely on the buffer being *uncoloured* — inheriting the
        terminal's default ink — and that assumption only holds while the
        panel and the terminal are on the same side of the light/dark
        line. They need not be: `classic-light` paints `#dde4f4` here, so
        anyone running a light palette in a dark terminal typed light
        text onto a light panel and could not read what they were
        writing. The ink is measured against the ground now, the same way
        every chip does it.
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

          `paddingY` gives the buffer a blank row above and below. The
          rows carry no colour of their own, so the panel's
          `badgeBackground` shows through them and they read as the
          field's own padding rather than as gaps in it.
        */}
        <Box
          paddingX={1}
          paddingY={1}
          flexDirection="row"
          // One line of buffer and the button is beside it either way;
          // the choice only bites once the message grows. Bottom keeps
          // Send next to the line being typed, which is where the eye
          // already is — centring it against a ten-line paste would
          // strand the button halfway up a wall of text.
          alignItems={value.includes("\n") ? "flex-end" : "center"}
        >
          {/*
            `minWidth={0}` is what lets the editor actually give up the
            columns the button takes: a Yoga flex child defaults to its
            content's min-width, so without this the row would overflow
            the frame instead of the text rewrapping.
          */}
          <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column">
            <MultiLineEditor
              {...editorProps}
              textColor={composerInk}
              value={value}
              focus={focus}
              disabled={disabled}
              onChange={onChange}
              onSubmit={onSubmit}
              placeholder={effectivePlaceholder}
              mouseLayer={mouseLayer}
              bare
            />
          </Box>
          {running && onStop ? (
            <Box flexShrink={0} marginLeft={1}>
              {/*
                Stop sits between the buffer and Send, on exactly the
                turns it can act on. Inside the field like Send, and for
                the same reason: it is a verb for the run the operator
                is watching, and the bar below already spends its slots
                on status readouts.
              */}
              <ComposerStopButton onPress={onStop} layer={mouseLayer} />
            </Box>
          ) : null}
          <Box flexShrink={0} marginLeft={1}>
            <ComposerSendButton
              enabled={canSend}
              // The shell floats over the chat log, so its controls
              // register on the same raised layer as the overlay's
              // backstop — see `composer-overlay.tsx`.
              layer={mouseLayer}
              // Exactly the callback Enter fires, with exactly the
              // buffer Enter would submit. A second submit path would be
              // a second place for slash-command handling and the
              // busy-mode queue to drift out of sync.
              onPress={() => onSubmit(value)}
            />
          </Box>
        </Box>
        <PromptMetaBar
          leftSlot={leftSlot ?? null}
          backend={backend ?? null}
          model={model ?? null}
          provider={provider ?? null}
          needsModelDownload={needsModelDownload ?? false}
          rightSlot={rightSlot ?? null}
          contextSlot={contextSlot ?? null}
          modeSlot={modeSlot ?? null}
          // Same raised layer as the overlay backstop behind the bar —
          // see `composer-overlay.tsx`.
          mouseLayer={mouseLayer}
        />
      </Box>
    </Box>
  );
}
