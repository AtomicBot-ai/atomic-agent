import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../config/index.js";
import { createLocalFirstWindowResolver } from "./local-first-window.js";

function config(mode: "managed" | "external", contextSize = 0) {
  return {
    localModels: { mode, managed: { contextSize } },
    paths: { localModelsDataDir: "/data/models" },
  } as unknown as Pick<AtomicAgentConfig, "localModels" | "paths">;
}

describe("createLocalFirstWindowResolver (ATO-2537)", () => {
  it("uses the live profile's window first, then the catalogue's", () => {
    const launch = vi.fn(() => 16_384);
    const live = createLocalFirstWindowResolver({
      liveWindow: () => 65_536,
      catalogWindow: () => 32_768,
      readConfig: () => config("managed"),
      launchContextSize: launch,
    });
    expect(live("local-llama")).toBe(65_536);
    const catalogued = createLocalFirstWindowResolver({
      liveWindow: () => undefined,
      catalogWindow: () => 32_768,
      readConfig: () => config("managed"),
      launchContextSize: launch,
    });
    expect(catalogued("local-llama")).toBe(32_768);
    expect(launch).not.toHaveBeenCalled();
  });

  it("right after a restart reads the running managed model's launch window", () => {
    const launch = vi.fn(() => 16_384);
    const resolve = createLocalFirstWindowResolver({
      liveWindow: () => undefined,
      catalogWindow: () => null,
      readConfig: () => config("managed", 8_192),
      launchContextSize: launch,
    });
    expect(resolve("local-llama")).toBe(16_384);
    expect(launch).toHaveBeenCalledWith("/data/models");
  });

  it("falls back to a fixed localModels.managed.contextSize when no model runs", () => {
    const resolve = createLocalFirstWindowResolver({
      liveWindow: () => null,
      catalogWindow: () => null,
      readConfig: () => config("managed", 8_192),
      launchContextSize: () => null,
    });
    expect(resolve("local-llama")).toBe(8_192);
  });

  it("is unknown (null) for an auto managed size with no model running, an external server, or another link", () => {
    const managedAuto = createLocalFirstWindowResolver({
      liveWindow: () => undefined,
      catalogWindow: () => null,
      readConfig: () => config("managed", 0),
      launchContextSize: () => { throw new Error("unreadable"); },
    });
    expect(managedAuto("local-llama")).toBeNull();
    const external = createLocalFirstWindowResolver({
      liveWindow: () => undefined,
      catalogWindow: () => null,
      readConfig: () => config("external", 8_192),
      launchContextSize: () => 16_384,
    });
    expect(external("local-llama")).toBeNull();
    expect(external("my-llama")).toBeNull();
  });
});
