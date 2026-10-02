import { describe, expect, it } from "vitest";

import type { LlmProvider, ProviderCapabilities } from "../llm/index.js";
import {
  providerOffersVision,
  resolveVisionProvider,
  visionRouteAvailable,
  type VisionProviderLookup,
} from "./vision-route.js";

function provider(
  id: string,
  vision: Pick<ProviderCapabilities, "vision" | "visionSource">,
): LlmProvider {
  return { id, name: id, capabilities: { ...vision } } as LlmProvider;
}

const CLOUD_TEXT = provider("aimlapi", { vision: false, visionSource: "absent" });
const CLOUD_VISION = provider("openrouter", {
  vision: true,
  visionSource: "modalities.vision",
});
const LOCAL_UNPROBED = provider("local-llama", {
  vision: false,
  visionSource: "absent",
});
const CLI = provider("claude-cli", {
  vision: false,
  visionSource: "config-disabled",
});

/** A registry whose active provider moves, like `ProviderRegistry.setActive`. */
function registry(
  providers: LlmProvider[],
  activeId: string,
): VisionProviderLookup & { setActive(id: string): void } {
  const byId = new Map(providers.map((p) => [p.id, p]));
  let active = activeId;
  return {
    get activeText() {
      return byId.get(active)!;
    },
    getProvider: (id) => byId.get(id),
    setActive(id) {
      active = id;
    },
  };
}

const isLocal = (id: string) => id === "local-llama";

describe("resolveVisionProvider", () => {
  it("follows the active provider across a switch", () => {
    const reg = registry([CLOUD_TEXT, LOCAL_UNPROBED], "aimlapi");
    expect(resolveVisionProvider(reg, undefined)).toBe(CLOUD_TEXT);
    reg.setActive("local-llama");
    expect(resolveVisionProvider(reg, undefined)).toBe(LOCAL_UNPROBED);
  });

  it("uses the pinned provider of a fusion worker step, not the active one", () => {
    const reg = registry([CLOUD_VISION, LOCAL_UNPROBED], "openrouter");
    expect(resolveVisionProvider(reg, "local-llama")).toBe(LOCAL_UNPROBED);
  });

  it("returns undefined for an unknown pin instead of the active provider", () => {
    const reg = registry([CLOUD_VISION], "openrouter");
    expect(resolveVisionProvider(reg, "gone")).toBeUndefined();
  });
});

describe("providerOffersVision", () => {
  it("offers a provider that declares vision", () => {
    expect(providerOffersVision(CLOUD_VISION, false)).toBe(true);
  });
  it("hides a non-local provider without vision", () => {
    expect(providerOffersVision(CLOUD_TEXT, false)).toBe(false);
    expect(providerOffersVision(CLI, false)).toBe(false);
  });
  it("keeps a local link whose profile is not probed yet", () => {
    expect(providerOffersVision(LOCAL_UNPROBED, true)).toBe(true);
  });
  it("hides a local link when vision is off in config", () => {
    const off = provider("local-llama", {
      vision: false,
      visionSource: "config-disabled",
    });
    expect(providerOffersVision(off, true)).toBe(false);
  });
});

describe("visionRouteAvailable", () => {
  it("follows a switch between a text-only and a vision route", () => {
    const reg = registry([CLOUD_TEXT, LOCAL_UNPROBED, CLOUD_VISION], "aimlapi");
    const deps = {
      registry: reg,
      isLlamaServer: isLocal,
      fusionWorkerProviderId: () => null,
    };
    expect(visionRouteAvailable(deps)).toBe(false);
    reg.setActive("local-llama");
    expect(visionRouteAvailable(deps)).toBe(true);
    reg.setActive("aimlapi");
    expect(visionRouteAvailable(deps)).toBe(false);
    reg.setActive("openrouter");
    expect(visionRouteAvailable(deps)).toBe(true);
  });

  it("counts the fusion worker leg when the orchestrator cannot see", () => {
    const reg = registry([CLOUD_TEXT, LOCAL_UNPROBED], "aimlapi");
    let worker: string | null = "local-llama";
    const deps = {
      registry: reg,
      isLlamaServer: isLocal,
      fusionWorkerProviderId: () => worker,
    };
    expect(visionRouteAvailable(deps)).toBe(true);
    worker = null; // left fusion
    expect(visionRouteAvailable(deps)).toBe(false);
  });

  it("does not count a worker leg the registry does not hold", () => {
    const reg = registry([CLOUD_TEXT], "aimlapi");
    expect(
      visionRouteAvailable({
        registry: reg,
        isLlamaServer: isLocal,
        fusionWorkerProviderId: () => "gone",
      }),
    ).toBe(false);
  });
});
