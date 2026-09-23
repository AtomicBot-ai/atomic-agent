import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/config-schema.js";
import { resetConfigCache } from "../config/index.js";
import { workerSlotFootprint } from "../local-llm/worker-slots.js";
import { createEmptySessionState } from "../session/session-state.js";
import { buildPrompt } from "./build-prompt.js";
import {
  resolveFusionMachineFacts,
  roundTokensPerSecond,
} from "./fusion-machine-facts.js";
import type { CapabilitiesSummary, ToolDescriptor } from "./stable-prefix.js";

type Providers = NonNullable<AtomicAgentConfig["llm"]>["providers"];

function config(over: {
  mode?: "managed" | "external";
  parallel?: number | "auto";
  contextSize?: number;
  device?: string;
  completionMaxTokens?: number;
  modelId?: string | null;
  workerModel?: string;
  workerProvider?: string;
  providers?: Providers;
}): AtomicAgentConfig {
  return {
    localModels: {
      mode: over.mode ?? "managed",
      ...(over.completionMaxTokens === undefined
        ? {}
        : { completionMaxTokens: over.completionMaxTokens }),
      managed: {
        parallel: over.parallel ?? 4,
        contextSize: over.contextSize ?? 0,
        ...(over.device === undefined ? {} : { device: over.device }),
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
      workerLeg: "local",
      workerSlots: 6,
      workerTokenBudget: workerSlotFootprint(),
      workerModel: "qwen3-4b",
      tokensPerSecond: null,
    });
  });

  it("states no slot count for an external server", () => {
    // Started out of band with flags this process never saw. A guess
    // here becomes a number the orchestrator plans its fan-out against.
    const facts = resolveFusionMachineFacts(
      config({ mode: "external", parallel: 6 }),
    );
    expect(facts.workerSlots).toBeNull();
    // What a worker needs is a fact about the worker, not the server.
    expect(facts.workerLeg).toBe("local");
    expect(facts.workerTokenBudget).toBe(workerSlotFootprint());
  });

  it("states the observed pool for an external server, and only then (F21)", () => {
    // The server's own `/props` answer is an observation, not a guess:
    // run 13's orchestrator planned with no slot count because the
    // daemon ran in external mode, next to a server that had five.
    const external = config({ mode: "external", parallel: 6 });
    expect(resolveFusionMachineFacts(external, { workerSlots: 5 }).workerSlots).toBe(5);
    expect(resolveFusionMachineFacts(external, { workerSlots: null }).workerSlots).toBeNull();
    expect(resolveFusionMachineFacts(external, {}).workerSlots).toBeNull();
    // The config's own number wins where it has one; a cloud leg has none.
    expect(
      resolveFusionMachineFacts(config({ parallel: 3 }), { workerSlots: 5 }).workerSlots,
    ).toBe(3);
    expect(
      resolveFusionMachineFacts(config({ parallel: "auto", contextSize: 0 }), {
        workerSlots: 5,
      }).workerSlots,
    ).toBe(5);
    const cloud = config({
      workerProvider: "openrouter",
      providers: [{ id: "openrouter", kind: "openrouter" }] as unknown as Providers,
    });
    expect(resolveFusionMachineFacts(cloud, { workerSlots: 5 }).workerSlots).toBeNull();
  });

  it("counts auto slots from a pinned context the way the daemon does", () => {
    // No cap in the file: the default 16K reply, a ~32K footprint, four
    // whole workers in 128K.
    expect(
      resolveFusionMachineFacts(config({ parallel: "auto", contextSize: 131_072 }))
        .workerSlots,
    ).toBe(4);
    expect(
      resolveFusionMachineFacts(config({ parallel: "auto", contextSize: 32_768 }))
        .workerSlots,
    ).toBe(1);
    expect(
      resolveFusionMachineFacts(
        config({ parallel: "auto", contextSize: 131_072, completionMaxTokens: 8_192 }),
      ).workerSlots,
    ).toBe(5);
    expect(
      resolveFusionMachineFacts(
        config({ parallel: "auto", contextSize: 131_072, completionMaxTokens: 32_768 }),
      ).workerSlots,
    ).toBe(2);
    expect(
      resolveFusionMachineFacts(
        config({ parallel: "auto", contextSize: 131_072, device: "cpu" }),
      ).workerSlots,
    ).toBe(1);
    // Auto-sized context: known only at daemon start, so unsaid here.
    expect(
      resolveFusionMachineFacts(config({ parallel: "auto", contextSize: 0 }))
        .workerSlots,
    ).toBeNull();
  });

  it("sizes each local worker's share of the context from the reply cap", () => {
    expect(
      resolveFusionMachineFacts(config({ completionMaxTokens: 16_384 }))
        .workerTokenBudget,
    ).toBe(workerSlotFootprint(16_384));
  });

  it("describes cloud workers without slots or a shared context", () => {
    const providers = [
      { id: "local-llama", kind: "llama-server", model: "entry-3b" },
      { id: "openrouter", kind: "openai-compatible", defaultChatModel: "gpt-x" },
    ] as unknown as Providers;
    expect(
      resolveFusionMachineFacts(
        config({ parallel: 6, workerProvider: "openrouter", providers }),
      ),
    ).toEqual({
      workerLeg: "cloud",
      workerSlots: null,
      workerTokenBudget: null,
      // Never the idle managed daemon's model.
      workerModel: "gpt-x",
      tokensPerSecond: null,
    });
  });

  it("states the measured decode speed for a local leg, rounded", () => {
    // Measured once at daemon start; whole tokens per second above 10,
    // one decimal below, so two readings of the same daemon cannot
    // jitter the prefix bytes.
    expect(
      resolveFusionMachineFacts(config({}), { tokensPerSecond: 6.43 })
        .tokensPerSecond,
    ).toBe(6.4);
    expect(
      resolveFusionMachineFacts(config({}), { tokensPerSecond: 24.6 })
        .tokensPerSecond,
    ).toBe(25);
    expect(roundTokensPerSecond(0.66)).toBe(0.7);
  });

  it("never states a speed nothing measured, nor one for a cloud leg", () => {
    expect(resolveFusionMachineFacts(config({})).tokensPerSecond).toBeNull();
    for (const bad of [0, -1, Number.NaN, null, undefined]) {
      expect(
        resolveFusionMachineFacts(config({}), { tokensPerSecond: bad })
          .tokensPerSecond,
      ).toBeNull();
    }
    const providers = [
      { id: "openrouter", kind: "openai-compatible", defaultChatModel: "gpt-x" },
    ] as unknown as Providers;
    expect(
      resolveFusionMachineFacts(
        config({ workerProvider: "openrouter", providers }),
        { tokensPerSecond: 40 },
      ).tokensPerSecond,
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

  it("puts the live config's capacity into the ### fusion block", () => {
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
    // `workerSlotFootprint(16_384)` = 32,384 at the default reply cap.
    expect(prompt.stablePrefix).toContain("~32K tokens");
    expect(prompt.stablePrefix).toContain("`maxWorkers` at most 5");
    expect(prompt.stablePrefix).not.toContain("tok/s");

    const measured = buildPrompt({
      session: createEmptySessionState({ id: "s", workingDir: "/work" }),
      toolDescriptors: [
        { name: "fusion.delegate", summary: "fan out", argsSchema: "{}" },
      ] satisfies ToolDescriptor[],
      capabilities: { platform: "linux" } as unknown as CapabilitiesSummary,
      skillCatalog: [],
      fusionTokensPerSecond: 6.43,
    });
    expect(measured.stablePrefix).toContain("~6.4 tok/s single stream");
  });

  it("threads the observed slot count into the block for an external server (F21)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-facts-live-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        localModels: { mode: "external", managed: { modelId: "qwen-3.5-4b" } },
      }),
    );
    process.env.ATOMIC_AGENT_STATE_DIR = dir;
    resetConfigCache();
    const input = {
      session: createEmptySessionState({ id: "s", workingDir: "/work" }),
      toolDescriptors: [
        { name: "fusion.delegate", summary: "fan out", argsSchema: "{}" },
      ] satisfies ToolDescriptor[],
      capabilities: { platform: "linux" } as unknown as CapabilitiesSummary,
      skillCatalog: [],
    };
    const before = buildPrompt(input);
    expect(before.stablePrefix).toContain("### fusion");
    expect(before.stablePrefix).not.toContain("request slot");
    const after = buildPrompt({ ...input, liveWorkerSlots: 5 });
    expect(after.stablePrefix).toContain("5 request slots");
    expect(after.stablePrefix).toContain("`maxWorkers` at most 5");
  });
});
