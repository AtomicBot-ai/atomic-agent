import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { ProvidersWizard } from "./providers-wizard.js";
import { parseExternalUrl } from "../llm-panel/llm-panel-modal-key-bindings.js";

export function LlmPanelModals({ state }: { state: TuiState }): ReactElement | null {
  if (state.providersPanel.wizard) {
    return <ProvidersWizard wizard={state.providersPanel.wizard} />;
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
    if (picker.status === "loading") {
      return (
        <PromptBox tone="accent" title={`Models — ${picker.providerId}`}>
          <Text color={theme.colors.muted}>fetching model list… · Esc cancel</Text>
        </PromptBox>
      );
    }
    if (picker.status === "error") {
      return (
        <PromptBox tone="danger" title={`Models — ${picker.providerId}`}>
          <Text color={theme.colors.error}>
            model list unavailable ({picker.error ?? "unknown error"})
          </Text>
          <Text color={theme.colors.muted}>Enter/Esc close</Text>
        </PromptBox>
      );
    }
    // 12-row window around the cursor, same shape as the wizard picker.
    const WINDOW = 12;
    const start = Math.max(
      0,
      Math.min(picker.cursor - Math.floor(WINDOW / 2), picker.models.length - WINDOW),
    );
    const visible = picker.models.slice(start, start + WINDOW);
    return (
      <PromptBox tone="accent" title={`Models — ${picker.providerId}`}>
        {visible.map((id: string, i: number) => {
          const idx = start + i;
          const selected = idx === picker.cursor;
          const isCurrent = id === picker.currentModelId;
          return (
            <Text key={id} color={selected ? theme.colors.accent : undefined}>
              {selected ? "› " : "  "}
              {id}
              {isCurrent ? <Text color={theme.colors.success}> current</Text> : null}
            </Text>
          );
        })}
        <Text color={theme.colors.muted}>
          {`↑/↓ move (${picker.cursor + 1}/${picker.models.length}) · Enter select · Esc cancel`}
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
