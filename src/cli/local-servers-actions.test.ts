import { describe, expect, it } from "vitest";

import type { DetectedLocalServer } from "../llm/provider/presets/detect-local-servers.js";
import type { AdoptResult } from "../local-llm/external-servers/adopt-external-model.js";
import { localServersCommand } from "./local-servers-command.js";
import { parseAction, progressGate, pullProgressLine, runLocalServersAction, type ActionDeps } from "./local-servers-actions.js";

const OLLAMA: DetectedLocalServer = {
  kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434", presetId: "ollama",
  models: ["qwen3:8b", "llama3.2:3b"], loaded: ["qwen3:8b", "llama3.2:3b"],
};

function harness(extra: Partial<ActionDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const deps: ActionDeps = {
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    detect: async () => [OLLAMA],
    ollama: {
      load: async (m) => { calls.push(`load ${m}`); },
      unload: async (m) => { calls.push(`unload ${m}`); },
      pull: async (m, onProgress) => {
        calls.push(`pull ${m}`);
        for (const completed of [0, 5, 30, 31, 100]) onProgress({ status: "pulling abc", completed, total: 100 });
        onProgress({ status: "success", completed: null, total: null });
      },
      remove: async (m) => { calls.push(`rm ${m}`); },
    },
    lms: {
      load: async (k) => { calls.push(`lms load ${k}`); },
      unload: async (k) => { calls.push(`lms unload ${k}`); },
      get: async (k) => { calls.push(`lms get ${k}`); },
    },
    ...extra,
  };
  return { out, err, calls, deps };
}

describe("local-servers actions (ATO-2490)", () => {
  it("usage mistakes exit 2 before anything runs", () => {
    expect(parseAction(["load", "ollama"])).toEqual({ error: "load: name a model" });
    expect(parseAction(["start", "jan"])).toEqual({ error: "start: say which app, ollama or lmstudio" });
    expect(parseAction(["rm", "lmstudio", "qwen/qwen3-8b"])).toEqual({ error: "LM Studio models are deleted in LM Studio itself (My Models)" });
    expect(parseAction(["unload", "ollama"])).toEqual({ error: "unload: name a model, or --all" });
    expect(parseAction(["pull", "ollama", "x", "--use"])).toEqual({ error: "--copy and --use go with adopt only" });
    expect(parseAction(["adopt", "ollama", "x", "--use", "--json"])).toEqual({ error: "--use cannot be combined with --json" });
  });

  it("unload --all on Ollama sends keep_alive 0 for each loaded model", async () => {
    const h = harness();
    expect(await runLocalServersAction(["unload", "ollama", "--all"], h.deps)).toBe(0);
    expect(h.calls).toEqual(["unload qwen3:8b", "unload llama3.2:3b"]);
    expect(h.out.join("")).toContain("Unloaded from Ollama: qwen3:8b, llama3.2:3b.");
  });

  it("pull --json: thinned progress lines, then one result line", async () => {
    const h = harness();
    expect(await runLocalServersAction(["pull", "ollama", "qwen3:8b", "--json"], h.deps)).toBe(0);
    const lines = h.out.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.type === "progress").map((l) => l.completed)).toEqual([0, 5, 30, 31, 100, null]);
    expect(lines.at(-1)).toEqual({ type: "result", ok: true, action: "pull", kind: "ollama", model: "qwen3:8b" });
  });

  it("plain pull shows a line per 10 percent, not per chunk", () => {
    const gate = progressGate(10);
    const shown = [0, 3, 9, 10, 15, 21].filter((c) => gate({ status: "pulling", completed: c, total: 100 }));
    expect(shown).toEqual([0, 10, 21]);
    expect(pullProgressLine({ status: "pulling abc", completed: 2.1e9, total: 5e9 })).toBe("pulling abc: 2.1 GB of 5.0 GB (42%)");
  });

  it("LM Studio goes through lms; rm on Ollama deletes", async () => {
    const h = harness();
    await runLocalServersAction(["load", "lmstudio", "qwen/qwen3-8b"], h.deps);
    await runLocalServersAction(["unload", "lmstudio", "--all"], h.deps);
    await runLocalServersAction(["rm", "ollama", "llama3.2:3b"], h.deps);
    expect(h.calls).toEqual(["lms load qwen/qwen3-8b", "lms unload null", "rm llama3.2:3b"]);
  });

  it("a failure in --json is a result line with the sentence and the app's words", async () => {
    const boom = Object.assign(new Error("Ollama is not answering. Start it and try again."), { detail: "fetch failed" });
    const h = harness({ ollama: { ...harness().deps.ollama!, load: async () => { throw boom; } } });
    expect(await runLocalServersAction(["load", "ollama", "qwen3:8b", "--json"], h.deps)).toBe(1);
    expect(JSON.parse(h.out.join("").trim())).toEqual({
      type: "result", ok: false, action: "load", kind: "ollama",
      error: "Ollama is not answering. Start it and try again.", detail: "fetch failed",
    });
  });

  it("adopt saves the entry, then switches only with --use", async () => {
    const saved: string[] = [];
    const used: string[] = [];
    const result = {
      def: { id: "custom-local-ollama-qwen3-8b-1234abcd", name: "qwen3:8b (from Ollama)" },
      sourcePath: "/o/blobs/sha256-a", path: "/d/linked-models/ollama-qwen3-8b.gguf", how: "hardlink",
    } as unknown as AdoptResult;
    const h = harness({
      paths: () => ({ dataDir: "/d", managedModelsDir: "/d/models" }),
      adopt: async () => result,
      save: (def) => saved.push(def.id),
      useModel: async (id) => { used.push(id); return 0; },
    });
    expect(await runLocalServersAction(["adopt", "ollama", "qwen3:8b"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Run it with: atomic-agent models use custom-local-ollama-qwen3-8b-1234abcd");
    expect(used).toEqual([]);
    expect(await runLocalServersAction(["adopt", "ollama", "qwen3:8b", "--use"], h.deps)).toBe(0);
    expect(saved).toEqual([result.def.id, result.def.id]);
    expect(used).toEqual([result.def.id]);
  });

  it("the top-level command routes actions and still lists with no action", async () => {
    const out: string[] = [];
    const code = await localServersCommand(["rm", "ollama", "x", "--json"], {
      write: (t) => out.push(t),
      actions: { ollama: { ...harness().deps.ollama! } },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join("").trim())).toMatchObject({ ok: true, action: "rm" });
  });
});
