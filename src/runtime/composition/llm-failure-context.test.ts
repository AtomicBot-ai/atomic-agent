import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { attachFailingLink } from "../../llm/fallback/index.js";
import { LlamaServerError, LocalEngineDownError, LocalPortTakenError, TransportError } from "../../llm/index.js";
import { describeLlmFailure, type LlmFailureContextDeps } from "./llm-failure-context.js";

/** Only the fields the description reads: the provider list and local-model mode. */
function config(opts: {
  mode?: "managed" | "external";
  engine?: "atomic-core" | "llama-server";
  llm?: { activeTextProvider: string; providers: Array<{ id: string; kind: string }> };
}): AtomicAgentConfig {
  return {
    llm: opts.llm ? { ...opts.llm, activeEmbeddingProvider: "local-llama-embed", toolTransport: "auto" } : undefined,
    localModels: { mode: opts.mode ?? "managed", url: "http://127.0.0.1:8080", managed: { engine: opts.engine ?? "atomic-core" } },
    paths: { localModelsDataDir: "/state/models" },
  } as unknown as AtomicAgentConfig;
}

function deps(cfg: AtomicAgentConfig, state: ReturnType<LlmFailureContextDeps["readDaemonPidState"]> = "dead") {
  return { readConfig: () => cfg, readDaemonPidState: vi.fn(() => state) };
}

const outage = { waitedMs: 30_000, attempts: 4 };

describe("describeLlmFailure", () => {
  it("a managed Core turn reports the engine, the outage and the probed process state", () => {
    const d = deps(config({}), "dead");
    expect(describeLlmFailure({ error: new Error("fetch failed"), outage }, d)).toEqual({
      providerId: "local-llama",
      localEngine: "atomic-core",
      outageWaitedMs: 30_000,
      outageAttempts: 4,
      daemonState: "dead",
    });
    expect(d.readDaemonPidState).toHaveBeenCalledWith("/state/models");
  });

  it("names the managed llama-server engine", () => {
    const context = describeLlmFailure({ error: new Error("x") }, deps(config({ engine: "llama-server" }), "no_pid"));
    expect(context).toMatchObject({ localEngine: "llama-server", daemonState: "no_pid" });
  });

  it("external mode never probes a process", () => {
    const d = deps(config({ mode: "external" }));
    const context = describeLlmFailure({ error: new Error("x") }, d);
    expect(context).toEqual({ providerId: "local-llama", localEngine: "external" });
    expect(d.readDaemonPidState).not.toHaveBeenCalled();
  });

  it("a cloud turn carries the provider but no local engine", () => {
    const cfg = config({ llm: { activeTextProvider: "openrouter", providers: [{ id: "openrouter", kind: "openrouter" }] } });
    const d = deps(cfg);
    expect(describeLlmFailure({ error: new Error("x"), outage }, d)).toEqual({
      providerId: "openrouter",
      outageWaitedMs: 30_000,
      outageAttempts: 4,
    });
    expect(d.readDaemonPidState).not.toHaveBeenCalled();
  });

  it("prefers the link that threw over the configured active provider", () => {
    const cfg = config({
      llm: {
        activeTextProvider: "openrouter",
        providers: [{ id: "openrouter", kind: "openrouter" }, { id: "local-llama", kind: "llama-server" }],
      },
    });
    const error = new Error("fetch failed");
    attachFailingLink(error, "local-llama");
    expect(describeLlmFailure({ error }, deps(cfg, "alive"))).toMatchObject({
      providerId: "local-llama",
      localEngine: "atomic-core",
      daemonState: "alive",
    });
  });

  it("passes the failed request's URL and the managed ports on for the route tags (ATO-872)", () => {
    const cfg = config({ mode: "external" });
    (cfg.localModels as { managed: { port?: number } }).managed.port = 19091;
    const inner = Object.assign(new Error("llama-server returned http 404"), {
      url: "http://127.0.0.1:8080/v1/chat/completions",
    });
    const wrapper = new Error("llama-server returned http 404", { cause: inner });
    expect(describeLlmFailure({ error: wrapper }, deps(cfg))).toMatchObject({
      requestUrl: "http://127.0.0.1:8080/v1/chat/completions",
      managedPorts: [19091],
    });
  });

  it("leaves the URL out when the error carries none", () => {
    const context = describeLlmFailure({ error: new Error("fetch failed") }, deps(config({})));
    expect(context.requestUrl).toBeUndefined();
    expect(context.managedPorts).toBeUndefined();
  });

  it("a probe that throws reports unknown instead of losing the event", () => {
    const d = { readConfig: () => config({}), readDaemonPidState: () => { throw new Error("EACCES"); } };
    expect(describeLlmFailure({ error: new Error("x") }, d).daemonState).toBe("unknown");
  });

  describe("refused connections (ATO-421)", () => {
    /** A refused request the way undici reports it: the errno one level down. */
    function refusedError(): Error {
      const errno = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19091"), { code: "ECONNREFUSED" });
      return new TransportError("fetch failed", null, "http://127.0.0.1:19091/v1/chat/completions", { cause: errno });
    }

    it("marks the refusal and probes the managed engine's liveness", () => {
      const readEngineLiveness = vi.fn(() => "no_pid" as const);
      const d = { ...deps(config({}), "no_pid"), readEngineLiveness };
      expect(describeLlmFailure({ error: refusedError(), outage: { waitedMs: 8_000, attempts: 3 } }, d)).toMatchObject({
        localEngine: "atomic-core",
        connectionRefused: true,
        engineLiveness: "no_pid",
        outageWaitedMs: 8_000,
      });
      expect(readEngineLiveness).toHaveBeenCalledWith("/state/models");
    });

    it("sees the refusal under the turn's local_engine_down ending", () => {
      const d = { ...deps(config({}), "dead"), readEngineLiveness: vi.fn(() => "dead" as const) };
      const ended = new LocalEngineDownError("local-llama", refusedError());
      expect(describeLlmFailure({ error: ended }, d)).toMatchObject({ connectionRefused: true, engineLiveness: "dead" });
    });

    it("never probes an external server's process", () => {
      const readEngineLiveness = vi.fn(() => "alive" as const);
      const d = { ...deps(config({ mode: "external" })), readEngineLiveness };
      const context = describeLlmFailure({ error: refusedError() }, d);
      expect(context).toMatchObject({ localEngine: "external", connectionRefused: true });
      expect(context.engineLiveness).toBeUndefined();
      expect(readEngineLiveness).not.toHaveBeenCalled();
    });

    it("does not probe liveness when the connection was not refused", () => {
      const readEngineLiveness = vi.fn(() => "dead" as const);
      const d = { ...deps(config({})), readEngineLiveness };
      const context = describeLlmFailure({ error: new Error("fetch failed") }, d);
      expect(context.connectionRefused).toBeUndefined();
      expect(context.engineLiveness).toBeUndefined();
      expect(readEngineLiveness).not.toHaveBeenCalled();
    });

    it("carries why the engine was judged so, and the lock as read (ATO-1275)", () => {
      const explainEngineLiveness = vi.fn(() => ({ state: "unknown" as const, reason: "lock_held" as const, lock: "held" as const }));
      const d = { ...deps(config({}), "no_pid"), explainEngineLiveness };
      expect(describeLlmFailure({ error: refusedError() }, d)).toMatchObject({
        engineLiveness: "unknown",
        engineLivenessReason: "lock_held",
        engineLock: "held",
      });
      expect(explainEngineLiveness).toHaveBeenCalledWith("/state/models");
    });

    it("an explaining probe that throws reports unknown with no reason", () => {
      const d = { ...deps(config({})), explainEngineLiveness: () => { throw new Error("EACCES"); } };
      const context = describeLlmFailure({ error: refusedError() }, d);
      expect(context.engineLiveness).toBe("unknown");
      expect(context.engineLivenessReason).toBeUndefined();
    });

    it("a liveness probe that throws reports unknown", () => {
      const d = { ...deps(config({})), readEngineLiveness: () => { throw new Error("EACCES"); } };
      expect(describeLlmFailure({ error: refusedError() }, d).engineLiveness).toBe("unknown");
    });
  });

  describe("the managed engine's fault from its log (ATO-1279)", () => {
    it("reads it for a managed local-llama failure", () => {
      const readLocalFault = vi.fn(() => "out_of_memory" as const);
      const context = describeLlmFailure(
        { error: new Error("llama-server returned http 500") },
        { ...deps(config({}), "alive"), readLocalFault },
      );
      expect(context).toMatchObject({ providerId: "local-llama", daemonState: "alive", localFault: "out_of_memory" });
      expect(readLocalFault).toHaveBeenCalledWith("/state/models");
    });

    it("never reads it for an external server or a cloud link", () => {
      const readLocalFault = vi.fn(() => "none" as const);
      describeLlmFailure({ error: new Error("x") }, { ...deps(config({ mode: "external" })), readLocalFault });
      const cloud = config({ llm: { activeTextProvider: "openrouter", providers: [{ id: "openrouter", kind: "openrouter" }] } });
      describeLlmFailure({ error: new Error("x") }, { ...deps(cloud), readLocalFault });
      expect(readLocalFault).not.toHaveBeenCalled();
    });

    it("a log read that throws reports unknown", () => {
      const readLocalFault = vi.fn((): "none" => {
        throw new Error("EACCES");
      });
      const context = describeLlmFailure({ error: new Error("x") }, { ...deps(config({})), readLocalFault });
      expect(context.localFault).toBe("unknown");
    });
  });

  it("a config read that throws still returns the outage numbers", () => {
    const d = { readConfig: () => { throw new Error("no config"); }, readDaemonPidState: vi.fn() };
    expect(describeLlmFailure({ error: new Error("x"), outage }, d)).toEqual({ outageWaitedMs: 30_000, outageAttempts: 4 });
  });
});

describe("describeLlmFailure: a taken managed port (ATO-1277)", () => {
  it("marks a LocalPortTakenError as a port held by another program", () => {
    const url = "http://127.0.0.1:9931/completion";
    const err = new LocalPortTakenError("local-llama", url, new LlamaServerError("llama-server returned http 401", 401, url));
    const context = describeLlmFailure({ error: err }, deps(config({}), "no_pid"));
    expect(context).toMatchObject({ portHeldByOther: true, daemonState: "no_pid", requestUrl: url });
  });

  it("a plain 401 carries no such mark", () => {
    const url = "http://127.0.0.1:9931/completion";
    const context = describeLlmFailure({ error: new LlamaServerError("llama-server returned http 401", 401, url) }, deps(config({}), "alive"));
    expect(context.portHeldByOther).toBeUndefined();
  });
});

describe("describeLlmFailure: what the outage wait decided on (ATO-1432)", () => {
  it("carries the first and last verdict from the outage, as the turn read them", () => {
    const context = describeLlmFailure({
      error: new Error("fetch failed"),
      outage: {
        waitedMs: 300_000,
        attempts: 13,
        engineVerdicts: {
          first: { state: "unknown", reason: "lock_held" },
          last: { state: "unknown", reason: "lock_held" },
        },
      },
    }, deps(config({})));
    expect(context).toMatchObject({
      engineWaitVerdict: "unknown",
      engineWaitReason: "lock_held",
      engineWaitFirstVerdict: "unknown",
      engineWaitFirstReason: "lock_held",
    });
  });

  it("an outage with no verdict carries none", () => {
    const context = describeLlmFailure({ error: new Error("x"), outage }, deps(config({})));
    expect(context.engineWaitVerdict).toBeUndefined();
    expect(context.engineWaitReason).toBeUndefined();
  });
});

describe("describeLlmFailure: why the engine's process is gone (ATO-1435)", () => {
  function refusedError(): Error {
    const errno = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19091"), { code: "ECONNREFUSED" });
    return new TransportError("fetch failed", null, "http://127.0.0.1:19091/v1/chat/completions", { cause: errno });
  }
  const explain = (state: "dead" | "no_pid" | "alive" | "unknown") =>
    vi.fn(() => ({ state, reason: "pid_dead" as const, lock: "free" as const }));

  it.each(["dead", "no_pid"] as const)("reads it for a refusal with the engine %s", (state) => {
    const readEngineExitReason = vi.fn(() => "model_file_missing" as const);
    const d = { ...deps(config({})), explainEngineLiveness: explain(state), readEngineExitReason };
    expect(describeLlmFailure({ error: refusedError() }, d).engineExitReason).toBe("model_file_missing");
    expect(readEngineExitReason).toHaveBeenCalledWith("/state/models");
  });

  it.each(["alive", "unknown"] as const)("never reads it with the engine %s", (state) => {
    const readEngineExitReason = vi.fn(() => "out_of_memory" as const);
    const d = { ...deps(config({})), explainEngineLiveness: explain(state), readEngineExitReason };
    expect(describeLlmFailure({ error: refusedError() }, d).engineExitReason).toBeUndefined();
    expect(readEngineExitReason).not.toHaveBeenCalled();
  });

  it("never reads it for an external server or a failure that was not a refusal", () => {
    const readEngineExitReason = vi.fn(() => "out_of_memory" as const);
    const external = { ...deps(config({ mode: "external" })), explainEngineLiveness: explain("dead"), readEngineExitReason };
    expect(describeLlmFailure({ error: refusedError() }, external).engineExitReason).toBeUndefined();
    const managed = { ...deps(config({})), explainEngineLiveness: explain("dead"), readEngineExitReason };
    expect(describeLlmFailure({ error: new Error("fetch failed") }, managed).engineExitReason).toBeUndefined();
    expect(readEngineExitReason).not.toHaveBeenCalled();
  });

  it("a log read that throws reports unknown", () => {
    const d = { ...deps(config({})), explainEngineLiveness: explain("dead"), readEngineExitReason: () => { throw new Error("EACCES"); } };
    expect(describeLlmFailure({ error: refusedError() }, d).engineExitReason).toBe("unknown");
  });
});
