import type { Key } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { PICK_WINDOW } from "../components/wizard-pick-list.js";
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
    home: false,
    end: false,
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

  it("falls through to the openai-compatible flow on the last kind slot", () => {
    let wizard = createProvidersWizardState("add");
    // Manual entry is the last row, after the preset rows.
    wizard = next(wizard, "", emptyKey({ upArrow: true }));
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

    it("pages and jumps through a long discovered list", async () => {
      const ids = Array.from({ length: 30 }, (_, i) => ({
        id: `model-${String(i + 1).padStart(2, "0")}`,
      }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ data: ids }) })),
      );
      await fetchOpenAiCompatModels("https://paging.example", ENV_KEY);

      let wizard = await wizardAtChatModelStep("https://paging.example");
      wizard = next(wizard, "", emptyKey({ pageDown: true }));
      expect(wizard.cursor).toBe(PICK_WINDOW);
      wizard = next(wizard, "", emptyKey({ end: true }));
      expect(wizard.cursor).toBe(29);
      // PgDn at the tail clamps instead of wrapping.
      wizard = next(wizard, "", emptyKey({ pageDown: true }));
      expect(wizard.cursor).toBe(29);
      wizard = next(wizard, "", emptyKey({ pageUp: true }));
      expect(wizard.cursor).toBe(29 - PICK_WINDOW);
      wizard = next(wizard, "", emptyKey({ home: true }));
      expect(wizard.cursor).toBe(0);
      // "j" stays a printable character here, not vim navigation: this
      // list coexists with the type-an-id-by-hand editor.
      wizard = next(wizard, "j", emptyKey());
      expect(wizard.cursor).toBe(0);
      expect(wizard.chatModelLine).toBe("j");
    });
  });

  describe("cloud pick list navigation against a live catalog", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubOpenRouterCatalog(count: number): void {
      // Identical scores keep the payload order (stable sort), so
      // cursor index N is exactly `vendor/model-NNN`.
      const data = Array.from({ length: count }, (_, i) => ({
        id: `vendor/model-${String(i).padStart(3, "0")}`,
        name: `Model ${i}`,
        context_length: 128_000,
        pricing: { prompt: "0.000001", completion: "0.000002" },
        supported_parameters: ["tools"],
      }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ data }) })),
      );
    }

    /**
     * The live catalog cache lives at module scope in the fetcher; a fresh
     * module graph per test keeps one test's refresh from leaking into the
     * rest of this file (same pattern as the fetcher's own tests).
     */
    async function freshOpenRouterPickPhase(count: number) {
      vi.resetModules();
      const catalog = await import(
        "../../llm/provider/openrouter/fetch-openrouter-chat-catalog.js"
      );
      const bindings = await import("./providers-wizard-key-bindings.js");
      stubOpenRouterCatalog(count);
      await catalog.refreshOpenRouterChatCatalogFromApi();
      const wizard: ProvidersWizardState = {
        ...createProvidersWizardState("add", { kind: "openrouter" }),
        phase: "pick_chat_model",
      };
      const step = (
        w: ProvidersWizardState,
        input: string,
        key: Key,
      ): ProvidersWizardState => {
        const result = bindings.handleProvidersWizardKey(input, key, w);
        if (!result.handled || !("wizard" in result)) {
          throw new Error("wizard key was not handled");
        }
        return result.wizard;
      };
      return { catalog, wizard, step };
    }

    it("jumps by one viewport with PgUp/PgDn and hits the edges with Home/End", async () => {
      const { wizard, step } = await freshOpenRouterPickPhase(30);

      let w = step(wizard, "", emptyKey({ pageDown: true }));
      expect(w.cursor).toBe(PICK_WINDOW);
      w = step(w, "", emptyKey({ pageDown: true }));
      expect(w.cursor).toBe(2 * PICK_WINDOW);
      // The jump clamps at the tail instead of wrapping.
      w = step(w, "", emptyKey({ pageDown: true }));
      expect(w.cursor).toBe(29);
      w = step(w, "", emptyKey({ pageUp: true }));
      expect(w.cursor).toBe(29 - PICK_WINDOW);
      w = step(w, "", emptyKey({ home: true }));
      expect(w.cursor).toBe(0);
      w = step(w, "", emptyKey({ pageUp: true }));
      expect(w.cursor).toBe(0);
      w = step(w, "", emptyKey({ end: true }));
      expect(w.cursor).toBe(29);
    });

    it("selects the highlighted row when the catalog shrank under the cursor", async () => {
      const { catalog, wizard, step } = await freshOpenRouterPickPhase(30);
      const deep = { ...wizard, cursor: 25 };

      // A background TTL refresh replaces the module-level cache while the
      // wizard is open; the list now has 10 rows and the cursor is stale.
      stubOpenRouterCatalog(10);
      await catalog.refreshOpenRouterChatCatalogFromApi();

      // The render layer highlights the clamped row, the last one. Enter
      // must select exactly that row, not silently fall back to the first.
      const submitted = step(deep, "", emptyKey({ return: true }));
      expect(submitted.selectedChatModelId).toBe("vendor/model-009");
      expect(submitted.phase).toBe("pick_embedding");
    });

    it("clamps a stale cursor before arrow movement after the catalog shrank", async () => {
      const { catalog, wizard, step } = await freshOpenRouterPickPhase(30);
      const deep = { ...wizard, cursor: 25 };

      stubOpenRouterCatalog(10);
      await catalog.refreshOpenRouterChatCatalogFromApi();

      // Highlight sits on the clamped last row (9); j wraps to the top
      // instead of computing from the stale 25.
      const moved = step(deep, "j", emptyKey());
      expect(moved.cursor).toBe(0);
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

  it("picks a known service straight from the provider list", () => {
    let wizard = createProvidersWizardState("add");

    // Presets follow the two catalog kinds, so Nous is the third row.
    wizard = next(wizard, "", emptyKey({ downArrow: true }));
    wizard = next(wizard, "", emptyKey({ downArrow: true }));
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.kind).toBe("openai-compatible");
    expect(wizard.presetId).toBe("nous");
    expect(wizard.baseUrlLine).toBe(
      "https://inference-api.nousresearch.com/v1",
    );
    // The endpoint is known, so the operator lands straight on the key
    // step instead of typing a URL.
    expect(wizard.phase).toBe("api_key");
  });

  it("reaches a later preset by moving down the same list", () => {
    let wizard = createProvidersWizardState("add");
    for (let i = 0; i < 3; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.presetId).toBe("groq");
    expect(wizard.baseUrlLine).toBe("https://api.groq.com/openai/v1");
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
