import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
  execFile: execFileMock,
}));

import {
  resolveEmbeddingPidFilePath,
  resolveLogFilePath,
  resolveModelFilePath,
  resolvePidFilePath,
  resolveServerBinPath,
  resolveThroughputFilePath,
} from "./backend-paths.js";
import {
  buildEmbeddingServerArgs,
  buildLlamaServerArgs,
  DaemonHealthError,
  ForeignDaemonError,
  probeThroughput,
  readLaunchRecord,
  readRunningPid,
  readThroughputRecord,
  startDaemon,
  THROUGHPUT_PROBE_TOKENS,
  writeLaunchRecord,
  writeThroughputRecord,
  stopDaemon,
  stopEmbeddingDaemon,
  type DaemonStartOptions,
  type EmbeddingDaemonStartOptions,
} from "./daemon-lifecycle.js";
import { getLocalModelDef } from "./models-catalog.js";
import { encodeSyntheticGguf, gemma4Pairs } from "./gguf-metadata.fixtures.js";

const baseOpts: DaemonStartOptions = {
  dataDir: "/tmp/data",
  modelId: "qwen-3.5-4b",
  port: 19091,
};

describe("buildLlamaServerArgs", () => {
  it("emits the canonical text-only flag set in stable order", () => {
    const args = buildLlamaServerArgs(
      baseOpts,
      "/tmp/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf",
      "qwen-3.5-4b",
    );
    expect(args).toEqual([
      "--no-webui",
      "--jinja",
      "-m",
      "/tmp/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf",
      "--port",
      "19091",
      "--host",
      "127.0.0.1",
      "-ngl",
      "-1",
      "--flash-attn",
      "auto",
      "--cache-type-k",
      "turbo3",
      "--cache-type-v",
      "turbo3",
      "--parallel",
      "2",
      "-kvu",
      "-a",
      "qwen-3.5-4b",
    ]);
    expect(args).not.toContain("--mmproj");
    expect(args).not.toContain("--chat-template-file");
    // No effective context passed ⇒ no --ctx-size (llama.cpp default).
    expect(args).not.toContain("--ctx-size");
  });

  it("threads localModels.managed.parallel into --parallel, default 2", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, parallel: 4 },
      "/tmp/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf",
      "qwen-3.5-4b",
    );
    const at = args.indexOf("--parallel");
    expect(at).toBeGreaterThan(0);
    expect(args[at + 1]).toBe("4");
    const defaults = buildLlamaServerArgs(
      baseOpts,
      "/tmp/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf",
      "qwen-3.5-4b",
    );
    expect(defaults[defaults.indexOf("--parallel") + 1]).toBe("2");
  });

  it("counts auto slots in whole worker footprints of the reply cap", () => {
    // `-kvu` makes --ctx-size one pool every slot draws from, so a slot
    // is only worth launching if a whole worker fits in the pool.
    const slotsFor = (
      opts: Partial<DaemonStartOptions>,
      contextSize: number,
    ): string | undefined => {
      const args = buildLlamaServerArgs(
        { ...baseOpts, parallel: "auto", ...opts },
        "/tmp/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf",
        "qwen-3.5-4b",
        contextSize,
      );
      return args[args.indexOf("--parallel") + 1];
    };
    expect(slotsFor({}, 32_768)).toBe("1");
    expect(slotsFor({ completionMaxTokens: 8_192 }, 65_536)).toBe("2");
    expect(slotsFor({ completionMaxTokens: 8_192 }, 131_072)).toBe("5");
    expect(slotsFor({ completionMaxTokens: 16_384 }, 131_072)).toBe("4");
  });

  it("appends --ctx-size when an effective context size is provided", () => {
    const args = buildLlamaServerArgs(
      baseOpts,
      "/tmp/data/models/qwen-3.5-4b/weights.gguf",
      "qwen-3.5-4b",
      16384,
    );
    const idx = args.indexOf("--ctx-size");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("16384");
  });

  it("does NOT append --ctx-size when the effective size is 0", () => {
    const args = buildLlamaServerArgs(
      baseOpts,
      "/tmp/data/models/qwen-3.5-4b/weights.gguf",
      "qwen-3.5-4b",
      0,
    );
    expect(args).not.toContain("--ctx-size");
  });

  it("appends --chat-template-file when chatTemplateFile is set", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, chatTemplateFile: "/tmp/templates/qwen.jinja" },
      "/tmp/data/models/qwen-3.5-4b/weights.gguf",
      "qwen-3.5-4b",
    );
    const idx = args.indexOf("--chat-template-file");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/templates/qwen.jinja");
  });

  it("appends --mmproj and vision-token / batch flags when mmprojFile is set", () => {
    const args = buildLlamaServerArgs(
      {
        ...baseOpts,
        mmprojFile: "/tmp/data/models/qwen-3.5-4b/mmproj-F16.gguf",
      },
      "/tmp/data/models/qwen-3.5-4b/weights.gguf",
      "qwen-3.5-4b",
    );
    const idx = args.indexOf("--mmproj");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/data/models/qwen-3.5-4b/mmproj-F16.gguf");
    // Vision-token + ubatch flags ride along whenever --mmproj is present.
    // Without these defaults, Gemma-4 / Qwen-VL hallucinate image content.
    expect(args).toContain("--image-min-tokens");
    expect(args).toContain("--image-max-tokens");
    expect(args).toContain("--ubatch-size");
    expect(args).toContain("--batch-size");
    expect(args[args.indexOf("--image-min-tokens") + 1]).toBe("560");
    expect(args[args.indexOf("--image-max-tokens") + 1]).toBe("560");
    expect(args[args.indexOf("--ubatch-size") + 1]).toBe("1024");
    expect(args[args.indexOf("--batch-size") + 1]).toBe("2048");
  });

  it("does NOT emit vision flags when mmprojFile is absent", () => {
    const args = buildLlamaServerArgs(
      baseOpts,
      "/tmp/data/models/qwen-3.5-4b/weights.gguf",
      "qwen-3.5-4b",
    );
    expect(args).not.toContain("--image-min-tokens");
    expect(args).not.toContain("--image-max-tokens");
    expect(args).not.toContain("--ubatch-size");
    expect(args).not.toContain("--batch-size");
  });

  it("appends --device when a concrete device id is set, keeping -ngl -1", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, device: "Vulkan0" },
      "/m.gguf",
      "alias",
    );
    const idx = args.indexOf("--device");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Vulkan0");
    expect(args[args.indexOf("-ngl") + 1]).toBe("-1");
  });

  it("forces -ngl 0 and emits no --device when device is 'cpu'", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, device: "cpu" },
      "/m.gguf",
      "alias",
    );
    expect(args[args.indexOf("-ngl") + 1]).toBe("0");
    expect(args).not.toContain("--device");
  });

  it("does NOT emit --device when device is undefined", () => {
    const args = buildLlamaServerArgs(baseOpts, "/m.gguf", "alias");
    expect(args).not.toContain("--device");
    expect(args[args.indexOf("-ngl") + 1]).toBe("-1");
  });

  it("appends --split-mode layer --tensor-split when tensorSplit is set", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, tensorSplit: [3, 1] },
      "/m.gguf",
      "alias",
    );
    const modeIdx = args.indexOf("--split-mode");
    expect(modeIdx).toBeGreaterThan(-1);
    expect(args[modeIdx + 1]).toBe("layer");
    const splitIdx = args.indexOf("--tensor-split");
    expect(splitIdx).toBeGreaterThan(-1);
    expect(args[splitIdx + 1]).toBe("3,1");
    // No pinned device: llama.cpp must keep every GPU visible to split.
    expect(args).not.toContain("--device");
    expect(args[args.indexOf("-ngl") + 1]).toBe("-1");
  });

  it("keeps --device alongside the split for an explicit device list", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, device: "Vulkan0,Vulkan1", tensorSplit: [0.6, 0.4] },
      "/m.gguf",
      "alias",
    );
    expect(args[args.indexOf("--device") + 1]).toBe("Vulkan0,Vulkan1");
    expect(args[args.indexOf("--tensor-split") + 1]).toBe("0.6,0.4");
  });

  it("does NOT emit split flags when device is 'cpu' (nothing to split)", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, device: "cpu", tensorSplit: [1, 1] },
      "/m.gguf",
      "alias",
    );
    expect(args).not.toContain("--split-mode");
    expect(args).not.toContain("--tensor-split");
    expect(args[args.indexOf("-ngl") + 1]).toBe("0");
  });

  it("does NOT emit split flags for an empty or absent tensorSplit", () => {
    for (const opts of [baseOpts, { ...baseOpts, tensorSplit: [] }]) {
      const args = buildLlamaServerArgs(opts, "/m.gguf", "alias");
      expect(args).not.toContain("--split-mode");
      expect(args).not.toContain("--tensor-split");
    }
  });

  it("emits both --chat-template-file and --mmproj together", () => {
    const args = buildLlamaServerArgs(
      {
        ...baseOpts,
        chatTemplateFile: "/tpl.jinja",
        mmprojFile: "/proj.gguf",
      },
      "/m.gguf",
      "alias",
    );
    expect(args).toContain("--chat-template-file");
    expect(args).toContain("/tpl.jinja");
    expect(args).toContain("--mmproj");
    expect(args).toContain("/proj.gguf");
  });
});

describe("buildEmbeddingServerArgs (memory-v2 phase 1B)", () => {
  it("emits --embeddings + --pooling + the model alias", () => {
    const opts: EmbeddingDaemonStartOptions = {
      dataDir: "/tmp/data",
      modelId: "nomic-embed-text-v1.5",
      port: 19092,
    };
    const args = buildEmbeddingServerArgs(
      opts,
      "/tmp/data/models/nomic-embed-text-v1.5/nomic-embed-text-v1.5.Q4_K_M.gguf",
    );
    expect(args).toEqual([
      "--no-webui",
      "-m",
      "/tmp/data/models/nomic-embed-text-v1.5/nomic-embed-text-v1.5.Q4_K_M.gguf",
      "--port",
      "19092",
      "--host",
      "127.0.0.1",
      "-ngl",
      "-1",
      "--embeddings",
      "--pooling",
      "mean",
      "--ctx-size",
      "2048",
      "-a",
      "nomic-embed-text-v1.5",
    ]);
    // Critically: NO chat-only flags. `--embeddings` excludes the
    // chat-template / flash-attn / cache-type / parallel knobs.
    expect(args).not.toContain("--jinja");
    expect(args).not.toContain("--flash-attn");
    expect(args).not.toContain("--mmproj");
    expect(args).not.toContain("--parallel");
  });

  it("threads the pooling kind from the catalog (bge -> cls)", () => {
    const args = buildEmbeddingServerArgs(
      {
        dataDir: "/tmp",
        modelId: "bge-small-en-v1.5",
        port: 19092,
      },
      "/tmp/models/bge-small-en-v1.5/bge-small-en-v1.5-q8_0.gguf",
    );
    const idx = args.indexOf("--pooling");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("cls");
  });

  it("appends --device for a concrete device id", () => {
    const args = buildEmbeddingServerArgs(
      {
        dataDir: "/tmp",
        modelId: "nomic-embed-text-v1.5",
        port: 19092,
        device: "Vulkan0",
      },
      "/tmp/m.gguf",
    );
    const idx = args.indexOf("--device");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Vulkan0");
  });

  it("forces -ngl 0 for device 'cpu'", () => {
    const args = buildEmbeddingServerArgs(
      {
        dataDir: "/tmp",
        modelId: "nomic-embed-text-v1.5",
        port: 19092,
        device: "cpu",
      },
      "/tmp/m.gguf",
    );
    expect(args[args.indexOf("-ngl") + 1]).toBe("0");
    expect(args).not.toContain("--device");
  });
});

describe("readRunningPid (cross-user ownership)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withTempDataDir(fn: (dataDir: string) => void): void {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-pid-`);
    try {
      fn(dataDir);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  it("treats EPERM (process owned by another user) as alive and keeps the pid file", () => {
    withTempDataDir((dataDir) => {
      const pidPath = resolvePidFilePath(dataDir);
      writeFileSync(pidPath, "4242", "utf-8");
      vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error(
          "operation not permitted",
        ) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });

      expect(readRunningPid(dataDir, "chat")).toBe(4242);
      expect(existsSync(pidPath)).toBe(true);
    });
  });

  it("treats ESRCH (no such process) as dead and removes the pid file", () => {
    withTempDataDir((dataDir) => {
      const pidPath = resolvePidFilePath(dataDir);
      writeFileSync(pidPath, "4242", "utf-8");
      vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      });

      expect(readRunningPid(dataDir, "chat")).toBeNull();
      expect(existsSync(pidPath)).toBe(false);
    });
  });

  it("applies the same EPERM handling to the embedding pid file", () => {
    withTempDataDir((dataDir) => {
      const pidPath = resolveEmbeddingPidFilePath(dataDir);
      writeFileSync(pidPath, "7777", "utf-8");
      vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error(
          "operation not permitted",
        ) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });

      expect(readRunningPid(dataDir, "embedding")).toBe(7777);
      expect(existsSync(pidPath)).toBe(true);
    });
  });
});

describe("stopDaemon / stopEmbeddingDaemon (cross-user ownership)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withTempDataDir(
    fn: (dataDir: string) => Promise<void>,
  ): Promise<void> {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-stop-`);
    try {
      await fn(dataDir);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  function mockKillEperm(): void {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
  }

  it("throws ForeignDaemonError and keeps the pid file for a foreign chat daemon", async () => {
    await withTempDataDir(async (dataDir) => {
      const pidPath = resolvePidFilePath(dataDir);
      writeFileSync(pidPath, "4242", "utf-8");
      mockKillEperm();

      await expect(stopDaemon(dataDir)).rejects.toBeInstanceOf(
        ForeignDaemonError,
      );
      expect(existsSync(pidPath)).toBe(true);
    });
  });

  it("removes the pid file for a dead chat daemon (ESRCH)", async () => {
    await withTempDataDir(async (dataDir) => {
      const pidPath = resolvePidFilePath(dataDir);
      writeFileSync(pidPath, "4242", "utf-8");
      vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      });

      await stopDaemon(dataDir);
      expect(existsSync(pidPath)).toBe(false);
    });
  });

  it("throws ForeignDaemonError and keeps the pid file for a foreign embedding daemon", async () => {
    await withTempDataDir(async (dataDir) => {
      const pidPath = resolveEmbeddingPidFilePath(dataDir);
      writeFileSync(pidPath, "7777", "utf-8");
      mockKillEperm();

      await expect(stopEmbeddingDaemon(dataDir)).rejects.toBeInstanceOf(
        ForeignDaemonError,
      );
      expect(existsSync(pidPath)).toBe(true);
    });
  });
});

describe("startDaemon health-wait failure", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    spawnMock.mockReset();
  });

  it("throws DaemonHealthError when the spawned server never becomes healthy", async () => {
    // The typed class is load-bearing: the Windows CPU-backend fallback
    // keys on `instanceof DaemonHealthError` to distinguish "the compute
    // backend cannot serve on this machine" from pre-spawn failures. A
    // revert to a bare `Error` would silently disable the fallback.
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-health-`);
    try {
      const binPath = resolveServerBinPath(dataDir, "llama-server");
      mkdirSync(dirname(binPath), { recursive: true });
      writeFileSync(binPath, "#!/bin/sh\n", "utf-8");
      const model = getLocalModelDef("qwen-3.5-4b");
      const modelPath = resolveModelFilePath(dataDir, model.id, model.filename);
      mkdirSync(dirname(modelPath), { recursive: true });
      writeFileSync(modelPath, "gguf", "utf-8");

      spawnMock.mockReturnValue({ pid: 4242, unref: () => {} });
      // Every health probe fails — the "server" crashed right after spawn.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      );

      vi.useFakeTimers();
      const started = startDaemon({
        dataDir,
        modelId: "qwen-3.5-4b",
        port: 19099,
        // Pinned device skips the --list-devices / VRAM probes so the
        // whole wait runs on the mocked clock.
        device: "cpu",
      });
      const rejects = expect(started).rejects.toBeInstanceOf(DaemonHealthError);
      await vi.advanceTimersByTimeAsync(31_000);
      await rejects;
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("probeThroughput (F16)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("posts one short greedy completion on no slot and reads the decode speed", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({
        content: "4\n5\n",
        timings: {
          predicted_n: 64,
          predicted_per_second: 6.43,
          prompt_per_second: 120.5,
        },
      });
    }) as unknown as typeof fetch;
    const sample = await probeThroughput({ port: 19091, fetchImpl });
    expect(sample).toEqual({
      tokensPerSecond: 6.43,
      predictedTokens: 64,
      promptTokensPerSecond: 120.5,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:19091/completion");
    expect(calls[0]!.body).toMatchObject({
      n_predict: THROUGHPUT_PROBE_TOKENS,
      temperature: 0,
      stream: false,
      // Neither pins nor pollutes a slot a session will be given.
      cache_prompt: false,
      id_slot: -1,
    });
  });

  it("answers null on a refusal, on missing timings, and on a transport failure", async () => {
    const refused = (async () => jsonResponse({ error: "loading" }, 503)) as unknown as typeof fetch;
    expect(await probeThroughput({ port: 1, fetchImpl: refused })).toBeNull();
    const noTimings = (async () => jsonResponse({ content: "x" })) as unknown as typeof fetch;
    expect(await probeThroughput({ port: 1, fetchImpl: noTimings })).toBeNull();
    const zero = (async () =>
      jsonResponse({ timings: { predicted_n: 0, predicted_per_second: 0 } })) as unknown as typeof fetch;
    expect(await probeThroughput({ port: 1, fetchImpl: zero })).toBeNull();
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeThroughput({ port: 1, fetchImpl: dead })).toBeNull();
  });

  it("round-trips a record through the data dir and refuses one from another pid", () => {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-throughput-`);
    try {
      expect(readThroughputRecord(dataDir, 100)).toBeNull();
      writeThroughputRecord(dataDir, {
        pid: 100,
        modelId: "gemma-4-31b",
        tokensPerSecond: 6.4,
        predictedTokens: 64,
        promptTokensPerSecond: null,
        measuredAt: 1_700_000_000_000,
      });
      expect(readThroughputRecord(dataDir, 100)).toEqual({
        pid: 100,
        modelId: "gemma-4-31b",
        tokensPerSecond: 6.4,
        predictedTokens: 64,
        promptTokensPerSecond: null,
        measuredAt: 1_700_000_000_000,
      });
      // A previous daemon's figure never describes the live one.
      expect(readThroughputRecord(dataDir, 101)).toBeNull();
      expect(readThroughputRecord(dataDir, null)).toBeNull();
      writeFileSync(resolveThroughputFilePath(dataDir), "{not json", "utf-8");
      expect(readThroughputRecord(dataDir, 100)).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("startDaemon throughput probe (F16)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    spawnMock.mockReset();
  });

  function stageBackend(dataDir: string): void {
    const binPath = resolveServerBinPath(dataDir, "llama-server");
    mkdirSync(dirname(binPath), { recursive: true });
    writeFileSync(binPath, "#!/bin/sh\n", "utf-8");
    const model = getLocalModelDef("qwen-3.5-4b");
    const modelPath = resolveModelFilePath(dataDir, model.id, model.filename);
    mkdirSync(dirname(modelPath), { recursive: true });
    writeFileSync(modelPath, "gguf", "utf-8");
  }

  it("probes once the server is healthy, returns the speed and records it next to the pid", async () => {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-probe-`);
    try {
      stageBackend(dataDir);
      spawnMock.mockReturnValue({ pid: 4243, unref: () => {} });
      const posts: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).endsWith("/health")) {
            return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
          }
          posts.push(String(url));
          void init;
          return new Response(
            JSON.stringify({
              timings: { predicted_n: 64, predicted_per_second: 12.6 },
            }),
            { status: 200 },
          );
        }),
      );
      const result = await startDaemon({
        dataDir,
        modelId: "qwen-3.5-4b",
        port: 19098,
        device: "cpu",
      });
      expect(result.pid).toBe(4243);
      expect(result.tokensPerSecond).toBe(12.6);
      expect(posts).toEqual(["http://127.0.0.1:19098/completion"]);
      const record = readThroughputRecord(dataDir, 4243);
      expect(record?.tokensPerSecond).toBe(12.6);
      expect(record?.modelId).toBe("qwen-3.5-4b");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips the probe when asked and leaves no stale record behind", async () => {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-noprobe-`);
    try {
      stageBackend(dataDir);
      writeThroughputRecord(dataDir, {
        pid: 1,
        modelId: "old",
        tokensPerSecond: 1,
        predictedTokens: 1,
        promptTokensPerSecond: null,
        measuredAt: 0,
      });
      spawnMock.mockReturnValue({ pid: 4244, unref: () => {} });
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await startDaemon({
        dataDir,
        modelId: "qwen-3.5-4b",
        port: 19097,
        device: "cpu",
        throughputProbe: false,
      });
      expect(result.tokensPerSecond).toBeNull();
      expect(existsSync(resolveThroughputFilePath(dataDir))).toBe(false);
      expect(
        fetchMock.mock.calls.every(([url]) => String(url).endsWith("/health")),
      ).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("--swa-full (F12)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    spawnMock.mockReset();
  });

  it("appends --swa-full only when the resolved flag is set", () => {
    const withFlag = buildLlamaServerArgs(
      { ...baseOpts, swaFullFlag: true },
      "/m.gguf",
      "alias",
      16_384,
    );
    expect(withFlag).toContain("--swa-full");
    const without = buildLlamaServerArgs(baseOpts, "/m.gguf", "alias", 16_384);
    expect(without).not.toContain("--swa-full");
    // A preference alone changes nothing at the arg layer — the decision
    // is `startDaemon`'s, from the header and the budget.
    expect(
      buildLlamaServerArgs({ ...baseOpts, swaFull: "on" }, "/m.gguf", "alias", 16_384),
    ).not.toContain("--swa-full");
  });

  function stageGemma(dataDir: string): void {
    const binPath = resolveServerBinPath(dataDir, "llama-server");
    mkdirSync(dirname(binPath), { recursive: true });
    writeFileSync(binPath, "#!/bin/sh\n", "utf-8");
    const model = getLocalModelDef("gemma-4-31b");
    const modelPath = resolveModelFilePath(dataDir, model.id, model.filename);
    mkdirSync(dirname(modelPath), { recursive: true });
    writeFileSync(modelPath, encodeSyntheticGguf(gemma4Pairs()));
  }

  function healthyFetch(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/health")
          ? new Response(JSON.stringify({ status: "ok" }), { status: 200 })
          : new Response(
              JSON.stringify({ timings: { predicted_n: 64, predicted_per_second: 5 } }),
              { status: 200 },
            ),
      ),
    );
  }

  it("reads the header at start: swaFull 'on' launches --swa-full and makes reuse partial", async () => {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-swa-on-`);
    try {
      stageGemma(dataDir);
      spawnMock.mockReturnValue({ pid: 5001, unref: () => {} });
      healthyFetch();
      const result = await startDaemon({
        dataDir,
        modelId: "gemma-4-31b",
        port: 19096,
        device: "cpu",
        swaFull: "on",
        throughputProbe: false,
      });
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain("--swa-full");
      expect(result.swaFull.enabled).toBe(true);
      expect(result.swaFull.slidingLayers).toBe(50);
      expect(result.prefixReuse).toBe("partial");
      const launch = readLaunchRecord(dataDir, 5001);
      expect(launch).toMatchObject({ swaFull: true, prefixReuse: "partial", modelId: "gemma-4-31b" });
      const log = readFileSync(resolveLogFilePath(dataDir), "utf-8");
      expect(log).toContain("[atomic-agent] launch: model gemma-4-31b (gemma4, 60 layers, trained context 262144)");
      expect(log).toContain("[atomic-agent] launch: swa-full: on (configured)");
      expect(log).toContain("[atomic-agent] launch: prefix reuse partial");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("auto with no memory budget (CPU) keeps the flag off and reports reuse none", async () => {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-swa-auto-`);
    try {
      stageGemma(dataDir);
      spawnMock.mockReturnValue({ pid: 5002, unref: () => {} });
      healthyFetch();
      const result = await startDaemon({
        dataDir,
        modelId: "gemma-4-31b",
        port: 19095,
        device: "cpu",
        throughputProbe: false,
      });
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).not.toContain("--swa-full");
      expect(result.swaFull.enabled).toBe(false);
      expect(result.swaFull.reason).toContain("no memory budget");
      expect(result.prefixReuse).toBe("none");
      expect(readLaunchRecord(dataDir, 5002)).toMatchObject({ swaFull: false, prefixReuse: "none" });
      const log = readFileSync(resolveLogFilePath(dataDir), "utf-8");
      expect(log).toContain("prefix reuse none — 50 of 60 layers use a sliding window of 1024");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("starts on the file-size fallback when the model file is not GGUF", async () => {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-daemon-nogguf-`);
    try {
      const binPath = resolveServerBinPath(dataDir, "llama-server");
      mkdirSync(dirname(binPath), { recursive: true });
      writeFileSync(binPath, "#!/bin/sh\n", "utf-8");
      const model = getLocalModelDef("qwen-3.5-4b");
      const modelPath = resolveModelFilePath(dataDir, model.id, model.filename);
      mkdirSync(dirname(modelPath), { recursive: true });
      writeFileSync(modelPath, "gguf", "utf-8");
      spawnMock.mockReturnValue({ pid: 5003, unref: () => {} });
      healthyFetch();
      const result = await startDaemon({
        dataDir,
        modelId: "qwen-3.5-4b",
        port: 19094,
        device: "cpu",
        swaFull: "on",
        throughputProbe: false,
      });
      expect(result.swaFull.enabled).toBe(false);
      expect(result.swaFull.reason).toContain("header unreadable");
      expect(result.prefixReuse).toBeNull();
      expect(readFileSync(resolveLogFilePath(dataDir), "utf-8")).toContain("(header unreadable)");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("launch records belong to one pid", () => {
    const dataDir = mkdtempSync(`${tmpdir()}/atomic-launch-record-`);
    try {
      writeLaunchRecord(dataDir, {
        pid: 7,
        modelId: "gemma-4-31b",
        contextSize: 131_072,
        swaFull: true,
        prefixReuse: "partial",
        launchedAt: 1,
      });
      expect(readLaunchRecord(dataDir, 7)?.swaFull).toBe(true);
      expect(readLaunchRecord(dataDir, 8)).toBeNull();
      expect(readLaunchRecord(dataDir, null)).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
