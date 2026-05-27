import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { LOCAL_EMBEDDING_CHOICE_ID } from "./providers-model-options.js";
import { handleProvidersWizardKey } from "./providers-wizard-key-bindings.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

function emptyKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

describe("handleProvidersWizardKey", () => {
  it("walks the OpenRouter onboarding flow through model and embedding picks", () => {
    let wizard = createProvidersWizardState("add");

    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.kind).toBe("openrouter");
    expect(wizard.phase).toBe("api_key");

    for (const ch of "sk") {
      wizard = next(wizard, ch, emptyKey());
    }
    expect(wizard.apiKeyBuffer).toBe("sk");

    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).toBe("pick_chat_model");

    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).toBe("pick_embedding");
    expect(wizard.selectedChatModelId).toBeTruthy();

    const result = handleProvidersWizardKey("", emptyKey({ return: true }), wizard);
    expect(result).toMatchObject({ handled: true, submit: true });
    if ("wizard" in result) {
      expect(result.wizard.selectedEmbeddingChoiceId).toBe(
        LOCAL_EMBEDDING_CHOICE_ID,
      );
    }
  });
});

function next(
  wizard: ProvidersWizardState,
  input: string,
  key: Key,
): ProvidersWizardState {
  const result = handleProvidersWizardKey(input, key, wizard);
  if (!result.handled || !("wizard" in result)) {
    throw new Error("wizard key was not handled");
  }
  return result.wizard;
}
