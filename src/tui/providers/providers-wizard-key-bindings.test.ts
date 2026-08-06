import type { Key } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
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

describe("createProvidersWizardState configure prefill", () => {
  it("prefills baseUrlLine from the stored base URL", () => {
    const wizard = createProvidersWizardState("configure", {
      providerId: "my-vllm",
      kind: "openai-compatible",
      baseUrl: "http://192.168.1.50:8000",
    });
    expect(wizard.baseUrlLine).toBe("http://192.168.1.50:8000");
    expect(wizard.phase).toBe("api_key");
  });

  it("keeps baseUrlLine empty when no stored URL is passed", () => {
    const wizard = createProvidersWizardState("configure", {
      providerId: "my-vllm",
      kind: "openai-compatible",
    });
    expect(wizard.baseUrlLine).toBe("");
  });
});

describe("handleProvidersWizardKey", () => {
  it("walks the aimlapi onboarding flow when the cursor lands on it", () => {
    let wizard = createProvidersWizardState("add");

    wizard = next(wizard, "", emptyKey({ downArrow: true }));
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.kind).toBe("aimlapi");
    expect(wizard.phase).toBe("api_key");

    for (const ch of "ak") {
      wizard = next(wizard, ch, emptyKey());
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).toBe("pick_chat_model");

    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).toBe("pick_embedding");

    const result = handleProvidersWizardKey("", emptyKey({ return: true }), wizard);
    expect(result).toMatchObject({ handled: true, submit: true });
    if ("wizard" in result) {
      expect(result.wizard.selectedEmbeddingChoiceId).toBe(
        LOCAL_EMBEDDING_CHOICE_ID,
      );
    }
  });

  it("falls through to the openai-compatible flow on the third kind slot", () => {
    let wizard = createProvidersWizardState("add");
    wizard = next(wizard, "", emptyKey({ downArrow: true }));
    wizard = next(wizard, "", emptyKey({ downArrow: true }));
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.kind).toBe("openai-compatible");
    expect(wizard.phase).toBe("api_key");
  });

  describe("openai-compatible chat model step", () => {
    // The cache is keyed by base url + api key, so the priming fetch below has
    // to use the key the wizard resolves — pin it instead of reading the env.
    const ENV_KEY = "env-key";
    beforeEach(() => {
      vi.stubEnv("OPENAI_COMPAT_API_KEY", ENV_KEY);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    async function wizardAtChatModelStep(
      baseUrl: string,
    ): Promise<ProvidersWizardState> {
      let wizard = createProvidersWizardState("add", {
        kind: "openai-compatible",
      });
      wizard = { ...wizard, phase: "base_url" };
      for (const ch of baseUrl) wizard = next(wizard, ch, emptyKey());
      return next(wizard, "", emptyKey({ return: true }));
    }

    it("picks a discovered model with arrows + Enter", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ data: [{ id: "a-model" }, { id: "b-model" }] }),
        })),
      );
      await fetchOpenAiCompatModels("https://picks.example", ENV_KEY);

      let wizard = await wizardAtChatModelStep("https://picks.example");
      expect(wizard.phase).toBe("chat_model_line");

      wizard = next(wizard, "", emptyKey({ downArrow: true }));
      wizard = next(wizard, "", emptyKey({ return: true }));
      expect(wizard.chatModelLine).toBe("b-model");
      expect(wizard.phase).toBe("embedding_model_line");
    });

    it("lets typing override the discovered list", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ data: [{ id: "a-model" }] }),
        })),
      );
      await fetchOpenAiCompatModels("https://typed.example", ENV_KEY);

      let wizard = await wizardAtChatModelStep("https://typed.example");
      for (const ch of "my-own") wizard = next(wizard, ch, emptyKey());
      wizard = next(wizard, "", emptyKey({ return: true }));
      expect(wizard.chatModelLine).toBe("my-own");
      expect(wizard.phase).toBe("embedding_model_line");
    });
  });

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
