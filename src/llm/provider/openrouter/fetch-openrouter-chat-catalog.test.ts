import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listOpenRouterChatPicks,
  refreshOpenRouterChatCatalogFromApi,
} from "./fetch-openrouter-chat-catalog.js";

describe("refreshOpenRouterChatCatalogFromApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("filters out Anthropic and keeps tool-capable models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "openrouter/auto",
              name: "Auto",
              context_length: 1_000_000,
              pricing: { prompt: "0", completion: "0" },
              supported_parameters: ["tools"],
              architecture: { input_modalities: ["text", "image"] },
            },
            {
              id: "anthropic/claude-sonnet-4",
              name: "Claude",
              context_length: 200_000,
              pricing: { prompt: "0.000003", completion: "0.000015" },
              supported_parameters: ["tools"],
            },
            {
              id: "qwen/qwen3.6-35b-a3b",
              name: "Qwen 3.6",
              context_length: 262_144,
              pricing: { prompt: "0.00000015", completion: "0.000001" },
              supported_parameters: ["tools"],
              architecture: { input_modalities: ["text"] },
            },
            {
              id: "qwen/qwen3.5-35b-a3b",
              name: "Qwen 3.5",
              context_length: 262_144,
              pricing: { prompt: "0.00000014", completion: "0.000001" },
              supported_parameters: ["tools"],
              architecture: { input_modalities: ["text"] },
            },
          ],
        }),
      })),
    );

    const ok = await refreshOpenRouterChatCatalogFromApi();
    expect(ok).toBe(true);
    const picks = listOpenRouterChatPicks();
    expect(picks.some((p) => p.id === "openrouter/auto")).toBe(true);
    expect(picks.some((p) => p.id === "qwen/qwen3.6-35b-a3b")).toBe(true);
    expect(picks.some((p) => p.id === "qwen/qwen3.5-35b-a3b")).toBe(false);
    expect(picks.some((p) => p.id.startsWith("anthropic/"))).toBe(false);
  });
});
