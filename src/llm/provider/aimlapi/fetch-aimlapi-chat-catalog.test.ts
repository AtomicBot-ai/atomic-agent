import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listAimlapiChatPicks,
  refreshAimlapiChatCatalogFromApi,
} from "./fetch-aimlapi-chat-catalog.js";

describe("refreshAimlapiChatCatalogFromApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps catalog-known ids first, hydrates new ids from features/contextLength", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "openai/gpt-5-2",
              type: "chat-completion",
              features: [
                "openai/chat-completion.function",
                "openai/chat-completion.parallel-tool-calls",
                "openai/chat-completion.vision",
              ],
              info: { contextLength: 400_000 },
            },
            {
              id: "x-ai/grok-4-1-fast-reasoning",
              type: "chat-completion",
              features: [
                "openai/chat-completion.function",
                "openai/chat-completion.parallel-tool-calls",
                "openai/chat-completion.vision",
              ],
              info: { contextLength: 2_000_000 },
            },
            {
              id: "vendor/brand-new",
              type: "chat-completion",
              features: ["openai/chat-completion.function"],
              info: { contextLength: 32_000 },
            },
          ],
        }),
      })),
    );

    const ok = await refreshAimlapiChatCatalogFromApi();
    expect(ok).toBe(true);
    const picks = listAimlapiChatPicks();
    expect(picks[0]?.id).toBe("openai/gpt-5-2");
    expect(picks.some((p) => p.id === "x-ai/grok-4-1-fast-reasoning")).toBe(
      true,
    );
    const fresh = picks.find((p) => p.id === "vendor/brand-new");
    expect(fresh).toBeDefined();
    expect(fresh?.entry.contextWindow).toBe(32_000);
    expect(fresh?.entry.supportsTools).toBe("basic");
  });

  it("drops /v1/responses-only ids (type: 'responses') so the agent never 404s on them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "openai/gpt-5-pro",
              type: "responses",
              features: ["openai/response-api.function"],
              info: { contextLength: 400_000 },
            },
            {
              id: "openai/gpt-5-2",
              type: "chat-completion",
              features: [
                "openai/chat-completion.function",
                "openai/chat-completion.parallel-tool-calls",
                "openai/chat-completion.vision",
              ],
              info: { contextLength: 400_000 },
            },
          ],
        }),
      })),
    );

    const ok = await refreshAimlapiChatCatalogFromApi();
    expect(ok).toBe(true);
    const picks = listAimlapiChatPicks();
    expect(picks.some((p) => p.id === "openai/gpt-5-pro")).toBe(false);
    expect(picks.some((p) => p.id === "openai/gpt-5-2")).toBe(true);
  });

  it("drops chat-completion models without function/tool support", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/no-tools",
              type: "chat-completion",
              features: ["openai/chat-completion.stream"],
              info: { contextLength: 8000 },
            },
            {
              id: "openai/gpt-5-2",
              type: "chat-completion",
              features: [
                "openai/chat-completion.function",
                "openai/chat-completion.parallel-tool-calls",
              ],
              info: { contextLength: 400_000 },
            },
          ],
        }),
      })),
    );

    const ok = await refreshAimlapiChatCatalogFromApi();
    expect(ok).toBe(true);
    const picks = listAimlapiChatPicks();
    expect(picks.some((p) => p.id === "vendor/no-tools")).toBe(false);
    expect(picks.some((p) => p.id === "openai/gpt-5-2")).toBe(true);
  });

  it("returns false and leaves a static fallback when the API call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const ok = await refreshAimlapiChatCatalogFromApi();
    expect(ok).toBe(false);
    const picks = listAimlapiChatPicks();
    expect(picks.length).toBeGreaterThan(0);
  });
});
