import { describe, expect, it, vi } from "vitest";
import type { ManagedEngineLiveness } from "../local-llm/index.js";
import { readLocalEngineState } from "./local-engine-state.js";

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
    expect(readLocalEngineState("local-llama", cfg("managed"), probe)).toBe(expected);
    expect(probe).toHaveBeenCalledWith("/state/models");
  });

  it("external mode is never judged: the operator's server may come back by itself", () => {
    const probe = vi.fn((): ManagedEngineLiveness => "no_pid");
    expect(readLocalEngineState("local-llama", cfg("external"), probe)).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([["openrouter"], ["my-llama"], [undefined]])("link %s is not the managed engine", (id) => {
    const probe = vi.fn((): ManagedEngineLiveness => "dead");
    expect(readLocalEngineState(id, cfg("managed"), probe)).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
  });

  it("a probe that throws reads unknown", () => {
    expect(readLocalEngineState("local-llama", cfg("managed"), () => { throw new Error("boom"); })).toBe("unknown");
  });
});
