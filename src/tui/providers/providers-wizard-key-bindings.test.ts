import type { Key } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { PICK_WINDOW } from "../components/wizard-pick-list.js";
import { PROVIDER_PRESETS } from "./provider-presets.js";
import { LOCAL_EMBEDDING_CHOICE_ID } from "./providers-model-options.js";
import { handleProvidersWizardKey } from "./providers-wizard-key-bindings.js";
import { KIND_ROW_ORDER } from "./providers-wizard-phases.js";
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

function presetRowIndex(id: string): number {
  return KIND_ROW_ORDER.findIndex(
    (row) => typeof row === "object" && row.presetId === id,
  );
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

  it("recovers the preset identity of the entry being reconfigured", () => {
    // Reconfiguring `groq` must stay Groq: the key screen names
    // GROQ_API_KEY and the save keeps the id instead of minting an
    // `openai-compatible` duplicate.
    const wizard = createProvidersWizardState("configure", {
      providerId: "groq",
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai",
    });
    expect(wizard.presetId).toBe("groq");
    expect(wizard.providerId).toBe("groq");
  });

  it("recovers the preset behind a numbered entry id", () => {
    const wizard = createProvidersWizardState("configure", {
      providerId: "groq-2",
      kind: "openai-compatible",
    });
    expect(wizard.presetId).toBe("groq");
    expect(wizard.providerId).toBe("groq-2");
  });

  it("leaves presetId empty for hand-added compat entries", () => {
    const wizard = createProvidersWizardState("configure", {
      providerId: "my-vllm",
      kind: "openai-compatible",
    });
    expect(wizard.presetId).toBeNull();
  });
});

describe("KIND_ROW_ORDER", () => {
  it("lists the subscription CLI first, then catalogs, presets alphabetically by label, manual last", () => {
    // A CLI-backed provider needs no key and no endpoint, so it is the
    // shortest path from a fresh install to a working agent.
    expect(KIND_ROW_ORDER[0]).toBe("claude-cli");
    expect(KIND_ROW_ORDER[1]).toBe("openrouter");
    expect(KIND_ROW_ORDER[2]).toBe("aimlapi");
    expect(KIND_ROW_ORDER[3]).toBe("gemini");
    expect(KIND_ROW_ORDER[KIND_ROW_ORDER.length - 1]).toBe("openai-compatible");

    const presetRows = KIND_ROW_ORDER.slice(4, -1);
    expect(presetRows).toEqual(
      PROVIDER_PRESETS.map((preset) => ({ presetId: preset.id })),
    );
    const labels = PROVIDER_PRESETS.map((p) => p.label);
    const sorted = [...labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(labels).toEqual(sorted);
  });
});

describe("handleProvidersWizardKey", () => {
  it("takes the Claude CLI row straight past the API-key screen", () => {
    let wizard = createProvidersWizardState("add");
    wizard = { ...wizard, cursor: KIND_ROW_ORDER.indexOf("claude-cli") };
    wizard = next(wizard, "", emptyKey({ return: true }));
    // There is no key to paste — the CLI authenticates from its own
    // session — so stopping on `api_key` would be a dead end.
    expect(wizard).toMatchObject({
      kind: "claude-cli",
      phase: "chat_model_line",
    });
    expect(wizard.presetId).toBeNull();
  });

  it("takes Gemini from API key directly to model selection", () => {
    let wizard = createProvidersWizardState("add");
    wizard = { ...wizard, cursor: KIND_ROW_ORDER.indexOf("gemini") };
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard).toMatchObject({ kind: "gemini", phase: "api_key" });

    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).toBe("chat_model_line");
    expect(wizard.phase).not.toBe("base_url");
  });

  it("walks the aimlapi onboarding flow when the cursor lands on it", () => {
    let wizard = createProvidersWizardState("add");

    // Addressed by name so inserting a row above it does not silently
    // repoint this flow at a different provider.
    wizard = { ...wizard, cursor: KIND_ROW_ORDER.indexOf("aimlapi") };
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
      // Choosing a discovered model is the final step: it records the id
      // and submits, no embedding screen after it.
      const result = handleProvidersWizardKey("", emptyKey({ return: true }), wizard);
      expect(result).toMatchObject({ handled: true, submit: true });
      if ("wizard" in result) {
        expect(result.wizard.chatModelLine).toBe("b-model");
      }
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
      // A typed id is the final step now: Enter saves from the chat model
      // line, the embedding screen is gone from the flow.
      const result = handleProvidersWizardKey("", emptyKey({ return: true }), wizard);
      expect(result).toMatchObject({ handled: true, submit: true });
      if ("wizard" in result) {
        expect(result.wizard.chatModelLine).toBe("my-own");
      }
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

    wizard = { ...wizard, cursor: KIND_ROW_ORDER.indexOf("openrouter") };
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

    // Presets follow the two catalog kinds, alphabetically by label,
    // so the row index is computed instead of hardcoded.
    const nousIdx = presetRowIndex("nous");
    for (let i = 0; i < nousIdx; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.kind).toBe("openai-compatible");
    expect(wizard.presetId).toBe("nous");
    expect(wizard.baseUrlLine).toBe("https://inference-api.nousresearch.com");
    // Nous lists models without credentials, so both the URL and the key
    // screens are skipped: the operator lands on the model choice.
    expect(wizard.phase).toBe("chat_model_line");
  });

  it("reaches a later preset by moving down the same list", () => {
    let wizard = createProvidersWizardState("add");
    const deepseekIdx = presetRowIndex("deepseek");
    for (let i = 0; i < deepseekIdx; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.presetId).toBe("deepseek");
    expect(wizard.baseUrlLine).toBe("https://api.deepseek.com");
  });

  it("takes a keyed preset through the key screen to the model list", () => {
    let wizard = createProvidersWizardState("add");
    // Groq is a keyed preset; two leading kind rows precede the presets.
    const groqIdx = presetRowIndex("groq");
    for (let i = 0; i < groqIdx; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.presetId).toBe("groq");
    expect(wizard.phase).toBe("api_key");
    // After the key, a preset skips the URL screen and lands on the model
    // choice: service, key, models, three screens, no URL to type.
    for (const ch of "gsk") wizard = next(wizard, ch, emptyKey());
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).toBe("chat_model_line");
  });

  it("skips the key screen for a local server", () => {
    let wizard = createProvidersWizardState("add");
    const lmIdx = presetRowIndex("lmstudio");
    for (let i = 0; i < lmIdx; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.presetId).toBe("lmstudio");
    // A local server has no key at all, so the wizard goes straight to the
    // model choice.
    expect(wizard.phase).toBe("chat_model_line");
  });

  it("saves local Ollama in two screens, with its own localhost URL", () => {
    // Local Ollama is the second local preset, and its host:port differs
    // from LM Studio's. Picking it must fill in 11434 and skip both the
    // URL and the key screens: `ollama serve` has no key at all.
    let wizard = createProvidersWizardState("add");
    const ollamaIdx = presetRowIndex("ollama");
    for (let i = 0; i < ollamaIdx; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.kind).toBe("openai-compatible");
    expect(wizard.presetId).toBe("ollama");
    // Stored without `/v1`: call sites append it, so a suffix here would
    // send requests to `/v1/v1/models`, which Ollama answers with a 404.
    expect(wizard.baseUrlLine).toBe("http://localhost:11434");
    expect(wizard.phase).toBe("chat_model_line");

    // Model ids are Ollama tags, typed as the server reports them.
    for (const ch of "llama3.2:latest") wizard = next(wizard, ch, emptyKey());
    const result = handleProvidersWizardKey("", emptyKey({ return: true }), wizard);
    expect(result).toMatchObject({ handled: true, submit: true });
    if ("wizard" in result) {
      expect(result.wizard.chatModelLine).toBe("llama3.2:latest");
    }
  });

  it("keeps local Ollama and Ollama Cloud on separate rows", () => {
    // The two share an id prefix and a vendor name; picking the local row
    // must not land on the hosted service (or vice versa).
    const localIdx = presetRowIndex("ollama");
    const cloudIdx = presetRowIndex("ollama-cloud");
    expect(localIdx).not.toBe(cloudIdx);

    for (const [idx, expected] of [
      [localIdx, "ollama"],
      [cloudIdx, "ollama-cloud"],
    ] as const) {
      let wizard = createProvidersWizardState("add");
      for (let i = 0; i < idx; i += 1) {
        wizard = next(wizard, "", emptyKey({ downArrow: true }));
      }
      wizard = next(wizard, "", emptyKey({ return: true }));
      expect(wizard.presetId).toBe(expected);
    }
  });

  it("recovers the local Ollama preset when reconfiguring its entry", () => {
    // `ollama` is a prefix of `ollama-cloud`, so the lookup must not
    // confuse a hosted entry for the local one.
    const local = createProvidersWizardState("configure", {
      providerId: "ollama",
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434",
    });
    expect(local.presetId).toBe("ollama");

    const cloud = createProvidersWizardState("configure", {
      providerId: "ollama-cloud",
      kind: "openai-compatible",
      baseUrl: "https://ollama.com",
    });
    expect(cloud.presetId).toBe("ollama-cloud");
  });

  it("a preset never shows the URL screen", () => {
    // Groq (keyed): service -> key -> models, base_url is never reached.
    let wizard = createProvidersWizardState("add");
    const groqIdx = presetRowIndex("groq");
    for (let i = 0; i < groqIdx; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    for (const ch of "gsk") wizard = next(wizard, ch, emptyKey());
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).not.toBe("base_url");
  });

  it("still shows the URL screen for the manual openai-compatible row", () => {
    let wizard = createProvidersWizardState("add");
    // Manual entry is the last row.
    wizard = next(wizard, "", emptyKey({ upArrow: true }));
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.kind).toBe("openai-compatible");
    expect(wizard.presetId).toBeNull();
    // No key typed, Enter through the key screen: a hand-added compat
    // endpoint still has to declare its base URL.
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).toBe("base_url");
  });

  it("Esc from a preset returns to the provider list, not out of the wizard", () => {
    let wizard = createProvidersWizardState("add");
    // Nous is keyless, so the wizard lands straight on chat_model_line.
    const nousIdx = presetRowIndex("nous");
    for (let i = 0; i < nousIdx; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.phase).toBe("chat_model_line");

    const result = handleProvidersWizardKey("", emptyKey({ escape: true }), wizard);
    expect(result.handled).toBe(true);
    expect("closed" in result && result.closed).toBeFalsy();
    expect("wizard" in result && result.wizard.phase).toBe("pick_kind");
    // The cursor lands back on the row we came from.
    expect("wizard" in result && result.wizard.cursor).toBe(nousIdx);
  });

  it("Esc on the provider list closes the wizard", () => {
    const wizard = createProvidersWizardState("add");
    const result = handleProvidersWizardKey("", emptyKey({ escape: true }), wizard);
    expect("closed" in result && result.closed).toBe(true);
  });

  it("stepping back clears the previous pick so a new one starts clean", () => {
    let wizard = createProvidersWizardState("add");
    wizard = { ...wizard, cursor: presetRowIndex("cerebras") };
    wizard = next(wizard, "", emptyKey({ return: true }));
    wizard = next(wizard, "", emptyKey({ escape: true }));
    expect(wizard.presetId).toBeNull();
    expect(wizard.baseUrlLine).toBe("");
  });

  it("saves a keyless preset in exactly two screens: service then models", () => {
    // The end-to-end main path: Nous from the provider list to a
    // submittable wizard without a URL screen and without a key screen.
    let wizard = createProvidersWizardState("add");
    const nousIdx = presetRowIndex("nous");
    for (let i = 0; i < nousIdx; i += 1) {
      wizard = next(wizard, "", emptyKey({ downArrow: true }));
    }
    // Screen one: pick the service.
    wizard = next(wizard, "", emptyKey({ return: true }));
    expect(wizard.presetId).toBe("nous");
    expect(wizard.phase).toBe("chat_model_line");
    // Screen two: type a model id and save. No URL, no key, no embedding.
    for (const ch of "hermes-4-405b") wizard = next(wizard, ch, emptyKey());
    const result = handleProvidersWizardKey("", emptyKey({ return: true }), wizard);
    expect(result).toMatchObject({ handled: true, submit: true });
    if ("wizard" in result) {
      expect(result.wizard.chatModelLine).toBe("hermes-4-405b");
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
