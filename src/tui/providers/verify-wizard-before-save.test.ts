import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyWizardBeforeSave } from "./verify-wizard-before-save.js";
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
  "LMSTUDIO_API_KEY",
] as const;

function wizard(
  kind: ProvidersWizardKind,
  overrides: Partial<ProvidersWizardState> = {},
): ProvidersWizardState {
  return {
    ...createProvidersWizardState("add", { kind }),
    phase: "api_key",
    apiKeyBuffer: "sk-test-key",
    ...overrides,
  };
}

function stubChatCompletions(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("verifyWizardBeforeSave", () => {
  it("lets a working key through with nothing to report", async () => {
    stubChatCompletions(200, { choices: [{ message: { content: "" } }] });
    const gate = await verifyWizardBeforeSave(wizard("openrouter"));
    expect(gate).toEqual({ proceed: true, warning: null });
  });

  it("stops a key the provider rejects", async () => {
    stubChatCompletions(401, { error: "No auth credentials found" });
    const gate = await verifyWizardBeforeSave(wizard("openrouter"));
    expect(gate.proceed).toBe(false);
    if (!gate.proceed) {
      expect(gate.error).toContain("rejected this key");
    }
  });

  it("stops a key with no balance behind it", async () => {
    // The whole reason the probe spends a token instead of listing
    // models: a drained account answers every listing perfectly well.
    stubChatCompletions(402, { error: "Insufficient credits" });
    const gate = await verifyWizardBeforeSave(wizard("aimlapi"));
    expect(gate.proceed).toBe(false);
    if (!gate.proceed) {
      expect(gate.error).toContain("no usable balance");
    }
  });

  it("saves with a warning when the provider cannot be reached", async () => {
    // An offline laptop or a corporate proxy must still be able to
    // finish the wizard; the key is simply unproven.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const gate = await verifyWizardBeforeSave(wizard("gemini"));
    expect(gate.proceed).toBe(true);
    if (gate.proceed) {
      expect(gate.warning).toContain("Saved unverified");
    }
  });

  it("saves with a warning when the key is merely throttled", async () => {
    stubChatCompletions(429, "slow down");
    const gate = await verifyWizardBeforeSave(wizard("openrouter"));
    expect(gate.proceed).toBe(true);
    if (gate.proceed) {
      expect(gate.warning).toContain("rate-limiting");
    }
  });

  it("never calls out for a keyless local provider", async () => {
    const fetchMock = stubChatCompletions(200, {});
    const gate = await verifyWizardBeforeSave(
      wizard("openai-compatible", {
        presetId: "lmstudio",
        apiKeyBuffer: "",
        baseUrlLine: "http://localhost:1234",
      }),
    );
    expect(gate).toEqual({ proceed: true, warning: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never calls out for a hand-typed endpoint on this machine", async () => {
    const fetchMock = stubChatCompletions(200, {});
    const gate = await verifyWizardBeforeSave(
      wizard("openai-compatible", { baseUrlLine: "http://127.0.0.1:8000" }),
    );
    expect(gate).toEqual({ proceed: true, warning: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the key to the service the operator picked", async () => {
    const fetchMock = stubChatCompletions(200, { choices: [] });
    await verifyWizardBeforeSave(wizard("gemini"));
    // Gemini's OpenAI-compatible surface lives under /v1beta/openai.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  it("stops when the operator cancels the check", async () => {
    const controller = new AbortController();
    controller.abort();
    stubChatCompletions(200, {});
    const gate = await verifyWizardBeforeSave(wizard("openrouter"), {
      signal: controller.signal,
    });
    expect(gate.proceed).toBe(false);
  });
});
