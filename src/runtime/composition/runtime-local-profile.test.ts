import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configuration from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import * as health from "../../llm/llama-server-health.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { GEMMA4_PROPS, NEMOTRON_BOLT_E4B_PROPS, NEMOTRON_PROPS, QWEN3_PROPS } from "../../llm/model-profile.fixtures.js";
import { StructuredLogger, type LogRecord } from "../../tracing/structured-logger.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import { connectRuntimeLocalProfile, managedLocalLlmHealthFailureHint, prepareRuntimeLocalProfile } from "./runtime-local-profile.js";

describe("runtime local profile phases", () => {
  let config: AtomicAgentConfig;
  let logger: StructuredLogger;
  let records: LogRecord[];
  beforeEach(() => {
    config = configuration.loadConfig();
    config.localModels.mode = "external";
    records = [];
    logger = new StructuredLogger({ level: "debug", sinks: [record => records.push(record)] });
    vi.spyOn(configuration, "getConfig").mockImplementation(() => config);
    vi.spyOn(health, "checkLlamaServer").mockResolvedValue({ reachable: true, status: 200, kind: "llama-server", error: null, latencyMs: 3 });
    vi.spyOn(LlamaServerClient.prototype, "fetchProps").mockResolvedValue(QWEN3_PROPS);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function cloud(): void {
    config.llm = { ...resolveLlmConfig(config), activeTextProvider: "cloud", providers: [{ id: "cloud", kind: "openai-compatible", baseUrl: "http://cloud.invalid", model: "cloud-model" }] };
  }

  it("runs local health before props and allocates the discovered slot count", async () => {
    const events: string[] = [];
    vi.mocked(health.checkLlamaServer).mockImplementation(async () => {
      events.push("health");
      return { reachable: true, status: 200, kind: "llama-server", error: null, latencyMs: 3 };
    });
    vi.mocked(LlamaServerClient.prototype.fetchProps).mockImplementation(async () => {
      events.push("props"); return { ...QWEN3_PROPS, model_alias: "qwen-live", total_slots: 4 };
    });
    const local = await prepareRuntimeLocalProfile(config, {}, logger);
    expect(events).toEqual(["health", "props"]);
    expect(local.profile.id).toBe("qwen-think");
    expect(local.modelAlias).toBe("qwen-live");
    expect(local.slotManager.getSlotCount()).toBe(4);
    expect(health.checkLlamaServer).toHaveBeenCalledWith({ retries: 0 });
  });

  it("cloud boot skips both probes and deferred notices even with props overrides", async () => {
    cloud();
    const local = await prepareRuntimeLocalProfile(config, { overrides: { deferLlamaHealthCheck: true, llamaProps: QWEN3_PROPS } }, logger);
    expect(local.profile).toBe(PLAIN_INSTRUCT_PROFILE);
    expect(local.modelAlias).toBeNull();
    expect(local.slotManager.getSlotCount()).toBe(1);
    expect(health.checkLlamaServer).not.toHaveBeenCalled();
    expect(LlamaServerClient.prototype.fetchProps).not.toHaveBeenCalled();
    expect(records.some(record => record.message.includes("health check deferred"))).toBe(false);
  });

  it("managed health failure logs the existing hint while props still resolves", async () => {
    config.localModels.mode = "managed";
    vi.mocked(health.checkLlamaServer).mockResolvedValue({ reachable: false, status: null, kind: "unknown", error: "offline", latencyMs: 0 });
    const local = await prepareRuntimeLocalProfile(config, {}, logger);
    expect(local.profile.id).toBe("qwen-think");
    expect(records.map(record => record.message)).toContain(managedLocalLlmHealthFailureHint(config.localModels.managed.port));
  });

  it("profile probe failure is a plain one-slot fallback with the original warning", async () => {
    vi.mocked(LlamaServerClient.prototype.fetchProps).mockRejectedValue(new Error("props unavailable"));
    const local = await prepareRuntimeLocalProfile(config, {}, logger);
    expect(local.profile).toBe(PLAIN_INSTRUCT_PROFILE);
    expect(local.slotManager.getSlotCount()).toBe(1);
    expect(records.find(record => record.message === "model profile probe failed; using plain fallback")?.context)
      .toEqual({ error: "props unavailable", url: config.localModels.url });
  });

  it("explicit props preserve alias verbatim, static profile and no manager", async () => {
    const options = { overrides: { skipLlamaHealthCheck: true, llamaProps: { ...QWEN3_PROPS, model_alias: "  alias  ", total_slots: 2 } } };
    const local = await prepareRuntimeLocalProfile(config, options, logger);
    const connected = await connectRuntimeLocalProfile(config, options, logger, local);
    expect(local.modelAlias).toBe("  alias  ");
    expect(connected.getLiveModelId()).toBe("  alias  ");
    expect(connected.getLiveProfile()).toBe(local.profile);
    expect(connected.profileManager).toBeUndefined();
    expect(health.checkLlamaServer).not.toHaveBeenCalled();
    expect(LlamaServerClient.prototype.fetchProps).not.toHaveBeenCalled();
  });

  it("deferred health retains a manager and refreshes profile, grammar and the same slots lazily", async () => {
    cloud();
    const options = { overrides: { deferLlamaHealthCheck: true } };
    const local = await prepareRuntimeLocalProfile(config, options, logger);
    const connected = await connectRuntimeLocalProfile(config, options, logger, local);
    expect(connected.profileManager).toBeDefined();
    expect(LlamaServerClient.prototype.fetchProps).not.toHaveBeenCalled();
    const originalGrammar = connected.initialGrammar;
    vi.mocked(LlamaServerClient.prototype.fetchProps).mockResolvedValue({ ...QWEN3_PROPS, model_alias: "qwen-warm", total_slots: 3 });
    const results = await Promise.all([connected.localBackend.ensureProbed(), connected.localBackend.ensureProbed()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(LlamaServerClient.prototype.fetchProps).toHaveBeenCalledTimes(1);
    expect(records.filter(record => record.level === "warn")).toEqual([]);
    expect(connected.getLiveProfile().id).toBe("qwen-think");
    expect(connected.getLiveModelId()).toBe("qwen-warm");
    expect(local.slotManager.getSlotCount()).toBe(3);
    expect(connected.profileManager?.getGrammar()).not.toBe(originalGrammar);
    expect(connected.initialGrammar).toBe(originalGrammar);
    expect(await connected.localBackend.ensureProbed()).toBe(false);
  });

  it("deferred health closure observes replacement of the original options.overrides", async () => {
    cloud();
    const options: Pick<CreateAgentRuntimeOptions, "overrides"> = { overrides: { deferLlamaHealthCheck: true } };
    const local = await prepareRuntimeLocalProfile(config, options, logger);
    options.overrides = {};
    await local.runBootHealthProbe();
    expect(health.checkLlamaServer).toHaveBeenCalledTimes(1);
  });

  it("deferred restore swallows a diagnostic health failure without probing props", async () => {
    cloud();
    const local = await prepareRuntimeLocalProfile(config, {}, logger);
    const connected = await connectRuntimeLocalProfile(config, {}, logger, local);
    vi.mocked(health.checkLlamaServer).mockRejectedValue(new Error("diagnostic failed"));
    expect(await connected.localBackend.ensureProbed()).toBe(true);
    expect(LlamaServerClient.prototype.fetchProps).not.toHaveBeenCalled();
    expect(records.find(record => record.message === "local llama backend restore failed; continuing")?.context)
      .toEqual({ error: "diagnostic failed" });
    expect(await connected.localBackend.ensureProbed()).toBe(false);
  });

  it("deferred gate tests the current route rather than its cloud boot snapshot", async () => {
    cloud();
    const local = await prepareRuntimeLocalProfile(config, {}, logger);
    const connected = await connectRuntimeLocalProfile(config, {}, logger, local);
    expect(connected.localBackend.isActive()).toBe(false);
    config = { ...config, llm: { ...resolveLlmConfig(config), activeTextProvider: "renamed-local", providers: [{ id: "renamed-local", kind: "llama-server" }] } };
    expect(connected.localBackend.isActive()).toBe(true);
  });

  // ATO-1115 / ATO-879. The managed daemon serves under the catalog (or
  // `custom-…`) id, an external server under the model path or any
  // `--alias`. Both reach `detectModelProfile` with the same template and
  // model path, so the same GGUF must land on the same profile.
  describe("same GGUF, managed id or external path alias", () => {
    const cases = [
      { name: "Qwen 3.5 4B", props: QWEN3_PROPS, managed: "qwen-3.5-4b", file: "/models/Qwen3.5-4B-Q4_K_M.gguf", expected: "qwen-think" },
      { name: "Gemma 4 E4B", props: GEMMA4_PROPS, managed: "gemma-4-e4b", file: "/models/gemma-4-E4B-it-Q4_K_M.gguf", expected: "gemma4-think" },
      { name: "Nemotron 3.5 30B", props: NEMOTRON_PROPS, managed: "nemotron-3.5-30b-a3b", file: "/models/NVIDIA-Nemotron-3.5-30B-A3B-Q4_K_M.gguf", expected: "qwen-think" },
      { name: "Nemotron 3.5 Bolt E4B", props: NEMOTRON_BOLT_E4B_PROPS, managed: "custom-nvidia-nvidia-nemotron-3.5-bolt-e4b-4gb-nvidia-nemotron-3.5-bolt-e4b-q4_k_m", file: "/models/NVIDIA-Nemotron-3.5-Bolt-E4B-Q4_K_M.gguf", expected: "gemma4-think" },
    ] as const;

    for (const c of cases) {
      it(`${c.name}: ${c.expected} either way`, async () => {
        const resolved: string[] = [];
        for (const [mode, alias] of [["managed", c.managed], ["external", c.file]] as const) {
          config.localModels.mode = mode;
          vi.mocked(LlamaServerClient.prototype.fetchProps).mockResolvedValue({ ...c.props, model_alias: alias, model_path: c.file });
          const local = await prepareRuntimeLocalProfile(config, {}, logger);
          resolved.push(local.profile.id);
        }
        expect(resolved).toEqual([c.expected, c.expected]);
      });
    }

    it("the lazy /props refresh resolves Bolt E4B the same as the boot probe", async () => {
      cloud();
      const options = { overrides: { deferLlamaHealthCheck: true } };
      const local = await prepareRuntimeLocalProfile(config, options, logger);
      const connected = await connectRuntimeLocalProfile(config, options, logger, local);
      expect(connected.getLiveProfile().id).toBe("plain-instruct");
      vi.mocked(LlamaServerClient.prototype.fetchProps).mockResolvedValue(NEMOTRON_BOLT_E4B_PROPS);
      expect(await connected.localBackend.ensureProbed()).toBe(true);
      expect(connected.getLiveProfile().id).toBe("gemma4-think");
    });
  });
});
