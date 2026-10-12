import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../local-llm/index.js", async () => {
  const actual = await vi.importActual<typeof import("../local-llm/index.js")>(
    "../local-llm/index.js",
  );
  return {
    ...actual,
    maybeAutoUpdateBackend: vi.fn(),
    resolveManagedDevice: vi.fn(),
    startChatAndEmbeddingDaemons: vi.fn(),
    fallBackToCpuBackend: vi.fn(),
    startEmbeddingDaemon: vi.fn(),
    getEmbeddingDaemonStatus: vi.fn(),
    isEmbeddingModelDownloaded: vi.fn(),
  };
});

import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import * as localLlm from "../local-llm/index.js";
import {
  resetLatestReleaseCache,
  resolveBackendDir,
  resolveServerBinPath,
  WINDOWS_ARM64_NO_BACKEND_MESSAGE,
} from "../local-llm/index.js";
import { writeBackendVersion } from "../local-llm/backend/backend-version.js";
import { DaemonHealthError } from "../local-llm/server/daemon-lifecycle.js";
import {
  WINDOWS_BACKEND_ASSETS,
  setConfiguredBackendVariant,
} from "../local-llm/backend/windows-backend-variant.js";
import {
  runLocalModelsPull,
  runLocalModelsStart,
  runLocalModelsStartEmbedding,
  runLocalModelsUpdate,
} from "./models-handlers.js";

const healthError = () =>
  new DaemonHealthError(
    "llama-server did not become healthy within 30000ms. Log tail:\n(no log)",
  );

/**
 * Integration tests for the CPU-backend fallback retry block inside
 * `runLocalModelsStart` — the CLI twin of the orchestrator wiring
 * covered in `local-models-orchestrator-cpu-fallback.test.ts`. The pure
 * pieces have their own tests; these prove the handler actually
 * consults them, retries on the CPU device, and persists the variant.
 */
describe("runLocalModelsStart CPU-backend fallback", () => {
  let stateDir: string;
  let stderrChunks: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-cpufb-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    // The fallback is Windows-only; the real eligibility gate must see
    // win32 or these tests would silently assert nothing.
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    resetConfigCache();
    setConfiguredBackendVariant("auto");
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.mocked(localLlm.maybeAutoUpdateBackend)
      .mockReset()
      .mockResolvedValue({ action: "current", tag: "turboquant-win" });
    vi.mocked(localLlm.resolveManagedDevice)
      .mockReset()
      .mockResolvedValue("Vulkan0");
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockReset();
    vi.mocked(localLlm.fallBackToCpuBackend)
      .mockReset()
      .mockResolvedValue({ tag: "turboquant-win" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setConfiguredBackendVariant("auto");
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });


  it("bypasses the throughput benchmark only for an interactive start", async () => {
    prepareManagedWindowsInstall();
    // A failure after receipt is enough to inspect launch policy without a daemon.
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(new Error("test stop"));
    await runLocalModelsStart({ interactive: true });
    expect(vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls[0]![0].chat.throughputProbe).toBe(false);
    expect(vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls[0]![0].chat.healthTimeoutMs).toBe(120_000);
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockClear();
    await runLocalModelsStart();
    expect(vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls[0]![0].chat.throughputProbe).toBeUndefined();
  });
  it("retries once on the CPU device and persists the variant", async () => {
    const dataDir = prepareManagedWindowsInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons)
      .mockRejectedValueOnce(healthError())
      .mockResolvedValueOnce({
        chat: { pid: 777 },
        embedding: { skipped: true },
      });

    await expect(runLocalModelsStart()).resolves.toBe(0);

    // The download must carry a deadline and progress — the exact
    // stalled-open-connection hazard the auto-update path guards.
    expect(localLlm.fallBackToCpuBackend).toHaveBeenCalledTimes(1);
    const [calledDataDir, dlOpts] = vi.mocked(localLlm.fallBackToCpuBackend)
      .mock.calls[0]! as [
      string,
      { signal?: AbortSignal; onProgress?: unknown },
    ];
    expect(calledDataDir).toBe(dataDir);
    expect(dlOpts.signal).toBeInstanceOf(AbortSignal);
    expect(dlOpts.onProgress).toBeTypeOf("function");

    // The GPU device picked against the old binary must not leak into
    // the retry — the CPU build would reject `--device Vulkan0`.
    const starts = vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls;
    expect(starts).toHaveLength(2);
    expect(starts[0]![0].chat.device).toBe("Vulkan0");
    expect(starts[1]![0].chat.device).toBe("cpu");

    // Loop-guard against auto-update reinstalling the broken GPU build.
    expect(getConfig().localModels.managed.backendVariant).toBe("cpu");
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("falling back to the CPU build");
    expect(stderr).toContain('recorded backendVariant "cpu"');
  });

  it("does not fall back on a pre-spawn failure", async () => {
    prepareManagedWindowsInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(
      new Error("model qwen not downloaded"),
    );

    await expect(runLocalModelsStart()).resolves.toBe(1);

    expect(localLlm.fallBackToCpuBackend).not.toHaveBeenCalled();
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(1);
    expect(getConfig().localModels.managed.backendVariant).toBe("auto");
    expect(stderrChunks.join("")).toContain("model qwen not downloaded");
  });

  it("surfaces a failed CPU download and exits non-zero", async () => {
    prepareManagedWindowsInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(
      healthError(),
    );
    vi.mocked(localLlm.fallBackToCpuBackend).mockRejectedValue(
      new Error("HTTP 503"),
    );

    await expect(runLocalModelsStart()).resolves.toBe(1);

    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(1);
    expect(stderrChunks.join("")).toContain("HTTP 503");
  });

  /**
   * Managed mode over a stub Windows GPU install, so the real
   * `shouldFallBackToCpuBackend` sees an eligible machine: win32,
   * variant `auto`, a GPU asset recorded in backend-version.json.
   */
  function prepareManagedWindowsInstall(): string {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
        managed: {
          ...USER_CONFIG_DEFAULTS.localModels.managed,
          modelId: "qwen-3.5-4b",
        },
      },
    });
    resetConfigCache();
    const dataDir = getConfig().paths.localModelsDataDir;
    mkdirSync(resolveBackendDir(dataDir), { recursive: true });
    writeBackendVersion(dataDir, {
      tag: "turboquant-win",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset: WINDOWS_BACKEND_ASSETS.vulkan,
      releasedAt: "2026-06-01T00:00:00Z",
    });
    return dataDir;
  }
});

/**
 * The foreground `models pull --mmproj` mirrors the background worker:
 * a projector the repo stopped serving must not read as a failed pull
 * once the weights are saved.
 */
describe("runLocalModelsPull — projector failure after the weights", () => {
  let stateDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let previousFetch: typeof fetch;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-pull-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdoutChunks = [];
    stderrChunks = [];
    previousFetch = globalThis.fetch;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("saves the weights, notes the projector failure and exits 0", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("mmproj")) {
        return new Response(null, { status: 404, statusText: "Not Found" });
      }
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(Buffer.from("gguf"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-length": "4" } },
      );
    }) as typeof fetch;

    const code = await runLocalModelsPull(["qwen-3.5-4b", "--mmproj"]);

    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toMatch(/done\. model saved to /);
    expect(stdoutChunks.join("")).not.toMatch(/mmproj saved/);
    expect(stderrChunks.join("")).toMatch(
      /note: projector download failed \(Download failed: HTTP 404 Not Found\) — qwen-3.5-4b is usable text-only; 'models pull --mmproj qwen-3.5-4b'/,
    );
  });
});

/**
 * `models start-embedding`: the embedding daemon alone, beside a chat
 * daemon `start` would refuse to touch (the desktop's ATO-126).
 */
describe("runLocalModelsStartEmbedding", () => {
  let stateDir: string;
  let stdoutChunks: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-emb-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdoutChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(localLlm.resolveManagedDevice).mockReset().mockResolvedValue(undefined);
    vi.mocked(localLlm.startEmbeddingDaemon).mockReset().mockResolvedValue({ pid: 4243 });
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockReset().mockResolvedValue({
      running: false, pid: null, port: 19092, healthy: false, loading: false,
    });
    vi.mocked(localLlm.isEmbeddingModelDownloaded).mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function writeConfig(enabled: boolean): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
        embeddings: {
          ...USER_CONFIG_DEFAULTS.localModels.embeddings,
          enabled,
          modelId: "nomic-embed-text-v1.5",
        },
      },
    });
    resetConfigCache();
  }

  it("starts the embedding daemon alone on the configured port", async () => {
    writeConfig(true);
    await expect(runLocalModelsStartEmbedding()).resolves.toBe(0);
    expect(localLlm.startEmbeddingDaemon).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.startEmbeddingDaemon).mock.calls[0]![0]).toMatchObject({
      modelId: "nomic-embed-text-v1.5",
      port: 19092,
    });
    expect(stdoutChunks.join("")).toMatch(/^embedding: started pid 4243, healthy on port 19092/m);
  });

  it("starts nothing when it is already running, or not asked for", async () => {
    writeConfig(true);
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockResolvedValue({
      running: true, pid: 99, port: 19092, healthy: true, loading: false,
    });
    await expect(runLocalModelsStartEmbedding()).resolves.toBe(0);
    expect(stdoutChunks.join("")).toMatch(/^embedding: already running pid 99/m);
    writeConfig(false);
    await expect(runLocalModelsStartEmbedding()).resolves.toBe(0);
    expect(stdoutChunks.join("")).toMatch(/^embedding: disabled/m);
    expect(localLlm.startEmbeddingDaemon).not.toHaveBeenCalled();
  });

  it("exits 1 when the start fails", async () => {
    writeConfig(true);
    vi.mocked(localLlm.startEmbeddingDaemon).mockRejectedValue(new Error("port 19092 is already served"));
    await expect(runLocalModelsStartEmbedding()).resolves.toBe(1);
  });
});

/**
 * ATO-252: `models update` on Windows on ARM before any engine release
 * carries the arm64 zip. With nothing installed it must fail with the
 * sentence the desktop shows, not exit 0 as "unchanged".
 */
describe("runLocalModelsUpdate on Windows arm64 with no arm64 release", () => {
  let stateDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let previousFetch: typeof fetch;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-update-arm64-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    resetConfigCache();
    resetLatestReleaseCache();
    stdoutChunks = [];
    stderrChunks = [];
    previousFetch = globalThis.fetch;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    // Releases exist, none with the arm64 zip.
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            tag_name: "turboquant-x64-only",
            published_at: "2026-10-06T00:00:00Z",
            assets: [
              {
                name: WINDOWS_BACKEND_ASSETS.vulkan,
                browser_download_url: "https://example.com/win.zip",
              },
            ],
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
      },
    });
    resetConfigCache();
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    vi.restoreAllMocks();
    resetLatestReleaseCache();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("fails with the plain Windows on ARM sentence when nothing is installed", async () => {
    await expect(runLocalModelsUpdate()).resolves.toBe(1);
    expect(stderrChunks.join("")).toContain(WINDOWS_ARM64_NO_BACKEND_MESSAGE);
    expect(stdoutChunks.join("")).not.toMatch(/backend unchanged/);
  });

  it("keeps an installed arm64 backend as it is", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    mkdirSync(resolveBackendDir(dataDir), { recursive: true });
    writeFileSync(resolveServerBinPath(dataDir, "llama-server.exe"), "x");

    await expect(runLocalModelsUpdate()).resolves.toBe(0);
    expect(stdoutChunks.join("")).toMatch(/backend unchanged/);
  });
});
