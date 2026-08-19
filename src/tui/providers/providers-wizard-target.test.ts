import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import { upsertLlmProvider } from "../persist-llm-provider.js";
import {
  apiKeyForWizard,
  apiKeyPhaseError,
  emptyKeyMeaningForWizard,
  envHintForWizard,
  wizardKeyIsOptional,
} from "./providers-wizard-target.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardState,
} from "./providers-wizard-state.js";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "AIMLAPI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
  "GROQ_API_KEY",
  "LMSTUDIO_API_KEY",
  "OLLAMA_API_KEY",
  "NOUS_API_KEY",
  "OLLAMA_CLOUD_API_KEY",
  "VLLM_API_KEY",
] as const;

function wizardFor(
  kind: ProvidersWizardKind,
  presetId?: string,
): ProvidersWizardState {
  return {
    ...createProvidersWizardState("add", { kind }),
    phase: "api_key",
    ...(presetId ? { presetId } : {}),
  };
}

describe("apiKeyPhaseError", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("refuses an empty key for every service that needs one", () => {
    for (const wizard of [
      wizardFor("openrouter"),
      wizardFor("aimlapi"),
      wizardFor("gemini"),
      wizardFor("openai-compatible"),
      wizardFor("openai-compatible", "groq"),
    ]) {
      expect(apiKeyPhaseError(wizard)).toContain("API key required");
    }
  });

  it("names the service's own env var in the message", () => {
    expect(apiKeyPhaseError(wizardFor("openrouter"))).toContain(
      "OPENROUTER_API_KEY",
    );
    expect(apiKeyPhaseError(wizardFor("openai-compatible", "groq"))).toContain(
      "GROQ_API_KEY",
    );
  });

  it("treats a whitespace-only buffer as empty", () => {
    // What a mis-paste leaves behind. Accepting it would write "   " to
    // .env and present it to the provider as a key.
    const wizard = { ...wizardFor("openrouter"), apiKeyBuffer: "   " };
    expect(apiKeyPhaseError(wizard)).toContain("API key required");
  });

  it("accepts a typed key", () => {
    const wizard = { ...wizardFor("openrouter"), apiKeyBuffer: "sk-or-typed" };
    expect(apiKeyPhaseError(wizard)).toBeNull();
  });

  it("accepts an empty buffer when the service's key is already in .env", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-from-env";
    expect(apiKeyPhaseError(wizardFor("openrouter"))).toBeNull();
  });

  it("does not let another service's key satisfy the screen", () => {
    // The lookup used to run as a fixed openai-compatible entry, so an
    // unrelated OPENAI_API_KEY answered for OpenRouter, AI/ML API and
    // Gemini alike — an empty key screen that looked satisfied.
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(apiKeyPhaseError(wizardFor("openrouter"))).toContain(
      "API key required",
    );
    expect(apiKeyPhaseError(wizardFor("aimlapi"))).toContain("API key required");
    expect(apiKeyPhaseError(wizardFor("gemini"))).toContain("API key required");
    expect(apiKeyForWizard(wizardFor("openrouter"))).toBeUndefined();
  });

  it("still resolves the shared variable for the manual compat entry", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(apiKeyPhaseError(wizardFor("openai-compatible"))).toBeNull();
    expect(apiKeyForWizard(wizardFor("openai-compatible"))).toBe("sk-openai");
  });

  it("leaves keyless services alone", () => {
    for (const presetId of ["lmstudio", "ollama", "nous", "ollama-cloud"]) {
      const wizard = wizardFor("openai-compatible", presetId);
      expect(wizardKeyIsOptional(wizard)).toBe(true);
      expect(apiKeyPhaseError(wizard)).toBeNull();
    }
  });

  it("treats a hand-added loopback endpoint as keyless", () => {
    // A raw llama-server on the operator's machine has no preset and no
    // key. Any loopback host, at any port, opts out of the key screen.
    for (const baseUrlLine of [
      "http://127.0.0.1:9931",
      "http://localhost:8080",
      "http://0.0.0.0:1234",
      "http://[::1]:9931",
      "localhost:9931", // no scheme, as typed
      "http://my-box.localhost:9931",
    ]) {
      const wizard = { ...wizardFor("openai-compatible"), baseUrlLine };
      expect(wizardKeyIsOptional(wizard)).toBe(true);
      expect(apiKeyPhaseError(wizard)).toBeNull();
    }
  });

  it("still requires a key for a non-loopback custom URL", () => {
    const wizard = {
      ...wizardFor("openai-compatible"),
      baseUrlLine: "https://api.example.com",
    };
    expect(wizardKeyIsOptional(wizard)).toBe(false);
    expect(apiKeyPhaseError(wizard)).toContain("API key required");
  });

  it("refuses a non-ASCII key with a clear message", () => {
    // A stray Cyrillic character cannot go into an Authorization header;
    // the message names the problem instead of the raw ByteString crash.
    const wizard = { ...wizardFor("openrouter"), apiKeyBuffer: "sk-т" };
    expect(apiKeyPhaseError(wizard)).toContain("non-ASCII");
  });
});

describe("apiKeyPhaseError in configure mode", () => {
  // A key the operator typed into the wizard once is stored in
  // `config.json` by `upsertLlmProvider`, with nothing written to `.env`.
  // The gate has to see it exactly where `saveProviderWizardToConfig`
  // does, or reconfiguring a provider's model demands the key again.
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
    stateDir = mkdtempSync(join(tmpdir(), "wizard-target-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    if (previousStateDir === undefined) {
      delete process.env.ATOMIC_AGENT_STATE_DIR;
    } else {
      process.env.ATOMIC_AGENT_STATE_DIR = previousStateDir;
    }
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfigCache();
  });

  function configureWizard(
    kind: ProvidersWizardKind,
    providerId: string,
  ): ProvidersWizardState {
    return createProvidersWizardState("configure", { providerId, kind });
  }

  it("accepts an empty screen when the entry's key is in config.json", () => {
    upsertLlmProvider({
      id: "openrouter",
      kind: "openrouter",
      apiKey: "sk-or-stored",
    });
    const wizard = configureWizard("openrouter", "openrouter");
    expect(apiKeyForWizard(wizard)).toBe("sk-or-stored");
    expect(apiKeyPhaseError(wizard)).toBeNull();
  });

  it("reads the entry's own env var, as the save path does", () => {
    // A hand-added compat entry naming its own variable: no preset to
    // supply it, and the per-kind fallbacks would answer with a
    // different service's key or nothing at all.
    upsertLlmProvider({
      id: "my-vllm",
      kind: "openai-compatible",
      baseUrl: "http://192.168.1.50:8000/v1",
      apiKeyEnvVar: "VLLM_API_KEY",
    });
    process.env.VLLM_API_KEY = "vllm-from-env";
    const wizard = configureWizard("openai-compatible", "my-vllm");
    expect(apiKeyForWizard(wizard)).toBe("vllm-from-env");
    expect(apiKeyPhaseError(wizard)).toBeNull();
  });

  it("still refuses when the entry has no key anywhere", () => {
    upsertLlmProvider({ id: "openrouter", kind: "openrouter" });
    const wizard = configureWizard("openrouter", "openrouter");
    expect(apiKeyPhaseError(wizard)).toContain("API key required");
  });

  it("refuses for an id that is not stored yet", () => {
    const wizard = configureWizard("openrouter", "openrouter");
    expect(apiKeyPhaseError(wizard)).toContain("API key required");
  });

  it("does not let a stored key satisfy an `add` run", () => {
    // Adding a second OpenRouter entry must still ask for its own key,
    // whatever the first one has saved.
    upsertLlmProvider({
      id: "openrouter",
      kind: "openrouter",
      apiKey: "sk-or-stored",
    });
    expect(apiKeyPhaseError(wizardFor("openrouter"))).toContain(
      "API key required",
    );
    expect(apiKeyForWizard(wizardFor("openrouter"))).toBeUndefined();
  });

  it("tells the operator the saved key is what an empty screen keeps", () => {
    upsertLlmProvider({
      id: "openrouter",
      kind: "openrouter",
      apiKey: "sk-or-stored",
    });
    expect(
      emptyKeyMeaningForWizard(configureWizard("openrouter", "openrouter")),
    ).toBe("Leave empty to keep the key already saved.");
  });
});

describe("emptyKeyMeaningForWizard", () => {
  it("points at .env when there is no saved key to keep", () => {
    expect(emptyKeyMeaningForWizard(wizardFor("openrouter"))).toContain(".env");
  });

  it("calls the key optional for a keyless service", () => {
    expect(
      emptyKeyMeaningForWizard(wizardFor("openai-compatible", "lmstudio")),
    ).toContain("Optional for this service");
  });
});

describe("envHintForWizard", () => {
  it("names the preset's variable, not the shared compat one", () => {
    expect(envHintForWizard(wizardFor("openai-compatible", "groq"))).toBe(
      "GROQ_API_KEY",
    );
    expect(envHintForWizard(wizardFor("gemini"))).toBe("GEMINI_API_KEY");
    expect(envHintForWizard(wizardFor("openai-compatible"))).toBe(
      "OPENAI_COMPAT_API_KEY",
    );
  });
});
