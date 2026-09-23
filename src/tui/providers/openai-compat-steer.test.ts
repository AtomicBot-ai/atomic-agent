import { describe, expect, it } from "vitest";
import { wizardForOpenAiCompatUrl } from "./openai-compat-steer.js";

describe("wizardForOpenAiCompatUrl", () => {
  it("lands an Ollama URL on the Ollama preset, skipping the key screen", () => {
    // `ollama serve` answers 404 on /health and OpenAI-shape on
    // /v1/models, so the External probe reports `openai-compat`; the
    // steer must open the same state Enter on the "Ollama (local)"
    // pick_kind row builds — no key screen, straight to the model list.
    const wizard = wizardForOpenAiCompatUrl("http://127.0.0.1:11434");
    expect(wizard).toMatchObject({
      mode: "add",
      kind: "openai-compatible",
      presetId: "ollama",
      baseUrlLine: "http://127.0.0.1:11434",
      phase: "chat_model_line",
    });
  });

  it("keeps a remote Ollama host instead of the preset's localhost", () => {
    const wizard = wizardForOpenAiCompatUrl("http://192.168.1.50:11434");
    expect(wizard.presetId).toBe("ollama");
    expect(wizard.baseUrlLine).toBe("http://192.168.1.50:11434");
  });

  it("lands an Atomic Chat URL on its preset, skipping the key screen", () => {
    // Atomic Chat's Local API Server 404s /health and lists models on
    // /v1/models, so it reaches the steer exactly like Ollama does.
    const wizard = wizardForOpenAiCompatUrl("http://127.0.0.1:1337");
    expect(wizard).toMatchObject({
      mode: "add",
      kind: "openai-compatible",
      presetId: "atomic-chat",
      baseUrlLine: "http://127.0.0.1:1337",
      phase: "chat_model_line",
    });
  });

  it("opens the manual compat row prefilled for a non-Ollama server", () => {
    // LM Studio / vLLM / KoboldCpp: same verdict, no preset identity to
    // assume, so the add flow starts on the URL screen with the probed
    // URL already typed — Enter confirms it and walks URL → key → model.
    const wizard = wizardForOpenAiCompatUrl("http://127.0.0.1:5001");
    expect(wizard).toMatchObject({
      mode: "add",
      kind: "openai-compatible",
      presetId: null,
      baseUrlLine: "http://127.0.0.1:5001",
      phase: "base_url",
    });
  });
});
