import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { ProvidersWizard } from "./providers-wizard.js";
import { parseExternalUrl } from "../llm-panel/llm-panel-modal-key-bindings.js";

export function LlmPanelModals({ state }: { state: TuiState }): ReactElement | null {
  if (state.llmPanel.huggingFacePrompt) {
    return <HuggingFacePrompt prompt={state.llmPanel.huggingFacePrompt} />;
  }
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

/**
 * One field, two intents: a URL / `owner/name` is resolved and added on
 * Enter; anything else is searched and comes back as a numbered pick list.
 */
function HuggingFacePrompt({
  prompt,
}: {
  prompt: NonNullable<TuiState["llmPanel"]["huggingFacePrompt"]>;
}): ReactElement {
  return (
    <PromptBox tone="accent" title="Add a model from Hugging Face">
      <Text color={theme.colors.muted}>
        Paste a model URL, hf://…, an `hf download` command, or owner/name
        — or type words to search.
      </Text>
      <Text>
        {"> "}
        {prompt.buffer}
        {prompt.busy ? "" : "▌"}
      </Text>
      {prompt.busy ? (
        <Text color={theme.colors.accentSoft}>working…</Text>
      ) : null}
      {prompt.error ? <Text color={theme.colors.error}>{prompt.error}</Text> : null}
      {prompt.results.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.muted}>press a number to add:</Text>
          {prompt.results.map((hit, i) => (
            <Text key={hit.repoId}>
              <Text bold color={theme.colors.accentSoft}>
                {" "}
                {i + 1}
              </Text>{" "}
              {hit.repoId}{" "}
              <Text color={theme.colors.muted}>
                ({hit.downloads.toLocaleString()} downloads)
              </Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Text color={theme.colors.muted}>Enter submit · Esc cancel</Text>
    </PromptBox>
  );
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
