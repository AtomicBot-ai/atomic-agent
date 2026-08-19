import { Box, Text } from "ink";
import { useEffect, useState, type ReactElement } from "react";
import {
  getCachedAimlapiChatPicks,
  refreshAimlapiChatCatalogFromApi,
} from "../../llm/provider/aimlapi/fetch-aimlapi-chat-catalog.js";
import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { fetchGeminiModels } from "../../llm/provider/gemini/fetch-gemini-models.js";
import {
  getCachedOpenRouterChatPicks,
  refreshOpenRouterChatCatalogFromApi,
} from "../../llm/provider/openrouter/fetch-openrouter-chat-catalog.js";
import { listCompatChatModelPicks } from "../providers/providers-wizard-key-bindings.js";
import {
  apiKeyForWizard,
  baseUrlForWizard,
  envHintForWizard,
  wizardKeyIsOptional,
} from "../providers/providers-wizard-target.js";
import { theme } from "../theme/theme.js";
import { findProviderPreset } from "../providers/provider-presets.js";
import {
  KIND_ROW_ORDER,
  listChatModelsForKind,
  type ProvidersWizardKindRow,
} from "../providers/providers-wizard-phases.js";
import {
  GEMINI_DEFAULT_CHAT_MODEL,
  listAimlapiEmbeddingModels,
  listOpenRouterEmbeddingModels,
  OPENAI_COMPAT_DEFAULT_BASE_URL,
  OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
} from "../providers/providers-model-options.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardState,
} from "../providers/providers-wizard-state.js";
import { renderPickList } from "./wizard-pick-list.js";

const KIND_LABELS: Record<ProvidersWizardKind, string> = {
  "claude-cli":
    "Claude Code subscription (drives your signed-in `claude` CLI — no API key)",
  "codex-cli":
    "OpenAI Codex subscription (drives your signed-in `codex` CLI — no API key)",
  openrouter: "OpenRouter (cloud chat + optional cloud embed)",
  aimlapi: "AI/ML API (aimlapi.com — 500+ models, OpenAI-compatible)",
  gemini: "Gemini (Google AI)",
  "openai-compatible": "OpenAI-compatible API (custom base URL)",
};

function labelForKindRow(row: ProvidersWizardKindRow): string {
  if (typeof row !== "object") return KIND_LABELS[row];
  const preset = findProviderPreset(row.presetId);
  if (!preset) return row.presetId;
  return preset.note ? `${preset.label} — ${preset.note}` : preset.label;
}

/**
 * One flat provider list, matching what other agent CLIs present: the
 * two kinds with built-in catalogs, then every known service (#69), then
 * the manual entry for anything not listed. Derived from
 * `KIND_ROW_ORDER` — the key bindings walk that same list, so a row's
 * label and its Enter action can never drift apart.
 */
const KIND_OPTIONS = KIND_ROW_ORDER.map((row) => ({
  label: labelForKindRow(row),
}));

/** Service name for headings: the preset label wins over the raw kind. */
function providerLabelForWizard(w: ProvidersWizardState): string {
  const preset = w.presetId ? findProviderPreset(w.presetId) : undefined;
  return preset?.label ?? w.kind ?? "provider";
}

/**
 * Turn a bare transport error into something actionable. `http 401` on
 * its own reads as a product failure, when it almost always means the
 * key belongs to a different service than the one selected.
 */
function explainModelListError(error: string, w: ProvidersWizardState): string {
  const service = providerLabelForWizard(w);
  if (error.includes("401") || error.includes("403")) {
    return `${service} rejected this key, check it belongs to ${service}`;
  }
  if (error.includes("404")) {
    return `${service} has no model list at this URL`;
  }
  return `could not list models from ${service} (${error})`;
}

/**
 * What `submitting` means now that a save starts with a live key check:
 * the wait is the provider answering, and Esc gets out of it.
 */
const CHECKING_KEY_HINT = " · checking the key with the provider… (Esc cancels)";

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
  const isGemini = w.kind === "gemini";
  const canList = isCompat || isGemini;
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>(
    { loading: canList, error: null },
  );

  useEffect(() => {
    // Only these kinds have a live model surface worth listing: openai-compatible
    // carries an operator-supplied base URL, gemini has a fixed host keyed by its
    // own key. Any other kind would fire at the default host with a stray key.
    if (!canList) return;
    let alive = true;
    setStatus({ loading: true, error: null });
    const apiKey = apiKeyForWizard(w);
    const fetchModels = isGemini
      ? fetchGeminiModels(apiKey)
      : fetchOpenAiCompatModels(baseUrl, apiKey);
    fetchModels.then(
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
  }, [baseUrl, isCompat, isGemini]);

  const picks = listCompatChatModelPicks(w);
  if (picks.length > 0) {
    const source = isGemini
      ? "from Gemini /v1beta/openai/models"
      : `from ${baseUrl}/v1/models`;
    return renderPickList({
      title: `Chat model — ${picks.length} ${source}`,
      options: picks.map((id) => ({ label: id })),
      cursor: w.cursor,
      moveHint: "↑/↓ move",
      actionsHint:
        "PgUp/PgDn jump · Enter select · type to enter an id by hand · Esc back",
    });
  }

  const hint = w.submitting
    ? CHECKING_KEY_HINT.trimStart()
    : !canList
    ? "Enter to save · Esc back"
    : status.loading
      ? isGemini
        ? "listing models from Gemini…"
        : `listing models from ${baseUrl}/v1/models…`
      : status.error
      ? `${explainModelListError(status.error, w)} · type the id · Enter to save`
      : "Enter to save · Backspace to empty for the model list · Esc back";
  return renderLineField({
    title: "Chat model id",
    value: w.chatModelLine,
    placeholder:
      w.kind === "gemini"
        ? GEMINI_DEFAULT_CHAT_MODEL
        : OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
    hint,
    error: w.error,
  });
}

/**
 * Chat-model picker for the two curated cloud kinds. The static catalog
 * renders immediately; a live refresh runs in this component the moment
 * the step opens, because nothing else in the wizard flow is guaranteed
 * to have fetched it (the picker used to render whatever happened to be
 * in the module cache, which in a fresh TUI process was always the
 * short static list). While the fetch is in flight the hint says so;
 * when it lands, the state flip re-renders this component and the list
 * functions re-read the now-live cache. A failed fetch resolves `false`
 * and simply leaves the static list on screen.
 */
function CatalogChatModelStep(props: {
  wizard: ProvidersWizardState;
  kind: "openrouter" | "aimlapi";
}): ReactElement {
  const { wizard: w, kind } = props;
  const getCached =
    kind === "openrouter" ? getCachedOpenRouterChatPicks : getCachedAimlapiChatPicks;
  const [loading, setLoading] = useState(() => getCached() === null);

  useEffect(() => {
    if (getCached() !== null) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const refresh =
      kind === "openrouter"
        ? refreshOpenRouterChatCatalogFromApi
        : refreshAimlapiChatCatalogFromApi;
    refresh().then(
      () => {
        if (alive) setLoading(false);
      },
      () => {
        // `refresh` swallows its own errors, but a rejection here must
        // still clear the spinner rather than crash the wizard.
        if (alive) setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // `getCached` is derived from `kind`; re-running on kind alone is exact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const title =
    kind === "openrouter" ? "Chat model (OpenRouter)" : "Chat model (AI/ML API)";
  const actionsHint = loading
    ? "PgUp/PgDn jump · Enter select · Esc back · updating model list from API…"
    : "PgUp/PgDn jump · Enter select · Esc back";
  return renderPickList({
    title,
    options: listChatModelsForKind(kind),
    cursor: w.cursor,
    moveHint: "j/k move",
    actionsHint,
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
    const envHint = envHintForWizard(w);
    // Local servers and keyless-listing services save with an empty key;
    // promising ".env only" here would contradict their own list rows.
    const emptyMeans = wizardKeyIsOptional(w)
      ? "Optional for this service — leave empty to connect without a key."
      : "Leave empty only if the key is already in .env.";
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
          API key — {providerLabelForWizard(w)}
        </Text>
        <Text color={theme.colors.muted}>
          Saved to <Text color={theme.colors.accentSoft}>{".env"}</Text> as{" "}
          {envHint} (mode 0600). {emptyMeans}
        </Text>
        <Box>
          <Text color={theme.colors.muted}>{"> "}</Text>
          <Text color={theme.colors.accentSoft}>{maskedKey(w.apiKeyBuffer)}</Text>
        </Box>
        {w.error ? (
          <Text color={theme.colors.error}>! {w.error}</Text>
        ) : null}
        <Text color={theme.colors.muted}>
          Enter to continue · Esc back · Backspace edit
          {w.submitting ? CHECKING_KEY_HINT : ""}
        </Text>
      </Box>
    );
  }

  if (
    w.phase === "pick_chat_model" &&
    (w.kind === "openrouter" || w.kind === "aimlapi")
  ) {
    return <CatalogChatModelStep wizard={w} kind={w.kind} />;
  }

  if (w.phase === "pick_embedding" && w.kind === "openrouter") {
    return renderPickList({
      title: "Embedding backend",
      options: listOpenRouterEmbeddingModels(),
      cursor: w.cursor,
      moveHint: "j/k move",
      actionsHint: "PgUp/PgDn jump · Enter finish · Esc back",
    });
  }

  if (w.phase === "pick_embedding" && w.kind === "aimlapi") {
    return renderPickList({
      title: "Embedding backend",
      options: listAimlapiEmbeddingModels(),
      cursor: w.cursor,
      moveHint: "j/k move",
      actionsHint: "PgUp/PgDn jump · Enter finish · Esc back",
    });
  }

  if (w.phase === "base_url") {
    return renderLineField({
      title: "API base URL",
      value: w.baseUrlLine,
      placeholder: OPENAI_COMPAT_DEFAULT_BASE_URL,
      hint: "Enter to continue · Esc back",
      error: w.error,
    });
  }

  if (w.phase === "chat_model_line") {
    return <CompatChatModelStep wizard={w} />;
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.colors.error}>Unknown wizard phase</Text>
    </Box>
  );
}
