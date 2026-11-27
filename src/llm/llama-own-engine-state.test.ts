import { describe, expect, it } from "vitest";
import type { AtomicAgentConfig } from "../config/index.js";
import type { ChatDaemonPidState } from "../local-llm/server/daemon-lifecycle.js";
import { readOwnEngineState } from "./llama-own-engine-state.js";

type Cfg = Pick<AtomicAgentConfig, "localModels" | "paths">;

function config(mode: "managed" | "external", port = 9931): Cfg {
  return {
    localModels: { mode, managed: { port } },
    paths: { localModelsDataDir: "/data/local-models" },
  } as unknown as Cfg;
}

function pid(state: ChatDaemonPidState): (dataDir: string) => ChatDaemonPidState {
  return () => state;
}

describe("readOwnEngineState: is our model behind a refusing address (ATO-1732)", () => {
  const url = "http://127.0.0.1:9931/completion";

  it("reads gone for the managed chat port with no pid recorded", () => {
    expect(readOwnEngineState(url, config("managed"), pid("no_pid"))).toBe("gone");
  });

  it("reads gone for the managed chat port with a dead pid", () => {
    expect(readOwnEngineState("http://localhost:9931/completion", config("managed"), pid("dead"))).toBe("gone");
  });

  it("reads running while our recorded process is alive", () => {
    expect(readOwnEngineState(url, config("managed"), pid("alive"))).toBe("running");
  });

  it("reads the pid records of the configured data dir", () => {
    const asked: string[] = [];
    readOwnEngineState(url, config("managed"), (dir) => { asked.push(dir); return "alive"; });
    expect(asked).toEqual(["/data/local-models"]);
  });

  it("keeps unknown for an External server, which is the operator's to run", () => {
    expect(readOwnEngineState(url, config("external"), pid("no_pid"))).toBe("unknown");
  });

  it("keeps unknown for another port or a remote host", () => {
    expect(readOwnEngineState("http://127.0.0.1:8080/completion", config("managed"), pid("no_pid"))).toBe("unknown");
    expect(readOwnEngineState("http://192.168.1.5:9931/completion", config("managed"), pid("no_pid"))).toBe("unknown");
  });

  it("keeps unknown when the pid records cannot be read", () => {
    const throws = (): ChatDaemonPidState => { throw new Error("EACCES"); };
    expect(readOwnEngineState(url, config("managed"), throws)).toBe("unknown");
  });
});
