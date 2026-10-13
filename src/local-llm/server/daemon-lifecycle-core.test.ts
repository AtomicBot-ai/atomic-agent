import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/** Core's load, as the control contract answers it: a llama-server session on the requested port. */
const loadCoreSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../core/core-sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/core-sessions.js")>()),
  loadCoreSession: loadCoreSessionMock,
}));

import { resolveModelFilePath, resolvePidFilePath } from "../backend-paths.js";
import { getLocalModelDef } from "../catalog/models-catalog.js";
import { CORE_VERSION, coreVersionDir } from "../core/core-state.js";
import { readThroughputRecord, startDaemon } from "./daemon-lifecycle.js";

const MODEL = "qwen-3.5-4b";

/** Core installed with a backend whose llama-server is `script`, and the model on disk. */
function stage(dataDir: string, script: string[]): { runs: string } {
  const binDir = join(coreVersionDir(dataDir, CORE_VERSION), "data", "llamacpp", "backends", "b9001", "macos-arm64", "build", "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "llama-server");
  const runs = join(dataDir, "runs");
  writeFileSync(runs, "");
  writeFileSync(bin, ["#!/bin/sh", `echo "core $*" >> '${runs}'`, ...script].join("\n"), { mode: 0o755 });
  writeFileSync(
    join(coreVersionDir(dataDir, CORE_VERSION), "backend.json"),
    JSON.stringify({ coreVersion: CORE_VERSION, provider: "llamacpp", version: "b9001", backend: "macos-arm64", binary: bin, installedAt: "2026-10-12T00:00:00.000Z" }),
  );
  const model = getLocalModelDef(MODEL);
  const modelPath = resolveModelFilePath(dataDir, model.id, model.filename);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, "gguf", "utf-8");
  return { runs };
}

/** The session Core hands back: this process stands in for its llama-server, alive for the pid checks. */
function coreLoads(port: number): { loaded: () => boolean; args: () => readonly string[]; stop: () => void } {
  let loaded = false;
  let args: readonly string[] = [];
  loadCoreSessionMock.mockImplementation(async (_dataDir: string, opts: { args: readonly string[]; modelId: string; modelPath: string }) => {
    loaded = true;
    args = opts.args;
    return { pid: process.pid, port, model_id: opts.modelId, model_path: opts.modelPath, api_key: "core-session-key", is_embedding: false, provider: "llamacpp" };
  });
  return { loaded: () => loaded, args: () => args, stop: () => { loaded = false; } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  loadCoreSessionMock.mockReset();
});

describe("startDaemon under Atomic Core", () => {
  it("measures the session's speed with the session's key, then carries it over to the next start on Core's backend", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "daemon-core-speed-"));
    const port = 19_311;
    try {
      stage(dataDir, []);
      const core = coreLoads(port);
      const completions: Array<string | null> = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        // Nothing answers on the port until Core has loaded the model.
        if (!core.loaded()) throw new Error("ECONNREFUSED");
        const auth = new Headers(init?.headers).get("authorization");
        if (String(url).endsWith("/slots")) return new Response(JSON.stringify([{ id: 0, is_processing: false }]), { status: 200 });
        if (String(url).endsWith("/completion")) {
          completions.push(auth);
          return new Response(JSON.stringify({ timings: { predicted_n: 64, predicted_per_second: 18.5 } }), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }));
      const first = await startDaemon({ engine: "atomic-core", dataDir, modelId: MODEL, port, device: "cpu" });
      expect(first.pid).toBe(process.pid);
      expect(first.tokensPerSecond).toBe(18.5);
      expect(completions).toEqual(["Bearer core-session-key"]);
      const record = readThroughputRecord(dataDir, process.pid);
      expect(record?.tokensPerSecond).toBe(18.5);
      expect(record?.measuredOn).toContain(`Atomic Core ${CORE_VERSION} · b9001`);

      // The model stopped (its pid file gone) and started again on the same backend.
      unlinkSync(resolvePidFilePath(dataDir));
      core.stop();
      const second = await startDaemon({ engine: "atomic-core", dataDir, modelId: MODEL, port, device: "cpu" });
      expect(second.tokensPerSecond).toBe(18.5);
      expect(completions).toHaveLength(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("leaves the speed unknown when asked not to probe", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "daemon-core-noprobe-"));
    const port = 19_312;
    try {
      stage(dataDir, []);
      const core = coreLoads(port);
      const fetchMock = vi.fn(async (_url: string) => {
        if (!core.loaded()) throw new Error("ECONNREFUSED");
        return new Response("{}", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = await startDaemon({ engine: "atomic-core", dataDir, modelId: MODEL, port, device: "cpu", throughputProbe: false });
      expect(result.tokensPerSecond).toBeNull();
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/completion"))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "picks the device and fits the context from Core's own llama-server, asked once",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "daemon-core-device-"));
      const port = 19_313;
      try {
        const { runs } = stage(dataDir, ['echo "Available devices:"', 'echo "  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 23000 MiB free)"']);
        const core = coreLoads(port);
        vi.stubGlobal("fetch", vi.fn(async () => {
          if (!core.loaded()) throw new Error("ECONNREFUSED");
          return new Response("{}", { status: 200 });
        }));
        await startDaemon({ engine: "atomic-core", dataDir, modelId: MODEL, port, device: "auto", throughputProbe: false });
        const args = core.args();
        // The pick and the context fit read the same table: one run of Core's binary.
        expect(args[args.indexOf("--device") + 1]).toBe("CUDA0");
        expect(readFileSync(runs, "utf-8").split("\n").filter(Boolean)).toEqual(["core --list-devices"]);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
});
