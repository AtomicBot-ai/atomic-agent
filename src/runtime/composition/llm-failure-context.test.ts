import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { attachFailingLink } from "../../llm/fallback/index.js";
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

  it("a config read that throws still returns the outage numbers", () => {
    const d = { readConfig: () => { throw new Error("no config"); }, readDaemonPidState: vi.fn() };
    expect(describeLlmFailure({ error: new Error("x"), outage }, d)).toEqual({ outageWaitedMs: 30_000, outageAttempts: 4 });
  });
});
