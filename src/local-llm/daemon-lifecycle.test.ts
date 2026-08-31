import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  resolveModelFilePath,
  resolvePidFilePath,
  resolveServerBinPath,
} from "./backend-paths.js";
import {
  buildEmbeddingServerArgs,
  buildLlamaServerArgs,
  DaemonHealthError,
  ForeignDaemonError,
  readRunningPid,
  startDaemon,
  stopDaemon,
  stopEmbeddingDaemon,
  type DaemonStartOptions,
  type EmbeddingDaemonStartOptions,
} from "./daemon-lifecycle.js";
import { getLocalModelDef } from "./models-catalog.js";

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
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
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
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
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

  async function withTempDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
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

      await expect(stopDaemon(dataDir)).rejects.toBeInstanceOf(ForeignDaemonError);
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

      await expect(stopEmbeddingDaemon(dataDir)).rejects.toBeInstanceOf(ForeignDaemonError);
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
