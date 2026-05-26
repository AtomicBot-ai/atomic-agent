import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import {
  listOpenRouterChatModels,
  listOpenRouterEmbeddingModels,
  OPENAI_COMPAT_DEFAULT_BASE_URL,
  OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
} from "../providers/providers-model-options.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";

const KIND_OPTIONS = [
  { id: "openrouter" as const, label: "OpenRouter (cloud chat + optional cloud embed)" },
  {
    id: "openai-compatible" as const,
    label: "OpenAI-compatible API (custom base URL)",
  },
];

function maskedKey(buffer: string): string {
  const masked = "•".repeat(Math.min(buffer.length, 48));
  const extra = buffer.length > 48 ? `+${buffer.length - 48}` : "";
  return masked + extra;
}

function renderPickList(
  title: string,
  options: readonly { label: string }[],
  cursor: number,
  hint: string,
): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Text bold color={theme.colors.accentSoft}>
        {title}
      </Text>
      {options.map((opt, i) => {
        const mark = i === cursor ? ">" : " ";
        return (
          <Text key={`${i}-${opt.label}`} color={i === cursor ? theme.colors.accentSoft : undefined}>
            {mark} {opt.label}
          </Text>
        );
      })}
      <Text color={theme.colors.muted}>{hint}</Text>
    </Box>
  );
}

function renderLineField(props: {
  title: string;
  value: string;
  placeholder: string;
  hint: string;
  error: string | null;
}): ReactElement {
  const display = props.value.length > 0 ? props.value : props.placeholder;
  const muted = props.value.length === 0;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Text bold color={theme.colors.accentSoft}>
        {props.title}
      </Text>
      <Box>
        <Text color={theme.colors.muted}>{"> "}</Text>
        <Text color={muted ? theme.colors.muted : theme.colors.accentSoft}>
          {display}
        </Text>
      </Box>
      {props.error ? (
        <Text color={theme.colors.error}>! {props.error}</Text>
      ) : null}
      <Text color={theme.colors.muted}>{props.hint}</Text>
    </Box>
  );
}

export function ProvidersWizard(props: {
  wizard: ProvidersWizardState;
}): ReactElement {
  const w = props.wizard;
  const modeLabel = w.mode === "configure" ? `configure ${w.providerId}` : "add provider";

  if (w.phase === "pick_kind") {
    return renderPickList(
      `LLM provider — ${modeLabel}`,
      KIND_OPTIONS,
      w.cursor,
      "j/k move · Enter pick · Esc cancel",
    );
  }

  if (w.phase === "api_key") {
    const envHint =
      w.kind === "openrouter"
        ? "OPENROUTER_API_KEY"
        : "OPENAI_API_KEY";
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.colors.accentSoft}
        paddingX={1}
        marginY={1}
        width="100%"
      >
        <Text bold color={theme.colors.accentSoft}>
          API key — {w.kind ?? "provider"}
        </Text>
        <Text color={theme.colors.muted}>
          Saved to <Text color={theme.colors.accentSoft}>{".env"}</Text> as{" "}
          {envHint} (mode 0600). Leave empty only if the key is already in .env.
        </Text>
        <Box>
          <Text color={theme.colors.muted}>{"> "}</Text>
          <Text color={theme.colors.accentSoft}>{maskedKey(w.apiKeyBuffer)}</Text>
        </Box>
        {w.error ? (
          <Text color={theme.colors.error}>! {w.error}</Text>
        ) : null}
        <Text color={theme.colors.muted}>
          Enter to continue · Esc cancel · Backspace edit
          {w.submitting ? " · saving…" : ""}
        </Text>
      </Box>
    );
  }

  if (w.phase === "pick_chat_model" && w.kind === "openrouter") {
    const models = listOpenRouterChatModels();
    return renderPickList(
      "Chat model (OpenRouter)",
      models,
      w.cursor,
      "j/k move · Enter select · Esc cancel",
    );
  }

  if (w.phase === "pick_embedding" && w.kind === "openrouter") {
    const models = listOpenRouterEmbeddingModels();
    return renderPickList(
      "Embedding backend",
      models,
      w.cursor,
      "j/k move · Enter finish · Esc cancel",
    );
  }

  if (w.phase === "base_url") {
    return renderLineField({
      title: "API base URL",
      value: w.baseUrlLine,
      placeholder: OPENAI_COMPAT_DEFAULT_BASE_URL,
      hint: "Enter to continue · Esc cancel",
      error: w.error,
    });
  }

  if (w.phase === "chat_model_line") {
    return renderLineField({
      title: "Chat model id",
      value: w.chatModelLine,
      placeholder: OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
      hint: "Enter to continue · Esc cancel",
      error: w.error,
    });
  }

  if (w.phase === "embedding_model_line") {
    return renderLineField({
      title: "Embedding model id (empty = local daemon only)",
      value: w.embeddingModelLine,
      placeholder: "(leave empty for local embeddings)",
      hint: "Enter to save · Esc cancel",
      error: w.error,
    });
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.colors.error}>Unknown wizard phase</Text>
    </Box>
  );
}
