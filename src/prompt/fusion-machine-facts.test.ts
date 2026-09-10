import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/config-schema.js";
import { resetConfigCache } from "../config/index.js";
import { createEmptySessionState } from "../session/session-state.js";
import { buildPrompt } from "./build-prompt.js";
import { resolveFusionMachineFacts } from "./fusion-machine-facts.js";
import type { CapabilitiesSummary, ToolDescriptor } from "./stable-prefix.js";

type Providers = NonNullable<AtomicAgentConfig["llm"]>["providers"];

function config(over: {
  mode?: "managed" | "external";
  parallel?: number;
  modelId?: string | null;
  workerModel?: string;
  workerProvider?: string;
  providers?: Providers;
}): AtomicAgentConfig {
  return {
    localModels: {
      mode: over.mode ?? "managed",
      managed: {
        parallel: over.parallel ?? 4,
        modelId: over.modelId === undefined ? "qwen3-4b" : over.modelId,
      },
    },
    llm: {
      providers: over.providers ?? [],
      runMode: {
        mode: "fusion",
        fusion: {
          ...(over.workerModel === undefined
            ? {}
            : { workerModel: over.workerModel }),
          ...(over.workerProvider === undefined
            ? {}
            : { workerProvider: over.workerProvider }),
        },
      },
    },
  } as unknown as AtomicAgentConfig;
}

describe("resolveFusionMachineFacts", () => {
  it("reads the managed daemon's --parallel as the slot count", () => {
    // Managed mode is the one case where the runtime itself launches the
    // server, so `managed.parallel` IS the `--parallel` it will get.
    expect(resolveFusionMachineFacts(config({ parallel: 6 }))).toEqual({
      workerSlots: 6,
      workerModel: "qwen3-4b",
    });
  });

  it("states no slot count for an external server", () => {
    // Started out of band with flags this process never saw. A guess
    // here becomes a number the orchestrator plans its fan-out against.
    expect(
      resolveFusionMachineFacts(config({ mode: "external", parallel: 6 }))
        .workerSlots,
    ).toBeNull();
  });

  it("prefers the explicit worker-model pin over the managed model", () => {
    expect(
      resolveFusionMachineFacts(config({ workerModel: "pinned-7b" }))
        .workerModel,
    ).toBe("pinned-7b");
  });

  it("falls back to the worker provider entry's model, then to nothing", () => {
    const providers = [
      { id: "local-llama", kind: "llama-server", model: "entry-3b" },
      { id: "openrouter", kind: "openai-compatible", model: "big" },
    ] as unknown as Providers;
    // External mode: `managed.modelId` describes a daemon nothing is
    // routed to, so the llama-server provider entry is the honest source.
    expect(
      resolveFusionMachineFacts(config({ mode: "external", providers }))
        .workerModel,
    ).toBe("entry-3b");
    expect(
      resolveFusionMachineFacts(config({ mode: "external", modelId: null }))
        .workerModel,
    ).toBeNull();
  });

  it("ignores a blank model id rather than rendering an empty name", () => {
    expect(
      resolveFusionMachineFacts(config({ modelId: "   " })).workerModel,
    ).toBeNull();
  });
});

describe("the facts reaching the prompt", () => {
  const stateDir = process.env.ATOMIC_AGENT_STATE_DIR;
  afterEach(() => {
    if (stateDir === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  it("puts the live config's slot count into the ### fusion block", () => {
    // The wiring test: `buildPrompt` reads the facts from the config it
    // already holds, so nothing has to be threaded down through the
    // agent loop for the orchestrator to learn what it is choosing over.
    const dir = mkdtempSync(join(tmpdir(), "fusion-facts-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        localModels: {
          mode: "managed",
          managed: { modelId: "qwen-3.5-4b", parallel: 5 },
        },
      }),
    );
    process.env.ATOMIC_AGENT_STATE_DIR = dir;
    resetConfigCache();

    const prompt = buildPrompt({
      session: createEmptySessionState({ id: "s", workingDir: "/work" }),
      toolDescriptors: [
        { name: "fusion.delegate", summary: "fan out", argsSchema: "{}" },
      ] satisfies ToolDescriptor[],
      capabilities: { platform: "linux" } as unknown as CapabilitiesSummary,
      skillCatalog: [],
    });
    expect(prompt.stablePrefix).toContain("### fusion");
    expect(prompt.stablePrefix).toContain("5 request slots");
    expect(prompt.stablePrefix).toContain("`qwen-3.5-4b`");
  });
});
