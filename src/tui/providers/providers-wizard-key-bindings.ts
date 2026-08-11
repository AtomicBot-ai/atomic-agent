import type { Key } from "ink";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import { getCachedOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { normalizeOpenAiBaseUrl } from "../../llm/provider/openai/normalize-openai-base-url.js";
import { PICK_WINDOW } from "../components/wizard-pick-list.js";
import { findProviderPreset } from "./provider-presets.js";
import { OPENAI_COMPAT_DEFAULT_BASE_URL } from "./providers-model-options.js";
import {
  advanceWizardPhase,
  clampCursor,
  cursorForPreviousPick,
  isCuratedCatalogKind,
  isLinePhase,
  isListPhase,
  kindRowAtCursor,
  listEmbeddingModelsForKind,
  listLengthForPhase,
  presetNeedsKeyScreen,
} from "./providers-wizard-phases.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

/** Normalized so the fetch, the cache key and the displayed URL always agree. */
export function baseUrlForWizard(wizard: ProvidersWizardState): string {
  return (
    normalizeOpenAiBaseUrl(wizard.baseUrlLine) || OPENAI_COMPAT_DEFAULT_BASE_URL
  );
}

/**
 * Typed key wins; otherwise a key already in the environment needs no
 * retyping. The fallback probe resolves the preset's own variable when
 * one is selected — reading the shared compat variable for Groq would
 * hand the wrong service's key to the model-list fetch.
 */
export function apiKeyForWizard(
  wizard: ProvidersWizardState,
): string | undefined {
  const preset = wizard.presetId ? findProviderPreset(wizard.presetId) : undefined;
  return (
    wizard.apiKeyBuffer.trim() ||
    resolveLlmProviderApiKey({
      id: "openai-compatible",
      kind: "openai-compatible",
      ...(preset ? { apiKeyEnvVar: preset.envVar } : {}),
    })
  );
}

/**
 * Chat model ids discovered from `{baseUrl}/v1/models`. Empty once the operator
 * types anything — a typed id is a deliberate override, so the picker steps
 * aside (backspacing back to empty brings it back).
 */
export function listCompatChatModelPicks(
  wizard: ProvidersWizardState,
): readonly string[] {
  if (wizard.phase !== "chat_model_line") return [];
  if (wizard.kind !== "openai-compatible") return [];
  if (wizard.chatModelLine.length > 0) return [];
  return (
    getCachedOpenAiCompatModels(
      baseUrlForWizard(wizard),
      apiKeyForWizard(wizard),
    ) ?? []
  );
}

/**
 * Cursor after one list-navigation key, or `null` when the key is not a
 * navigation key. Every result starts from the clamped cursor so a
 * catalog that shrank under an open wizard cannot leave the cursor
 * pointing past the end (see `clampCursor`). Arrows wrap like before;
 * PgUp/PgDn jump one viewport (`PICK_WINDOW`) and stop at the edges,
 * Home/End go straight to them. Arrow-only travel to row 250 of a 300+
 * catalog was the alternative.
 */
function nextListCursor(
  input: string,
  key: Key,
  cursor: number,
  length: number,
  withVimKeys: boolean,
): number | null {
  const current = clampCursor(cursor, length);
  const last = Math.max(0, length - 1);
  if (key.downArrow || (withVimKeys && input === "j")) {
    return (current + 1) % length;
  }
  if (key.upArrow || (withVimKeys && input === "k")) {
    return (current - 1 + length) % length;
  }
  if (key.pageDown) return Math.min(current + PICK_WINDOW, last);
  if (key.pageUp) return Math.max(current - PICK_WINDOW, 0);
  if (key.home) return 0;
  if (key.end) return last;
  return null;
}

export type ProvidersWizardKeyResult =
  | { handled: true; wizard: ProvidersWizardState; submit?: false }
  | { handled: true; wizard: ProvidersWizardState; submit: true }
  | { handled: true; closed: true }
  | { handled: false };

export function handleProvidersWizardKey(
  input: string,
  key: Key,
  wizard: ProvidersWizardState,
): ProvidersWizardKeyResult {
  if (wizard.submitting) {
    return { handled: true, wizard };
  }
  if (key.escape) {
    // Esc steps back one screen rather than abandoning the whole wizard:
    // picking the wrong service should not cost the operator the flow.
    // Only the first screen (the provider list) closes it. Stepping back
    // rebuilds a clean pick_kind state so the previous pick does not
    // leak into the next one, then restores the cursor to that row.
    if (wizard.phase !== "pick_kind") {
      return {
        handled: true,
        wizard: {
          ...createProvidersWizardState(wizard.mode, {
            ...(wizard.providerId ? { providerId: wizard.providerId } : {}),
          }),
          phase: "pick_kind",
          cursor: cursorForPreviousPick(wizard),
        },
      };
    }
    return { handled: true, closed: true };
  }

  if (wizard.phase === "api_key") {
    if (key.return) {
      return {
        handled: true,
        wizard: advanceWizardPhase(wizard),
      };
    }
    if (key.backspace || key.delete) {
      return {
        handled: true,
        wizard: {
          ...wizard,
          apiKeyBuffer: wizard.apiKeyBuffer.slice(0, -1),
          error: null,
        },
      };
    }
    if (input && input.length > 0 && !key.ctrl && !key.meta) {
      return {
        handled: true,
        wizard: {
          ...wizard,
          apiKeyBuffer: wizard.apiKeyBuffer + input,
          error: null,
        },
      };
    }
    return { handled: true, wizard };
  }

  if (isLinePhase(wizard.phase)) {
    const picks = listCompatChatModelPicks(wizard);
    if (picks.length > 0) {
      // Navigation keys only ("j"/"k" stay printable): typed characters
      // fall through to line editing so an id the server does not
      // advertise can still be entered by hand.
      const moved = nextListCursor(input, key, wizard.cursor, picks.length, false);
      if (moved !== null) {
        return { handled: true, wizard: { ...wizard, cursor: moved } };
      }
      if (key.return) {
        const picked = picks[clampCursor(wizard.cursor, picks.length)]!;
        // Picks only appear on `chat_model_line`, the final step: choosing
        // one records the id and saves, no embedding screen after it.
        return {
          handled: true,
          wizard: { ...wizard, chatModelLine: picked },
          submit: true,
        };
      }
    }
    const field =
      wizard.phase === "base_url" ? "baseUrlLine" : "chatModelLine";
    if (key.return) {
      // `chat_model_line` is the final step now that the embedding screen
      // is gone: embeddings stay on the local daemon unless changed later
      // in the LLM tab, so Enter saves from here.
      if (wizard.phase === "chat_model_line") {
        return { handled: true, wizard, submit: true };
      }
      return {
        handled: true,
        wizard: advanceWizardPhase(wizard),
      };
    }
    if (key.backspace || key.delete) {
      const line = wizard[field];
      return {
        handled: true,
        wizard: {
          ...wizard,
          [field]: line.slice(0, -1),
          error: null,
        } as ProvidersWizardState,
      };
    }
    if (input && input.length > 0 && !key.ctrl && !key.meta) {
      const line = wizard[field];
      return {
        handled: true,
        wizard: {
          ...wizard,
          [field]: line + input,
          error: null,
        } as ProvidersWizardState,
      };
    }
    return { handled: true, wizard };
  }

  if (!isListPhase(wizard.phase)) {
    return { handled: false };
  }

  const len = listLengthForPhase(wizard.phase, wizard.kind);
  if (len === 0) {
    return { handled: true, wizard };
  }

  const moved = nextListCursor(input, key, wizard.cursor, len, true);
  if (moved !== null) {
    return { handled: true, wizard: { ...wizard, cursor: moved } };
  }
  if (key.return) {
    if (wizard.phase === "pick_kind") {
      const row = kindRowAtCursor(clampCursor(wizard.cursor, len));
      if (typeof row === "object") {
        const preset = findProviderPreset(row.presetId);
        if (!preset) return { handled: true, wizard };
        // A preset is an openai-compatible entry with the endpoint
        // already known, so the operator never types a base URL. Services
        // that list models without credentials, and local servers (LM
        // Studio), skip the key screen too and land straight on the model
        // choice: asking for a key that does not exist is the dead end
        // presets exist to remove (#69).
        const needsKey = presetNeedsKeyScreen(preset.id);
        return {
          handled: true,
          wizard: {
            ...wizard,
            kind: "openai-compatible",
            presetId: preset.id,
            baseUrlLine: preset.baseUrl,
            phase: needsKey ? "api_key" : "chat_model_line",
            cursor: 0,
          },
        };
      }
      return {
        handled: true,
        wizard: advanceWizardPhase({
          ...wizard,
          kind: row,
        }),
      };
    }
    if (
      wizard.phase === "pick_embedding" &&
      wizard.kind &&
      isCuratedCatalogKind(wizard.kind)
    ) {
      const models = listEmbeddingModelsForKind(wizard.kind);
      const picked =
        models[clampCursor(wizard.cursor, models.length)]?.id ?? null;
      return {
        handled: true,
        wizard: {
          ...wizard,
          selectedEmbeddingChoiceId: picked,
        },
        submit: true,
      };
    }
    return {
      handled: true,
      wizard: advanceWizardPhase(wizard),
    };
  }
  return { handled: true, wizard };
}
