import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { isProviderOnThisMachine, servedProviderOnThisMachine } from "./provider-on-this-machine.js";

/** ATO-1721: where the model runs, not its `modelMode` policy. */
describe("isProviderOnThisMachine", () => {
  it("is true for a loopback address", () => {
    expect(isProviderOnThisMachine({ kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" })).toBe(true);
    expect(isProviderOnThisMachine({ kind: "llama-server", url: "http://127.0.0.1:19091" })).toBe(true);
  });

  it("is false for a cloud service, another computer, or no address", () => {
    expect(isProviderOnThisMachine({ kind: "openrouter" })).toBe(false);
    expect(isProviderOnThisMachine({ kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(isProviderOnThisMachine({ kind: "openai-compatible", baseUrl: "http://192.168.1.20:8080/v1" })).toBe(false);
    expect(isProviderOnThisMachine(undefined)).toBe(false);
  });

  it("reaches a llama-server entry without its own URL at the fallback", () => {
    expect(isProviderOnThisMachine({ kind: "llama-server" }, "http://127.0.0.1:9931")).toBe(true);
    expect(isProviderOnThisMachine({ kind: "llama-server" }, "http://gpu-box.lan:9931")).toBe(false);
    expect(isProviderOnThisMachine({ kind: "openrouter" }, "http://127.0.0.1:9931")).toBe(false);
  });
});

describe("servedProviderOnThisMachine", () => {
  const config = {
    llm: {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto",
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
        { id: "remote", kind: "openrouter" },
      ],
    },
    localModels: { url: "http://127.0.0.1:9931" },
  } as unknown as AtomicAgentConfig;

  it("follows the provider serving the prompt, else the active one", () => {
    expect(servedProviderOnThisMachine(config)).toBe(true);
    expect(servedProviderOnThisMachine(config, "local-llama")).toBe(true);
    expect(servedProviderOnThisMachine(config, "remote")).toBe(false);
    expect(servedProviderOnThisMachine(config, "missing")).toBe(false);
  });
});
