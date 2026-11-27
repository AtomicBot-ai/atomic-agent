import { describe, expect, it } from "vitest";

import type { DetectedLocalServer } from "../llm/provider/presets/detect-local-servers.js";
import { formatLocalServers, localServersCommand } from "./local-servers-command.js";

const OLLAMA: DetectedLocalServer = {
  kind: "ollama",
  label: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  presetId: "ollama",
  models: ["qwen3:8b", "llama3.2:3b"],
  loaded: ["qwen3:8b"],
};
const LLAMA_APP: DetectedLocalServer = {
  kind: "llama-app",
  label: "Llama app (llama.cpp)",
  baseUrl: "http://127.0.0.1:9931",
  presetId: null,
  models: ["gemma-3-4b"],
  loaded: [],
};

function run(args: string[], servers: DetectedLocalServer[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = localServersCommand(args, {
    detect: async () => servers,
    write: (t) => { out.push(t); },
    writeErr: (t) => { err.push(t); },
  });
  return code.then((c) => ({ code: c, out: out.join(""), err: err.join("") }));
}

describe("atomic-agent local-servers (ATO-2489)", () => {
  it("--json prints exactly what the probe found, for the desktop app", async () => {
    const res = await run(["--json"], [LLAMA_APP, OLLAMA]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual({ servers: [LLAMA_APP, OLLAMA] });
  });

  it("--json with nothing running is an empty list, not an error", async () => {
    const res = await run(["--json"], []);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual({ servers: [] });
  });

  it("the plain listing marks loaded models and names each address", () => {
    const text = formatLocalServers([OLLAMA]);
    expect(text).toContain("Ollama (2 models, 1 loaded) at http://127.0.0.1:11434");
    expect(text).toContain("  * qwen3:8b");
    expect(text).toContain("    llama3.2:3b");
    expect(text).toContain("* loaded in memory");
  });

  it("says so in words when nothing runs", () => {
    expect(formatLocalServers([])).toMatch(/^No model server is running on this computer/);
  });

  it("an unknown flag is a usage error and probes nothing", async () => {
    let probed = false;
    const err: string[] = [];
    const code = await localServersCommand(["--all"], {
      detect: async () => { probed = true; return []; },
      write: () => {},
      writeErr: (t) => { err.push(t); },
    });
    expect(code).toBe(2);
    expect(probed).toBe(false);
    expect(err.join("")).toContain("unknown option: --all");
  });
});
