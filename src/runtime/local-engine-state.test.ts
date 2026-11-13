import { describe, expect, it, vi } from "vitest";
import type { ManagedEngineLiveness } from "../local-llm/index.js";
import { explainLocalEngineState, readLocalEngineState } from "./local-engine-state.js";

const cfg = (mode: "managed" | "external") =>
  ({
    localModels: { mode },
    paths: { localModelsDataDir: "/state/models" },
  }) as never;

describe("readLocalEngineState (ATO-772)", () => {
  it.each<[ManagedEngineLiveness, string]>([
    ["dead", "dead"],
    ["no_pid", "dead"],
    ["alive", "alive"],
    ["unknown", "unknown"],
  ])("managed local-llama with the process %s reads %s", (liveness, expected) => {
    const probe = vi.fn(() => liveness);
    expect(readLocalEngineState("local-llama", cfg("managed"), "local-llama", probe)).toBe(expected);
    expect(probe).toHaveBeenCalledWith("/state/models");
  });

  it("external mode is never judged: the operator's server may come back by itself", () => {
    const probe = vi.fn((): ManagedEngineLiveness => "no_pid");
    expect(readLocalEngineState("local-llama", cfg("external"), "local-llama", probe)).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([["openrouter"], ["my-llama"], [undefined]])("link %s is not the managed engine", (id) => {
    const probe = vi.fn((): ManagedEngineLiveness => "dead");
    expect(readLocalEngineState(id, cfg("managed"), "local-llama", probe)).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
  });

  it("behind a cloud provider the local link is a fallback tail: a cloud outage keeps its wait", () => {
    const probe = vi.fn((): ManagedEngineLiveness => "no_pid");
    expect(readLocalEngineState("local-llama", cfg("managed"), "openrouter", probe)).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
  });

  it("a probe that throws reads unknown", () => {
    expect(readLocalEngineState("local-llama", cfg("managed"), "local-llama", () => { throw new Error("boom"); })).toBe("unknown");
  });

  it("the Atomic Chat link, as the active provider, reads atomic_chat_app without probing the managed engine (ATO-1278)", () => {
    const probe = vi.fn((): ManagedEngineLiveness => "alive");
    expect(readLocalEngineState("atomic-chat", cfg("managed"), "atomic-chat", probe)).toBe("atomic_chat_app");
    expect(readLocalEngineState("atomic-chat", cfg("external"), "atomic-chat", probe)).toBe("atomic_chat_app");
    expect(probe).not.toHaveBeenCalled();
  });

  it("the Atomic Chat link as a fallback behind another provider stays unknown", () => {
    expect(readLocalEngineState("atomic-chat", cfg("managed"), "openrouter")).toBe("unknown");
  });
});

describe("explainLocalEngineState (ATO-1432)", () => {
  const report = (state: "alive" | "dead" | "no_pid" | "unknown", reason: string) =>
    vi.fn(() => ({ state, reason, lock: "free" }) as never);

  it("passes the liveness branch through as the reason", () => {
    expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", report("unknown", "lock_held"), () => "running"))
      .toEqual({ state: "unknown", reason: "lock_held", modelProcess: "running" });
    expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", report("no_pid", "no_pid_file")))
      .toEqual({ state: "dead", reason: "no_pid_file" });
    expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", report("unknown", "pid_unreadable")))
      .toEqual({ state: "unknown", reason: "pid_unreadable" });
    expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", report("alive", "pid_alive")))
      .toEqual({ state: "alive", reason: "pid_alive" });
  });

  it("names why the engine was not looked at", () => {
    const probe = report("dead", "pid_dead");
    expect(explainLocalEngineState("openrouter", cfg("managed"), "local-llama", probe))
      .toEqual({ state: "unknown", reason: "not_local_link" });
    expect(explainLocalEngineState(undefined, cfg("managed"), "local-llama", probe))
      .toEqual({ state: "unknown", reason: "not_local_link" });
    expect(explainLocalEngineState("local-llama", cfg("managed"), "openrouter", probe))
      .toEqual({ state: "unknown", reason: "not_active_provider" });
    expect(explainLocalEngineState("local-llama", cfg("external"), "local-llama", probe))
      .toEqual({ state: "unknown", reason: "not_managed" });
    expect(explainLocalEngineState("atomic-chat", cfg("managed"), "openrouter", probe))
      .toEqual({ state: "unknown", reason: "not_active_provider" });
    expect(explainLocalEngineState("atomic-chat", cfg("managed"), "atomic-chat", probe))
      .toEqual({ state: "atomic_chat_app", reason: "atomic_chat_app" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("a probe that throws is unknown, never dead", () => {
    expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", () => { throw new Error("EACCES"); }))
      .toEqual({ state: "unknown", reason: "liveness_probe_failed" });
  });

  it("agrees with readLocalEngineState on the state", () => {
    for (const state of ["alive", "dead", "no_pid", "unknown"] as const) {
      expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", report(state, "pid_alive")).state)
        .toBe(readLocalEngineState("local-llama", cfg("managed"), "local-llama", () => state));
    }
  });
});

describe("explainLocalEngineState: a held lock with no model process (ATO-1434)", () => {
  const held = vi.fn(() => ({ state: "unknown", reason: "lock_held", lock: "held" }) as never);

  it("says whether a model process exists when the lock hides the pid", () => {
    const probe = vi.fn(() => "none" as const);
    expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", held, probe))
      .toEqual({ state: "unknown", reason: "lock_held", modelProcess: "none" });
    expect(probe).toHaveBeenCalledWith("/state/models");
  });

  it("a probe that throws is unknown, never none", () => {
    expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", held, () => { throw new Error("EACCES"); }))
      .toMatchObject({ modelProcess: "unknown" });
  });

  it("is not asked when the lock is not what made the reading unknown, nor for other links", () => {
    const probe = vi.fn(() => "none" as const);
    const unreadable = vi.fn(() => ({ state: "unknown", reason: "pid_unreadable", lock: "free" }) as never);
    expect(explainLocalEngineState("local-llama", cfg("managed"), "local-llama", unreadable, probe).modelProcess).toBeUndefined();
    expect(explainLocalEngineState("local-llama", cfg("external"), "local-llama", held, probe).modelProcess).toBeUndefined();
    expect(explainLocalEngineState("local-llama", cfg("managed"), "openrouter", held, probe).modelProcess).toBeUndefined();
    expect(explainLocalEngineState("my-llama", cfg("managed"), "local-llama", held, probe).modelProcess).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
