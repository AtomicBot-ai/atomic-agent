import { describe, expect, it } from "vitest";

import type { DetectedLocalServer } from "../../llm/provider/presets/detect-local-servers.js";
import type { HostPaths } from "./external-server-paths.js";
import { OLLAMA_MISSING, planOllamaLaunch, startExternalServer } from "./start-external-server.js";

const OLLAMA: DetectedLocalServer = {
  kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434", presetId: "ollama", models: [], loaded: [],
};
const mac: HostPaths = { platform: "darwin", home: "/Users/me", env: {} };
const win: HostPaths = { platform: "win32", home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } };
const linux: HostPaths = { platform: "linux", home: "/home/me", env: { PATH: "/usr/bin" } };

describe("starting Ollama / LM Studio (ATO-2490)", () => {
  it("macOS opens the Ollama app, Windows its tray app, Linux runs ollama serve", () => {
    expect(planOllamaLaunch(mac, (p) => p === "/Applications/Ollama.app")).toEqual({ how: "app", command: "open", args: ["-a", "/Applications/Ollama.app"] });
    const tray = "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama app.exe";
    expect(planOllamaLaunch(win, (p) => p === tray)).toEqual({ how: "app", command: tray, args: [] });
    expect(planOllamaLaunch(linux, (p) => p === "/usr/local/bin/ollama")).toEqual({ how: "serve", command: "/usr/local/bin/ollama", args: ["serve"] });
    expect(planOllamaLaunch(mac, (p) => p === "/opt/homebrew/bin/ollama")).toEqual({ how: "serve", command: "/opt/homebrew/bin/ollama", args: ["serve"] });
    expect(planOllamaLaunch(linux, () => false)).toBeNull();
  });

  it("already running: nothing is spawned", async () => {
    const spawned: string[] = [];
    const r = await startExternalServer("ollama", { detect: async () => [OLLAMA], spawn: (c) => spawned.push(c) });
    expect(r).toEqual({ server: OLLAMA, started: false });
    expect(spawned).toEqual([]);
  });

  it("not running: spawns, then waits until the probe sees it", async () => {
    let calls = 0;
    const spawned: string[][] = [];
    const r = await startExternalServer("ollama", {
      host: linux,
      exists: (p) => p === "/usr/local/bin/ollama",
      spawn: (c, a) => spawned.push([c, ...a]),
      detect: async () => (++calls >= 3 ? [OLLAMA] : []),
      sleep: async () => {},
    });
    expect(spawned).toEqual([["/usr/local/bin/ollama", "serve"]]);
    expect(r.started).toBe(true);
  });

  it("not installed is the install sentence; never answering is its own sentence", async () => {
    await expect(startExternalServer("ollama", { host: linux, exists: () => false, detect: async () => [] })).rejects.toThrow(OLLAMA_MISSING);
    await expect(startExternalServer("ollama", {
      host: linux, exists: () => true, spawn: () => {}, detect: async () => [], waitMs: 0, sleep: async () => {},
    })).rejects.toThrow("was started but is not answering yet");
  });

  it("LM Studio starts through lms server start", async () => {
    const args: string[][] = [];
    let up = false;
    await startExternalServer("lmstudio", {
      detect: async () => (up ? [{ ...OLLAMA, kind: "lmstudio", presetId: "lmstudio" }] : []),
      lms: { bin: "lms", run: async (_b, a) => { args.push([...a]); up = true; return { code: 0, stdout: "", stderr: "" }; } },
      sleep: async () => {},
    });
    expect(args).toEqual([["server", "start"]]);
  });
});
