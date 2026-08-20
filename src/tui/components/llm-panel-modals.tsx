import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { ProvidersWizard } from "./providers-wizard.js";
import { parseExternalUrl } from "../llm-panel/llm-panel-modal-key-bindings.js";
import { filteredPickerModels } from "../providers/providers-panel-state.js";

/** Upper bound for the picker's list window (roomy terminals). */
const PICKER_MAX_WINDOW = 12;
/** Never shrink the list window below this many rows. */
const PICKER_MIN_WINDOW = 3;
/**
 * Picker box rows that are not list rows: two border lines, the title,
 * the filter/status line, the footer, and the box's bottom margin.
 */
const PICKER_CHROME_ROWS = 6;

/**
 * List rows the picker shows. Sized from the tab's row budget so short
 * terminals get a smaller (but still fixed) window instead of a frame
 * that outgrows the screen.
 */
function pickerWindowRows(maxRows: number | undefined): number {
  if (maxRows === undefined) return PICKER_MAX_WINDOW;
  return Math.max(
    PICKER_MIN_WINDOW,
    Math.min(PICKER_MAX_WINDOW, maxRows - PICKER_CHROME_ROWS),
  );
}

/** `count` blank lines that hold a box at its fixed height. */
function blankRows(count: number): ReactElement[] {
  return Array.from({ length: count }, (_unused, i) => (
    <Text key={`pad-${i}`}> </Text>
  ));
}

/**
 * True when one of the boxes below owns the screen.
 *
 * `handleLlmModalKey` returns non-null for exactly these states, i.e.
 * the panel behind a modal cannot be driven while one is open. It must
 * therefore not be DRAWN either: the panel already spends the whole tab
 * budget, so drawing a modal on top of it is a frame taller than the
 * terminal, and Ink 7 resolves that by overwriting earlier lines rather
 * than clipping. Callers use this to hand the modal the full budget and
 * render nothing else.
 */
export function hasLlmModal(state: TuiState): boolean {
  return (
    state.providersPanel.wizard !== null ||
    state.providersPanel.removeConfirm !== null ||
    state.localModelsPanel.embeddingOnboardingPrompt !== null ||
    state.localModelsPanel.removeConfirmId !== null ||
    state.localModelsPanel.embeddingRemoveConfirmId !== null ||
    state.providersPanel.chatModelPicker !== null ||
    state.llmPanel.externalUrlDraft !== null ||
    state.llmPanel.stopLocalDaemonsPrompt !== null
  );
}

export function LlmPanelModals({
  state,
  maxRows,
}: {
  state: TuiState;
  maxRows?: number;
}): ReactElement | null {
  if (state.providersPanel.wizard) {
    return (
      <ProvidersWizard
        wizard={state.providersPanel.wizard}
        {...(maxRows === undefined ? {} : { maxRows })}
      />
    );
  }
  if (state.providersPanel.removeConfirm) {
    return (
      <PromptBox tone="danger" title={`Remove provider ${state.providersPanel.removeConfirm.id}?`}>
        <Text color={theme.colors.muted}>y confirm · n/Esc cancel</Text>
      </PromptBox>
    );
  }
  if (state.localModelsPanel.embeddingOnboardingPrompt) {
    const p = state.localModelsPanel.embeddingOnboardingPrompt;
    return (
      <PromptBox tone="accent" title="Download embedding model for hybrid recall?">
        <Text>
          {p.name} <Text color={theme.colors.muted}>({p.sizeLabel})</Text>
        </Text>
        <Text color={theme.colors.muted}>y download + enable · n/Esc skip</Text>
      </PromptBox>
    );
  }
  if (state.localModelsPanel.removeConfirmId) {
    return (
      <PromptBox tone="danger" title={`Delete local model ${state.localModelsPanel.removeConfirmId}?`}>
        <Text color={theme.colors.muted}>Removes GGUF/mmproj files. y confirm · n/Esc cancel</Text>
      </PromptBox>
    );
  }
  if (state.localModelsPanel.embeddingRemoveConfirmId) {
    return (
      <PromptBox
        tone="danger"
        title={`Delete local embedding model ${state.localModelsPanel.embeddingRemoveConfirmId}?`}
      >
        <Text color={theme.colors.muted}>y confirm · n/Esc cancel</Text>
      </PromptBox>
    );
  }
  if (state.providersPanel.chatModelPicker !== null) {
    const picker = state.providersPanel.chatModelPicker;
    // Fixed-height picker: every status branch (loading, ready, error)
    // renders the same number of lines, and the ready branch pads its
    // list area with blanks up to a constant window. Rationale: Ink 7
    // repaints by erasing the previous frame's line count and rewriting
    // it (log-update), and once a frame outgrows the terminal it stops
    // erasing in place and falls back to clearing and rewriting the
    // whole screen (shouldClearTerminalForFrame in ink). The stray-glyph
    // artifact this PR chased (`toolss`, text bleeding into the header)
    // was observed while the unwindowed 337-row catalog pushed frames
    // past the terminal height, i.e. into that non-erasing regime (see
    // the review discussion on #68). Holding the modal at one constant
    // height, sized down on short terminals, keeps repaints in place.
    const window = pickerWindowRows(maxRows);
    if (picker.status === "loading") {
      return (
        <PromptBox tone="accent" title={`Models — ${picker.providerId}`}>
          <Text color={theme.colors.muted}>fetching model list…</Text>
          {blankRows(window)}
          <Text color={theme.colors.muted}>Esc cancel</Text>
        </PromptBox>
      );
    }
    if (picker.status === "error") {
      return (
        <PromptBox tone="danger" title={`Models — ${picker.providerId}`}>
          <Text color={theme.colors.error} wrap="truncate-end">
            model list unavailable ({picker.error ?? "unknown error"})
          </Text>
          {blankRows(window)}
          <Text color={theme.colors.muted}>Enter/Esc close</Text>
        </PromptBox>
      );
    }
    const rows = filteredPickerModels(picker);
    const start = Math.max(
      0,
      Math.min(
        picker.cursor - Math.floor(window / 2),
        Math.max(0, rows.length - window),
      ),
    );
    const visible = rows.slice(start, start + window);
    const blanks = Math.max(0, window - visible.length);
    const queryLine = picker.query;
    const counter =
      rows.length === 0
        ? "no match"
        : `${picker.cursor + 1}/${rows.length}${
            rows.length !== picker.models.length ? ` of ${picker.models.length}` : ""
          }`;
    return (
      <PromptBox tone="accent" title={`Models — ${picker.providerId}`}>
        <Text color={theme.colors.muted} wrap="truncate-end">
          {"filter: "}
          <Text color={theme.colors.accent}>{queryLine}</Text>
          <Text color={theme.colors.muted}>▏</Text>
        </Text>
        {visible.map((id: string, i: number) => {
          const idx = start + i;
          const selected = idx === picker.cursor;
          const isCurrent = id === picker.currentModelId;
          // Slot keys keep the row elements stable across refilters.
          // They are not what fixed the stray-glyph artifact: ids are
          // unique within a single render, so key={id} never collided
          // (see the review of #68); that traced to frame height, per
          // the fixed-height note above. truncate-end keeps a long id
          // from wrapping into a second line and changing the height.
          return (
            <Text
              key={`row-${i}`}
              color={selected ? theme.colors.accent : undefined}
              wrap="truncate-end"
            >
              {selected ? "› " : "  "}
              {id}
              {isCurrent ? <Text color={theme.colors.success}> current</Text> : null}
            </Text>
          );
        })}
        {blankRows(blanks)}
        <Text color={theme.colors.muted} wrap="truncate-end">
          {`↑/↓ move (${counter}) · type to filter · Enter select · Esc cancel`}
        </Text>
      </PromptBox>
    );
  }

  if (state.llmPanel.externalUrlDraft !== null) {
    const draft = state.llmPanel.externalUrlDraft;
    const valid = parseExternalUrl(draft) !== null;
    return (
      <PromptBox tone="accent" title="External llama.cpp base URL">
        <Text>
          {draft}
          <Text color={theme.colors.muted}>▏</Text>
        </Text>
        {valid ? null : <Text color={theme.colors.error}>invalid URL</Text>}
        <Text color={theme.colors.muted}>
          Saved after a /health probe succeeds. Enter save · Esc cancel
        </Text>
      </PromptBox>
    );
  }
  if (state.llmPanel.stopLocalDaemonsPrompt) {
    return (
      <PromptBox tone="accent" title="Stop local daemons now?">
        <Text color={theme.colors.muted}>
          Cloud provider {state.llmPanel.stopLocalDaemonsPrompt.providerId} is active.
          Stop local chat+embedding daemons? y stop · n/Esc keep running
        </Text>
      </PromptBox>
    );
  }
  return null;
}

function PromptBox({
  tone,
  title,
  children,
}: {
  tone: "accent" | "danger";
  title: string;
  children: ReactNode;
}): ReactElement {
  const color = tone === "danger" ? theme.colors.error : theme.colors.accentSoft;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
      width="100%"
    >
      <Text bold color={color}>
        {title}
      </Text>
      {children}
    </Box>
  );
}
