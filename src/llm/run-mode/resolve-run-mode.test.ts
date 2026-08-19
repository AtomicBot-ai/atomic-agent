import { describe, expect, it } from "vitest";

import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { resolveRunMode } from "./resolve-run-mode.js";

const LOCAL = { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" };
const CLOUD = { id: "openrouter", kind: "openrouter", defaultChatModel: "openai/gpt-4o-mini" };

function config(over: Partial<ResolvedLlmConfig> = {}): ResolvedLlmConfig {
  return {
    activeTextProvider: "local-llama",
    activeEmbeddingProvider: "local-llama",
    providers: [{ ...LOCAL }, { ...CLOUD }],
    toolTransport: "auto",
    ...over,
  };
}

describe("resolveRunMode", () => {
  it("derives local from the active provider when no runMode block exists", () => {
    const r = resolveRunMode(config());
    expect(r.stored).toBeNull();
    expect(r.effective).toBe("local");
    expect(r.primaryProviderId).toBe("local-llama");
    expect(r.degraded).toBeNull();
  });

  it("derives cloud from a cloud active provider", () => {
    const r = resolveRunMode(config({ activeTextProvider: "openrouter" }));
    expect(r.effective).toBe("cloud");
    expect(r.primaryProviderId).toBe("openrouter");
  });

  it("discovers both legs by provider kind", () => {
    const r = resolveRunMode(config());
    expect(r.localProviderId).toBe("local-llama");
    expect(r.cloudProviderId).toBe("openrouter");
  });

  it("honours explicitly pinned legs over kind discovery", () => {
    const r = resolveRunMode(
      config({
        providers: [{ ...LOCAL }, { ...CLOUD }, { id: "aimlapi", kind: "aimlapi" }],
        runMode: { cloudProvider: "aimlapi" },
      }),
    );
    expect(r.cloudProviderId).toBe("aimlapi");
  });

  it("resolves fusion when both legs exist and the cloud leg is active", () => {
    const r = resolveRunMode(
      config({ activeTextProvider: "openrouter", runMode: { mode: "fusion" } }),
    );
    expect(r.effective).toBe("fusion");
    // Fusion pins the cloud leg as primary, which is what makes it the
    // fallback chain's head and the local leg its `appendLocal` tail.
    expect(r.primaryProviderId).toBe("openrouter");
    expect(r.degraded).toBeNull();
  });

  it("defaults the fusion dial and sub-runner target", () => {
    const r = resolveRunMode(
      config({ activeTextProvider: "openrouter", runMode: { mode: "fusion" } }),
    );
    expect(r.fusion).toEqual({ cloudShare: 40, subRunners: "local" });
  });

  it("carries an explicit fusion dial through", () => {
    const r = resolveRunMode(
      config({
        activeTextProvider: "openrouter",
        runMode: { mode: "fusion", fusion: { cloudShare: 0, subRunners: "cloud" } },
      }),
    );
    expect(r.fusion).toEqual({ cloudShare: 0, subRunners: "cloud" });
  });

  // The non-contradiction rule: `activeTextProvider` is authoritative.
  it("drops stored fusion back to derived when the operator switched provider by hand", () => {
    const r = resolveRunMode(
      config({ activeTextProvider: "local-llama", runMode: { mode: "fusion" } }),
    );
    expect(r.effective).toBe("local");
    // Not a degradation — nothing is broken, the operator simply moved.
    expect(r.degraded).toBeNull();
  });

  it("drops stored cloud back to local when the local provider is active", () => {
    const r = resolveRunMode(
      config({ activeTextProvider: "local-llama", runMode: { mode: "cloud" } }),
    );
    expect(r.effective).toBe("local");
    expect(r.degraded).toBeNull();
  });

  it("degrades cloud to local when no cloud provider is configured", () => {
    const r = resolveRunMode(
      config({ providers: [{ ...LOCAL }], runMode: { mode: "cloud" } }),
    );
    expect(r.effective).toBe("local");
    expect(r.cloudProviderId).toBeNull();
    expect(r.degraded).toEqual({ reason: "no-cloud-provider", requested: "cloud" });
  });

  it("degrades fusion to local when no cloud provider is configured", () => {
    const r = resolveRunMode(
      config({ providers: [{ ...LOCAL }], runMode: { mode: "fusion" } }),
    );
    expect(r.effective).toBe("local");
    expect(r.degraded).toEqual({ reason: "no-cloud-provider", requested: "fusion" });
  });

  it("degrades fusion to cloud when no local provider is configured", () => {
    const r = resolveRunMode(
      config({
        providers: [{ ...CLOUD }],
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "openrouter",
        runMode: { mode: "fusion" },
      }),
    );
    expect(r.effective).toBe("cloud");
    expect(r.localProviderId).toBeNull();
    expect(r.degraded).toEqual({ reason: "no-local-provider", requested: "fusion" });
  });

  it("warns but still runs fusion when the tool transport is pinned", () => {
    const r = resolveRunMode(
      config({
        activeTextProvider: "openrouter",
        toolTransport: "grammar",
        runMode: { mode: "fusion" },
      }),
    );
    expect(r.effective).toBe("fusion");
    expect(r.degraded).toEqual({
      reason: "tool-transport-pinned",
      requested: "fusion",
    });
  });

  it("assumes local when the active provider id resolves to nothing", () => {
    // A broken file must never silently start spending cloud tokens.
    const r = resolveRunMode(config({ activeTextProvider: "ghost" }));
    expect(r.effective).toBe("local");
  });

  it("never returns an empty primaryProviderId", () => {
    const r = resolveRunMode(config({ providers: [], activeTextProvider: "ghost" }));
    expect(r.primaryProviderId).toBe("ghost");
  });
});
