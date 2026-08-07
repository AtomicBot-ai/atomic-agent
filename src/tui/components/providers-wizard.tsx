import { Box, Text } from "ink";
import { useEffect, useState, type ReactElement } from "react";
import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import {
  apiKeyForWizard,
  baseUrlForWizard,
  listCompatChatModelPicks,
} from "../providers/providers-wizard-key-bindings.js";
import { theme } from "../theme/theme.js";
import { PROVIDER_PRESETS } from "../providers/provider-presets.js";
import {
  listAimlapiChatModels,
  listAimlapiEmbeddingModels,
  listOpenRouterChatModels,
  listOpenRouterEmbeddingModels,
  OPENAI_COMPAT_DEFAULT_BASE_URL,
  OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
} from "../providers/providers-model-options.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
import { renderPickList } from "./wizard-pick-list.js";

/**
 * One flat provider list, matching what other agent CLIs present: the
 * two kinds with built-in catalogs, then every known service (#69), then
 * the manual entry for anything not listed.
 */
const KIND_OPTIONS = [
  { id: "openrouter", label: "OpenRouter (cloud chat + optional cloud embed)" },
  {
    id: "aimlapi",
    label: "AI/ML API (aimlapi.com — 500+ models, OpenAI-compatible)",
  },
  ...PROVIDER_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.note ? `${preset.label} — ${preset.note}` : preset.label,
  })),
  {
    id: "openai-compatible",
    label: "OpenAI-compatible API (custom base URL)",
  },
];

function envHintForKind(
  kind: ProvidersWizardState["kind"],
): string {
  if (kind === "openrouter") return "OPENROUTER_API_KEY";
  if (kind === "aimlapi") return "AIMLAPI_API_KEY";
  return "OPENAI_COMPAT_API_KEY";
}

function maskedKey(buffer: string): string {
  const masked = "•".repeat(Math.min(buffer.length, 48));
  const extra = buffer.length > 48 ? `+${buffer.length - 48}` : "";
  return masked + extra;
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

function CompatChatModelStep(props: {
  wizard: ProvidersWizardState;
}): ReactElement {
  const w = props.wizard;
  const baseUrl = baseUrlForWizard(w);
  const isCompat = w.kind === "openai-compatible";
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>(
    { loading: isCompat, error: null },
  );

  useEffect(() => {
    // Only the openai-compatible kind carries an operator-supplied base URL;
    // any other kind would fire this at the default host with a stray key.
    if (!isCompat) return;
    let alive = true;
    setStatus({ loading: true, error: null });
    fetchOpenAiCompatModels(baseUrl, apiKeyForWizard(w)).then(
      () => {
        if (alive) setStatus({ loading: false, error: null });
      },
      (err: unknown) => {
        if (alive) {
          setStatus({
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    return () => {
      alive = false;
    };
    // Re-fetch only when the server changes; the key is fixed for this wizard run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, isCompat]);

  const picks = listCompatChatModelPicks(w);
  if (picks.length > 0) {
    return renderPickList({
      title: `Chat model — ${picks.length} from ${baseUrl}/v1/models`,
      options: picks.map((id) => ({ label: id })),
      cursor: w.cursor,
      moveHint: "↑/↓ move",
      actionsHint:
        "PgUp/PgDn jump · Enter select · type to enter an id by hand · Esc cancel",
    });
  }

  const hint = !isCompat
    ? "Enter to continue · Esc cancel"
    : status.loading
      ? `listing models from ${baseUrl}/v1/models…`
      : status.error
      ? `model list unavailable (${status.error}) — type the id · Enter to continue`
      : "Enter to continue · Backspace to empty for the model list · Esc cancel";
  return renderLineField({
    title: "Chat model id",
    value: w.chatModelLine,
    placeholder: OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
    hint,
    error: w.error,
  });
}

export function ProvidersWizard(props: {
  wizard: ProvidersWizardState;
}): ReactElement {
  const w = props.wizard;
  const modeLabel = w.mode === "configure" ? `configure ${w.providerId}` : "add provider";

  if (w.phase === "pick_kind") {
    return renderPickList({
      title: `LLM provider — ${modeLabel}`,
      options: KIND_OPTIONS,
      cursor: w.cursor,
      moveHint: "j/k move",
      actionsHint: "Enter pick · Esc cancel",
    });
  }

  if (w.phase === "api_key") {
    const envHint = envHintForKind(w.kind);
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
    return renderPickList({
      title: "Chat model (OpenRouter)",
      options: listOpenRouterChatModels(),
      cursor: w.cursor,
      moveHint: "j/k move",
      actionsHint: "PgUp/PgDn jump · Enter select · Esc cancel",
    });
  }

  if (w.phase === "pick_chat_model" && w.kind === "aimlapi") {
    return renderPickList({
      title: "Chat model (AI/ML API)",
      options: listAimlapiChatModels(),
      cursor: w.cursor,
      moveHint: "j/k move",
      actionsHint: "PgUp/PgDn jump · Enter select · Esc cancel",
    });
  }

  if (w.phase === "pick_embedding" && w.kind === "openrouter") {
    return renderPickList({
      title: "Embedding backend",
      options: listOpenRouterEmbeddingModels(),
      cursor: w.cursor,
      moveHint: "j/k move",
      actionsHint: "PgUp/PgDn jump · Enter finish · Esc cancel",
    });
  }

  if (w.phase === "pick_embedding" && w.kind === "aimlapi") {
    return renderPickList({
      title: "Embedding backend",
      options: listAimlapiEmbeddingModels(),
      cursor: w.cursor,
      moveHint: "j/k move",
      actionsHint: "PgUp/PgDn jump · Enter finish · Esc cancel",
    });
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
    return <CompatChatModelStep wizard={w} />;
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
