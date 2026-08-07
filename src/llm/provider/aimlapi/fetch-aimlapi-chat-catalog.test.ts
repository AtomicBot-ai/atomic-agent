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

  it("keeps every advertised model instead of a capped head", async () => {
    // 50 live models: the old MAX_PICKS = 32 truncated the tail.
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `vendor/model-${String(i).padStart(2, "0")}`,
      type: "chat-completion",
      features: ["openai.function"],
      info: { contextLength: 128_000 },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: many }) })),
    );

    const ok = await refreshAimlapiChatCatalogFromApi();
    expect(ok).toBe(true);
    const picks = listAimlapiChatPicks();
    expect(picks.length).toBe(50);
    expect(picks.some((p) => p.id === "vendor/model-49")).toBe(true);
  });

  it("orders the non-curated tail alphabetically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: "zeta/model", type: "chat-completion", features: ["openai.function"], info: { contextLength: 8000 } },
            { id: "alpha/model", type: "chat-completion", features: ["openai.function"], info: { contextLength: 8000 } },
            { id: "mid/model", type: "chat-completion", features: ["openai.function"], info: { contextLength: 8000 } },
          ],
        }),
      })),
    );

    await refreshAimlapiChatCatalogFromApi();
    const ids = listAimlapiChatPicks().map((p) => p.id);
    expect(ids).toEqual(["alpha/model", "mid/model", "zeta/model"]);
  });

  it("parses the current API shape (vendor-prefixed type, no features array)", async () => {
    // Verbatim shape of a live row as of 2026-08: `type` gained a vendor
    // prefix and `features` disappeared. The old parser matched neither,
    // so every chat model was dropped and the picker silently fell back
    // to the offline list.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "openai/gpt-4.1-mini-2025-04-14",
              type: "openai/chat-completions",
              aliases: ["gpt-4.1-mini-2025-04-14"],
              tags: ["playground:chat", "tier:tier_2"],
              info: { name: "GPT-4.1 Mini", contextLength: 1_000_000 },
            },
            {
              id: "vendor/video-model",
              type: "internal/video-generations/submit",
              info: { name: "Video", contextLength: 8000 },
            },
            {
              id: "vendor/image-model",
              type: "openai/image-generations",
              info: { name: "Image", contextLength: 8000 },
            },
            {
              id: "anthropic/claude-x",
              type: "anthropic/messages",
              info: { name: "Claude", contextLength: 200_000 },
            },
          ],
        }),
      })),
    );

    const ok = await refreshAimlapiChatCatalogFromApi();
    expect(ok).toBe(true);
    const ids = listAimlapiChatPicks().map((p) => p.id);
    expect(ids).toContain("openai/gpt-4.1-mini-2025-04-14");
    // Non-chat families in the same payload stay out.
    expect(ids).not.toContain("vendor/video-model");
    expect(ids).not.toContain("vendor/image-model");
    expect(ids).not.toContain("anthropic/claude-x");
  });

  it("still honours an explicit no-tools flag when the API sends one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/with-tools",
              type: "chat-completion",
              features: ["openai.function"],
              info: { contextLength: 8000 },
            },
            {
              id: "vendor/no-tools",
              type: "chat-completion",
              features: ["openai.chat"],
              info: { contextLength: 8000 },
            },
          ],
        }),
      })),
    );

    await refreshAimlapiChatCatalogFromApi();
    const ids = listAimlapiChatPicks().map((p) => p.id);
    expect(ids).toContain("vendor/with-tools");
    expect(ids).not.toContain("vendor/no-tools");
  });

  it("keeps models when the API says nothing about tool support", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/silent",
              type: "openai/chat-completions",
              info: { contextLength: 8000 },
            },
          ],
        }),
      })),
    );

    await refreshAimlapiChatCatalogFromApi();
    expect(listAimlapiChatPicks().map((p) => p.id)).toContain("vendor/silent");
  });

  it("ignores rows without a usable id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { type: "openai/chat-completions", info: { contextLength: 8000 } },
            { id: "", type: "openai/chat-completions", info: { contextLength: 8000 } },
            { id: "vendor/ok", type: "openai/chat-completions", info: { contextLength: 8000 } },
          ],
        }),
      })),
    );

    const ok = await refreshAimlapiChatCatalogFromApi();
    expect(ok).toBe(true);
    expect(listAimlapiChatPicks().map((p) => p.id)).toEqual(["vendor/ok"]);
  });

  it("falls back to the offline catalog on a malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ nope: true }) })),
    );
    const ok = await refreshAimlapiChatCatalogFromApi();
    expect(ok).toBe(false);
    expect(listAimlapiChatPicks().length).toBeGreaterThan(0);
  });
});
