import type { Key } from "ink";
import { getCachedOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { getCachedGeminiModels } from "../../llm/provider/gemini/fetch-gemini-models.js";
import { nextModelPricingFilter } from "../../llm/provider/model-pricing-filter.js";
import { findProviderPreset } from "./provider-presets.js";
import {
  handleWizardSearchKey,
  nextListCursor,
} from "./providers-wizard-list-keys.js";
import {
  advanceWizardPhase,
  clampCursor,
  cursorForPreviousPick,
  isLinePhase,
  isListPhase,
  isWizardFirstScreen,
  kindRowAtCursor,
  presetNeedsKeyScreen,
  visibleRowsForPhase,
} from "./providers-wizard-phases.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import {
  apiKeyForWizard,
  apiKeyPhaseError,
  baseUrlForWizard,
} from "./providers-wizard-target.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

/**
 * Chat model ids discovered from `{baseUrl}/v1/models`. Empty once the operator
 * types anything — a typed id is a deliberate override, so the picker steps
 * aside (backspacing back to empty brings it back).
 */
export function listCompatChatModelPicks(
  wizard: ProvidersWizardState,
): readonly string[] {
  if (wizard.phase !== "chat_model_line") return [];
  if (wizard.chatModelLine.length > 0) return [];
  if (wizard.kind === "openai-compatible") {
    return (
      getCachedOpenAiCompatModels(
        baseUrlForWizard(wizard),
        apiKeyForWizard(wizard),
      ) ?? []
    );
  }
  if (wizard.kind === "gemini") {
    return getCachedGeminiModels(apiKeyForWizard(wizard)) ?? [];
  }
  return [];
}

export type ProvidersWizardKeyResult =
  | { handled: true; wizard: ProvidersWizardState; submit?: false }
  | { handled: true; wizard: ProvidersWizardState; submit: true }
  | { handled: true; wizard: ProvidersWizardState; cancelSubmit: true }
  | { handled: true; closed: true }
  | { handled: false };

export function handleProvidersWizardKey(
  input: string,
  key: Key,
  wizard: ProvidersWizardState,
): ProvidersWizardKeyResult {
  if (wizard.submitting) {
    // Esc is the one key that survives the lockout. Submitting now waits
    // on the provider answering a key check, and a service that has gone
    // quiet must not hold the wizard until it times out.
    if (key.escape) {
      return { handled: true, wizard, cancelSubmit: true };
    }
    return { handled: true, wizard };
  }
  // The search box owns printable keys, Backspace and Esc while it is
  // open, so it is asked before the screen-level Esc and before list
  // movement. It declines every key on the phases that have no list.
  const searched = handleWizardSearchKey(input, key, wizard);
  if (searched !== null) {
    return { handled: true, wizard: searched };
  }
  if (key.escape) {
    // Esc steps back one screen rather than abandoning the whole wizard:
    // picking the wrong service should not cost the operator the flow.
    // Only the screen the run opened at closes it. Stepping back
    // rebuilds a clean pick_kind state so the previous pick does not
    // leak into the next one, then restores the cursor to that row.
    if (!isWizardFirstScreen(wizard)) {
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
      // An empty key is refused here rather than at the end of the
      // wizard: leaving this screen blank used to cost the operator the
      // model picker and the save round-trip before anything said so.
      // Services that genuinely have no key (local servers, keyless
      // listing) opt out through `apiKeyPhaseError`.
      const missing = apiKeyPhaseError(wizard);
      if (missing) {
        return { handled: true, wizard: { ...wizard, error: missing } };
      }
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

  // `p` cycles the price facet of the curated chat-model list: all →
  // free → paid → all. Only reachable while the search box is closed —
  // open, `handleWizardSearchKey` above consumed every printable key as
  // query text, `p` included. Handled before the empty-list bailout so
  // a facet that matched nothing can still be cycled away from.
  if (wizard.phase === "pick_chat_model" && input === "p" && !key.ctrl && !key.meta) {
    return {
      handled: true,
      wizard: {
        ...wizard,
        pricingFilter: nextModelPricingFilter(wizard.pricingFilter),
        cursor: 0,
      },
    };
  }

  // One list for the whole screen: the render highlights row `cursor` of
  // exactly this array, so movement and Enter have to read it too, or a
  // narrowed list would select something the operator never saw.
  const rows = visibleRowsForPhase(wizard);
  const len = rows.length;
  if (len === 0) {
    return { handled: true, wizard };
  }

  // With the search box open `j` and `k` are query characters, and the
  // branch above already consumed them; passing that through keeps the
  // two halves from ever disagreeing about which they are.
  const moved = nextListCursor(
    input,
    key,
    wizard.cursor,
    len,
    wizard.search === null,
  );
  if (moved !== null) {
    return { handled: true, wizard: { ...wizard, cursor: moved } };
  }
  if (key.return) {
    if (wizard.phase === "pick_kind") {
      const row = kindRowAtCursor(clampCursor(wizard.cursor, len), wizard.search);
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
            search: null,
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
    if (wizard.phase === "pick_embedding") {
      const picked = rows[clampCursor(wizard.cursor, len)]?.id ?? null;
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
