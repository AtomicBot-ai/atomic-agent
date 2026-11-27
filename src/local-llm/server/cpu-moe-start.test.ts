import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execSync: vi.fn(),
  execFile: execFileMock,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, totalmem: () => 32 * 1024 ** 3 };
});

import { resolveLogFilePath, resolveModelFilePath, resolveServerBinPath } from "../backend-paths.js";
import { writeBackendVersion } from "../backend/backend-version.js";
import { encodeSyntheticGguf, qwen36_35bA3bPairs } from "../catalog/gguf-metadata.fixtures.js";
import { getLocalModelDef } from "../catalog/models-catalog.js";
import { CPU_MOE_AUTO_CONTEXT } from "./cpu-moe-context.js";
import { startDaemon, type DaemonStartOptions } from "./daemon-lifecycle.js";

/**
 * ATO-2455 seam: the MoE window refit on the default start path
 * (`startDaemon`, `cpuMoe: "auto"`), with the device table, the spawn
 * and the server mocked. Qwen 3.6 35B-A3B (22.4 GB) on an 8 GB card.
 */

const MODEL_ID = "qwen-3.6-35b-a3b";
const REFIT_NOTE = "fitted with experts in RAM (cpu-moe)";

/** Qwen 3.6 35B-A3B's published expert shape on top of its attention layout. */
function moePairs() {
  return {
    ...qwen36_35bA3bPairs(),
    "qwen35.expert_count": 256,
    "qwen35.expert_used_count": 8,
    "qwen35.expert_feed_forward_length": 512,
  };
}

function stage(dataDir: string): void {
  const binPath = resolveServerBinPath(dataDir, "llama-server");
  mkdirSync(dirname(binPath), { recursive: true });
  writeFileSync(binPath, "#!/bin/sh\n", "utf-8");
  writeBackendVersion(dataDir, {
    tag: "turboquant-6df272c",
    downloadedAt: "2026-10-01T21:39:24.093Z",
    asset: "llama-turboquant-macos-arm64.zip",
  });
  const model = getLocalModelDef(MODEL_ID);
  const modelPath = resolveModelFilePath(dataDir, model.id, model.filename);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, encodeSyntheticGguf(moePairs()));
}

function card8gb(): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      done: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => {
      done(null, {
        stdout: ["Available devices:", "  CUDA0: NVIDIA GeForce RTX 4060 (8188 MiB, 7800 MiB free)"].join("\n"),
        stderr: "",
      });
    },
  );
}

function fakeChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    unref: () => {},
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
}

/** Nothing answers on the port until the daemon is spawned. */
function healthyServer(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (spawnMock.mock.calls.length === 0) throw new Error("ECONNREFUSED");
      const at = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (at.endsWith("/health")) return json({ status: "ok" });
      if (at.endsWith("/v1/models")) return json({ data: [{ id: MODEL_ID }] });
      if (at.endsWith("/slots")) return json([{ id: 0, is_processing: false }]);
      return json({ timings: { predicted_n: 64, predicted_per_second: 20 } });
    }),
  );
}

function arg(flag: string): string | undefined {
  const args = spawnMock.mock.calls[0]![1] as string[];
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

async function startOn8gbCard(extra: Partial<DaemonStartOptions>): Promise<{ log: string }> {
  const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-cpu-moe-`);
  try {
    stage(dataDir);
    card8gb();
    healthyServer();
    spawnMock.mockReturnValue(fakeChild(7001));
    await startDaemon({
      dataDir,
      modelId: MODEL_ID,
      port: 19071,
      parallel: 1,
      throughputProbe: false,
      ...extra,
    });
    return { log: readFileSync(resolveLogFilePath(dataDir), "utf-8") };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("startDaemon: the MoE window refit (ATO-2455)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    spawnMock.mockReset();
    execFileMock.mockReset();
  });

  it("fits the auto window again with experts in RAM: 65,536 tokens and --n-cpu-moe", async () => {
    const { log } = await startOn8gbCard({ cpuMoe: "auto" });
    expect(arg("--ctx-size")).toBe(String(CPU_MOE_AUTO_CONTEXT));
    expect(Number(arg("--n-cpu-moe"))).toBeGreaterThan(0);
    expect(log).toContain(REFIT_NOTE);
  });

  it("keeps the first fit for a pinned layer count", async () => {
    const { log } = await startOn8gbCard({ cpuMoe: 16 });
    expect(arg("--ctx-size")).toBe("32768");
    expect(arg("--n-cpu-moe")).toBe("16");
    expect(log).not.toContain(REFIT_NOTE);
  });

  it("keeps a window the operator set", async () => {
    const { log } = await startOn8gbCard({ cpuMoe: "auto", contextSize: 32_768 });
    expect(arg("--ctx-size")).toBe("32768");
    expect(log).not.toContain(REFIT_NOTE);
  });
});
