import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { ProvidersWizard } from "./providers-wizard.js";

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
  children: ReactElement | readonly ReactElement[];
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
