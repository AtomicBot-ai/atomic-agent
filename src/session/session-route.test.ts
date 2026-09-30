import { describe, expect, it } from "vitest";
import type { UserLlmRunModeConfig } from "../config/llm-run-mode-config.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import { resolveRunMode } from "../llm/run-mode/resolve-run-mode.js";
import {
  SESSION_ROUTE_METADATA_KEY,
  readSessionRoute,
  resolveTurnRoute,
  sameSessionRoute,
} from "./session-route.js";

function llm(
  active: string,
  models: { aimlapi?: string } = {},
  runMode?: UserLlmRunModeConfig,
): ResolvedLlmConfig {
  return {
    activeTextProvider: active,
    activeEmbeddingProvider: "local-llama",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
      {
        id: "aimlapi",
        kind: "openai-compatible",
        defaultChatModel: models.aimlapi ?? "deepseek/deepseek-v4-flash",
      },
      { id: "openrouter", kind: "openrouter", defaultChatModel: "x/y" },
    ],
    toolTransport: "auto",
    ...(runMode ? { runMode } : {}),
  };
}

function route(
  resolved: ResolvedLlmConfig,
  extra: { pinnedProviderId?: string; fallbackOverrideId?: string | null } = {},
) {
  return resolveTurnRoute({
    resolved,
    runMode: resolveRunMode(resolved, { managedModelId: "qwen-3.5-4b" }),
    managedModelId: "qwen-3.5-4b",
    ...extra,
  });
}

describe("resolveTurnRoute", () => {
  it("resolves the active cloud provider and its chat model", () => {
    expect(route(llm("aimlapi"))).toEqual({
      mode: "cloud",
      main: { providerId: "aimlapi", model: "deepseek/deepseek-v4-flash" },
      worker: null,
    });
  });

  it("names a local link by the managed model", () => {
    expect(route(llm("local-llama"))).toEqual({
      mode: "local",
      main: { providerId: "local-llama", model: "qwen-3.5-4b" },
      worker: null,
    });
  });

  it("is stable for an unchanged config and differs on provider or model switch", () => {
    const a = route(llm("aimlapi"));
    expect(sameSessionRoute(a, route(llm("aimlapi")))).toBe(true);
    expect(sameSessionRoute(a, route(llm("openrouter")))).toBe(false);
    expect(
      sameSessionRoute(
        a,
        route(llm("aimlapi", { aimlapi: "anthropic/claude-sonnet-5" })),
      ),
    ).toBe(false);
  });

  it("starts on a sticky fallover link, and a pin wins over both", () => {
    expect(
      route(llm("aimlapi"), { fallbackOverrideId: "local-llama" }).main,
    ).toEqual({ providerId: "local-llama", model: "qwen-3.5-4b" });
    expect(
      route(llm("aimlapi"), {
        fallbackOverrideId: "local-llama",
        pinnedProviderId: "openrouter",
      }).main,
    ).toEqual({ providerId: "openrouter", model: "x/y" });
  });

  it("carries both legs in fusion", () => {
    expect(route(llm("aimlapi", {}, { mode: "fusion" }))).toEqual({
      mode: "fusion",
      main: { providerId: "aimlapi", model: "deepseek/deepseek-v4-flash" },
      worker: { providerId: "local-llama", model: "qwen-3.5-4b" },
    });
  });
});

describe("readSessionRoute", () => {
  it("round-trips a stored route", () => {
    const r = route(llm("aimlapi", {}, { mode: "fusion" }));
    const stored = JSON.parse(
      JSON.stringify({ [SESSION_ROUTE_METADATA_KEY]: r }),
    ) as Record<string, unknown>;
    expect(readSessionRoute(stored)).toEqual(r);
  });

  it("reads a malformed or absent value as no route", () => {
    expect(readSessionRoute(undefined)).toBeNull();
    expect(readSessionRoute({})).toBeNull();
    expect(readSessionRoute({ [SESSION_ROUTE_METADATA_KEY]: "x" })).toBeNull();
    expect(
      readSessionRoute({
        [SESSION_ROUTE_METADATA_KEY]: { mode: "warp", main: { providerId: "a" } },
      }),
    ).toBeNull();
    expect(
      readSessionRoute({
        [SESSION_ROUTE_METADATA_KEY]: { mode: "cloud", main: { providerId: "" } },
      }),
    ).toBeNull();
  });
});
