import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  apiKeyForWizard,
  apiKeyPhaseError,
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
