import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { resolveLogFilePath, resolveModelFilePath, resolveServerBinPath } from "../backend-paths.js";
import { encodeSyntheticGguf, gemma4Pairs } from "../catalog/gguf-metadata.fixtures.js";
import { getLocalModelDef } from "../catalog/models-catalog.js";
import { startDaemon, type DaemonStartOptions } from "./daemon-lifecycle.js";
import { DRAFT_RETRY_NOTE } from "./draft-model.js";

/**
 * The wiring of ATO-2424 inside `startDaemon`: the draft's flags reach the
 * spawned argv, and a start the draft breaks is retried once without them.
 * The pure decisions are covered in draft-model(-launch).test.ts.
 */

/** The TurboQuant b10298 help layout for the flags the draft uses. */
const HELP = [
  "-md,   --spec-draft-model, --model-draft FNAME   draft model for speculative decoding",
  "--spec-type none,ngram-cache,draft-simple,draft-eagle3,draft-mtp",
  "-ngld, --gpu-layers-draft N",
  "-devd, --device-draft <dev1,dev2,..>",
].join("\n");

function fakeChild(pid: number): EventEmitter & { pid: number; unref: () => void; exitCode: null; signalCode: null } {
  return Object.assign(new EventEmitter(), { pid, unref: () => {}, exitCode: null, signalCode: null });
}

function argvOf(call: number): string[] {
  return spawnMock.mock.calls[call]![1] as string[];
}

describe("startDaemon with a draft model (ATO-2424)", () => {
  let dataDir: string;
  let draftPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-daemon-draft-"));
    const binPath = resolveServerBinPath(dataDir, "llama-server");
    mkdirSync(dirname(binPath), { recursive: true });
    writeFileSync(binPath, "#!/bin/sh\n", "utf-8");
    const model = getLocalModelDef("gemma-4-31b");
    const modelPath = resolveModelFilePath(dataDir, model.id, model.filename);
    mkdirSync(dirname(modelPath), { recursive: true });
    writeFileSync(modelPath, encodeSyntheticGguf(gemma4Pairs()));
    draftPath = join(dataDir, "draft.gguf");
    writeFileSync(draftPath, Buffer.alloc(1024));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "--help") return HELP;
      throw new Error(`unexpected execFileSync ${args.join(" ")}`);
    });
    // The fake pids are not ours: never signal a real process.
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Healthy from the `healthyFrom`-th spawn on; nothing listens before the first. */
  function serverHealthyFrom(healthyFrom: number): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const spawned = spawnMock.mock.calls.length;
        if (spawned < healthyFrom) throw new Error("ECONNREFUSED");
        const at = String(url);
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
        if (at.endsWith("/health")) return json({ status: "ok" });
        if (at.endsWith("/v1/models")) return json({ data: [{ id: "gemma-4-31b" }] });
        if (at.endsWith("/slots")) return json([{ id: 0, is_processing: false }]);
        return json({ timings: { predicted_n: 64, predicted_per_second: 5 } });
      }),
    );
  }

  const opts = (): DaemonStartOptions => ({
    dataDir,
    modelId: "gemma-4-31b",
    port: 19131,
    device: "Metal0",
    listDevices: async () => [],
    contextSize: 8192,
    draftModel: draftPath,
    throughputProbe: false,
    healthTimeoutMs: 300,
  });

  it("puts --model-draft and --spec-type draft-simple in the spawned argv", async () => {
    spawnMock.mockReturnValue(fakeChild(6101));
    serverHealthyFrom(1);
    const result = await startDaemon(opts());
    const argv = argvOf(0);
    const at = argv.indexOf("--model-draft");
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe(draftPath);
    expect(argv[argv.indexOf("--spec-type") + 1]).toBe("draft-simple");
    expect(argv).toContain("--gpu-layers-draft");
    expect(argv[argv.indexOf("--device-draft") + 1]).toBe("Metal0");
    expect(argv).not.toContain("--ctx-size-draft");
    expect(result.draftModel).toBe(draftPath);
    expect(readFileSync(resolveLogFilePath(dataDir), "utf-8")).toContain(`[atomic-agent] launch: draft: on (${draftPath}, `);
  });

  it("with draftModel off spawns no draft flag and never runs --help", async () => {
    spawnMock.mockReturnValue(fakeChild(6103));
    serverHealthyFrom(1);
    const result = await startDaemon({ ...opts(), draftModel: "off" });
    expect(argvOf(0).filter((a) => /^--(model-draft|spec-type|gpu-layers-draft|device-draft|ctx-size-draft)$/.test(a))).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(result.draftModel).toBeUndefined();
  });

  it("retries once without the draft when the start with it fails", async () => {
    spawnMock.mockReturnValueOnce(fakeChild(6101)).mockReturnValueOnce(fakeChild(6102));
    // The first server (with the draft) never answers; the second does.
    serverHealthyFrom(2);
    const result = await startDaemon(opts());
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(argvOf(0)).toContain("--model-draft");
    expect(argvOf(1)).not.toContain("--model-draft");
    expect(argvOf(1)).not.toContain("--spec-type");
    expect(result.pid).toBe(6102);
    expect(result.draftModel).toBeUndefined();
    expect(readFileSync(resolveLogFilePath(dataDir), "utf-8")).toContain(DRAFT_RETRY_NOTE);
  });
});
