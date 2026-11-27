import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { LlamaServerError, LocalPortTakenError, TransportError } from "../../llm/index.js";
import { describeLlmFailure } from "./llm-failure-context.js";

/**
 * ATO-2418: a 401 on the managed port with our engine gone
 * (`LocalPortTakenError`) is read like a refusal: the engine's liveness,
 * why its process is gone, and whether the managed port is the shipped one.
 */

function config(opts: { mode?: "managed" | "external"; port?: number } = {}): AtomicAgentConfig {
  return {
    localModels: {
      mode: opts.mode ?? "managed",
      url: "http://127.0.0.1:19091",
      managed: { engine: "atomic-core", ...(opts.port !== undefined ? { port: opts.port } : {}) },
    },
    paths: { localModelsDataDir: "/state/models" },
  } as unknown as AtomicAgentConfig;
}

const URL_401 = "http://127.0.0.1:19091/v1/chat/completions";

function portTaken(): Error {
  return new LocalPortTakenError("local-llama", URL_401, new LlamaServerError("llama-server returned http 401", 401, URL_401));
}

function refused(): Error {
  const errno = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19091"), { code: "ECONNREFUSED" });
  return new TransportError("fetch failed", null, URL_401, { cause: errno });
}

function deps(cfg: AtomicAgentConfig) {
  return {
    readConfig: () => cfg,
    readDaemonPidState: vi.fn(() => "no_pid" as const),
    explainEngineLiveness: vi.fn(() => ({ state: "no_pid" as const, reason: "no_pid_file" as const, lock: "free" as const })),
    readEngineExitReason: vi.fn(() => "port_in_use" as const),
  };
}

describe("describeLlmFailure: a taken managed port reads the engine (ATO-2418)", () => {
  it("carries the engine liveness, its lock and why the process is gone", () => {
    const d = deps(config({ port: 19091 }));
    const context = describeLlmFailure({ error: portTaken() }, d);
    expect(context).toMatchObject({
      portHeldByOther: true,
      engineLiveness: "no_pid",
      engineLivenessReason: "no_pid_file",
      engineLock: "free",
      engineExitReason: "port_in_use",
      managedPortCustom: false,
    });
    expect(context.connectionRefused).toBeUndefined();
    expect(d.explainEngineLiveness).toHaveBeenCalledWith("/state/models");
    expect(d.readEngineExitReason).toHaveBeenCalledWith("/state/models");
  });

  it("says the port is custom when it is not the shipped one", () => {
    expect(describeLlmFailure({ error: portTaken() }, deps(config({ port: 19092 }))).managedPortCustom).toBe(true);
  });

  it("a refusal carries the port source too", () => {
    expect(describeLlmFailure({ error: refused() }, deps(config({ port: 19091 }))).managedPortCustom).toBe(false);
  });

  it("a plain 401 with the engine alive reads nothing more", () => {
    const d = deps(config({ port: 19091 }));
    const context = describeLlmFailure({ error: new LlamaServerError("llama-server returned http 401", 401, URL_401) }, d);
    expect(context.engineLiveness).toBeUndefined();
    expect(context.managedPortCustom).toBeUndefined();
    expect(d.explainEngineLiveness).not.toHaveBeenCalled();
  });

  it("an external server is never read", () => {
    const d = deps(config({ mode: "external", port: 19091 }));
    const context = describeLlmFailure({ error: portTaken() }, d);
    expect(context.engineLiveness).toBeUndefined();
    expect(context.managedPortCustom).toBeUndefined();
    expect(d.explainEngineLiveness).not.toHaveBeenCalled();
  });
});
