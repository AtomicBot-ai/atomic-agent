import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AtomicAgentConfig } from "../config/index.js";
import {
  explainManagedEngineLiveness,
  type ManagedEngineLiveness,
  type ManagedEngineLivenessProbes,
} from "../local-llm/server/engine-liveness.js";
import { readOwnEngineState } from "./llama-own-engine-state.js";

type Cfg = Pick<AtomicAgentConfig, "localModels" | "paths">;

function config(mode: "managed" | "external", dataDir = "/data/local-models", port = 9931): Cfg {
  return {
    localModels: { mode, managed: { port } },
    paths: { localModelsDataDir: dataDir },
  } as unknown as Cfg;
}

function state(value: ManagedEngineLiveness): (dataDir: string) => ManagedEngineLiveness {
  return () => value;
}

describe("readOwnEngineState: is our model behind a refusing address (ATO-1732)", () => {
  const url = "http://127.0.0.1:9931/completion";

  it("reads gone for the managed chat port with no pid recorded", () => {
    expect(readOwnEngineState(url, config("managed"), state("no_pid"))).toBe("gone");
  });

  it("reads gone for the managed chat port with a dead pid", () => {
    expect(readOwnEngineState("http://localhost:9931/completion", config("managed"), state("dead"))).toBe("gone");
  });

  it("reads running while our recorded process is alive", () => {
    expect(readOwnEngineState(url, config("managed"), state("alive"))).toBe("running");
  });

  it("keeps unknown while the liveness reads unknown", () => {
    expect(readOwnEngineState(url, config("managed"), state("unknown"))).toBe("unknown");
  });

  it("reads the liveness of the configured data dir", () => {
    const asked: string[] = [];
    readOwnEngineState(url, config("managed"), (dir) => { asked.push(dir); return "alive"; });
    expect(asked).toEqual(["/data/local-models"]);
  });

  it("keeps unknown for an External server, which is the operator's to run", () => {
    expect(readOwnEngineState(url, config("external"), state("no_pid"))).toBe("unknown");
  });

  it("keeps unknown for another port or a remote host", () => {
    expect(readOwnEngineState("http://127.0.0.1:8080/completion", config("managed"), state("no_pid"))).toBe("unknown");
    expect(readOwnEngineState("http://192.168.1.5:9931/completion", config("managed"), state("no_pid"))).toBe("unknown");
  });

  it("keeps unknown when the liveness read throws", () => {
    const throws = (): ManagedEngineLiveness => { throw new Error("EACCES"); };
    expect(readOwnEngineState(url, config("managed"), throws)).toBe("unknown");
  });
});

/**
 * The real lock-aware reading with no pid file on disk: a Core load or a
 * model switch holds the engine lock before the record is written, and a
 * 401 then may come from our own starting server, not another program.
 */
describe("readOwnEngineState with no pid file on disk (ATO-1732)", () => {
  const url = "http://127.0.0.1:9931/completion";
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function emptyDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "own-engine-state-"));
    dirs.push(dir);
    return dir;
  }

  function liveness(probes: ManagedEngineLivenessProbes): (dataDir: string) => ManagedEngineLiveness {
    return (dataDir) => explainManagedEngineLiveness(dataDir, probes).state;
  }

  it("keeps unknown while the engine operation lock is held", () => {
    const cfg = config("managed", emptyDataDir());
    const held = liveness({ operationLock: () => "held", startPending: () => false });
    expect(readOwnEngineState(url, cfg, held)).toBe("unknown");
  });

  it("keeps unknown while a chat start is pending", () => {
    const cfg = config("managed", emptyDataDir());
    const pending = liveness({ operationLock: () => "free", startPending: () => true });
    expect(readOwnEngineState(url, cfg, pending)).toBe("unknown");
  });

  it("reads gone with no lock and nothing starting", () => {
    const cfg = config("managed", emptyDataDir());
    const idle = liveness({ operationLock: () => "free", startPending: () => false });
    expect(readOwnEngineState(url, cfg, idle)).toBe("gone");
  });
});
