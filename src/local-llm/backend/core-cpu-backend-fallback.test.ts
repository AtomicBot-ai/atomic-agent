import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ call: vi.fn(), downloadEvents: vi.fn(), snapshot: vi.fn() }));
const stopBothMock = vi.hoisted(() => vi.fn());

vi.mock("../core/core-client.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../core/core-client.js")>()),
  connectCore: vi.fn(async () => null),
  withCoreClient: async (_d: string, _v: string, fn: (client: typeof fake) => Promise<unknown>) => fn(fake),
}));
vi.mock("../core/core-install.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../core/core-install.js")>()),
  installCore: vi.fn(async () => {}),
}));
vi.mock("../server/daemon-lifecycle.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../server/daemon-lifecycle.js")>()),
  stopChatAndEmbeddingDaemons: stopBothMock,
}));

import { CoreRequestError } from "../core/core-client.js";
import { CORE_VERSION, coreVersionDir, readCoreBackend, writeCoreJson } from "../core/core-state.js";
import { resolveLogFilePath } from "../backend-paths.js";
import {
  CORE_CPU_FALLBACK_LINE,
  coreCpuFallbackApplies,
  fallBackToCoreCpuBuild,
  shouldFallBackToCoreCpuBuild,
} from "./core-cpu-backend-fallback.js";
import { getConfiguredBackendVariant, setConfiguredBackendVariant } from "./windows-backend-variant.js";

const crash = () => new CoreRequestError(500, "Could not load model qwen-3.5-4b after fallback attempts.", "MODEL_LOAD_FAILED");

describe("shouldFallBackToCoreCpuBuild", () => {
  const eligible = {
    installedBackend: "windows-x64-vulkan",
    configuredVariant: "auto" as const,
    error: crash(),
    platform: "win32" as const,
    arch: "x64",
  };

  it("switches when the Vulkan or CUDA build crashes on load", () => {
    expect(shouldFallBackToCoreCpuBuild(eligible)).toBe(true);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, installedBackend: "win-cuda-13.1-x64" })).toBe(true);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(502, "llama-server exited during load") })).toBe(true);
  });

  it("never switches for out of memory, in Core's answer or in this run's log", () => {
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(500, "Could not load model: out of memory") })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(500, "load failed", "OUT_OF_MEMORY") })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, logText: "ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, logText: "ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory" })).toBe(false);
  });

  it("never switches for a missing model file or a busy port", () => {
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(500, "model file not found") })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(500, "load failed", "MODEL_NOT_FOUND") })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, logText: "gguf_init_from_file: failed to open GGUF file 'x.gguf' (No such file or directory)" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(500, "port 19091: address already in use") })).toBe(false);
  });

  it("is not put off by a normal startup log", () => {
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, logText: "main: binding port with default address family\nmain: HTTP server is listening\nllama_model_loader: loaded meta data" })).toBe(true);
  });

  it("never switches off Windows x64", () => {
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, platform: "darwin" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, platform: "linux" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, arch: "arm64" })).toBe(false);
  });

  it("honours a pinned variant, and never re-runs on the CPU build", () => {
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, configuredVariant: "vulkan" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, configuredVariant: "cpu" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, installedBackend: "windows-x64-cpu" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, installedBackend: undefined })).toBe(false);
  });

  it("only reacts to Core's own load failure", () => {
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(400, "invalid request") })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new Error("Atomic Core request failed") })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: "not even an Error" })).toBe(false);
  });
});

describe("Core CPU-build rescue with a mocked Core", () => {
  let dir: string;
  let backendPath: string;

  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    setConfiguredBackendVariant("auto");
    dir = mkdtempSync(join(tmpdir(), "core-cpu-fallback-"));
    backendPath = join(dir, "installed-backend");
    mkdirSync(backendPath, { recursive: true });
    writeFileSync(join(backendPath, "llama-server.exe"), "fixture");
    writeFileSync(join(backendPath, "llama-server"), "fixture");
    // The GPU build Core recommended at first install.
    writeCoreJson(join(coreVersionDir(dir, CORE_VERSION), "backend.json"), {
      coreVersion: CORE_VERSION, provider: "llamacpp", version: "b2", backend: "windows-x64-vulkan",
      binary: join(backendPath, "llama-server.exe"), installedAt: "now",
    });
    fake.downloadEvents.mockResolvedValue(async () => {});
    fake.call.mockImplementation(async (path: string) => {
      if (path === "/backends/llamacpp/catalog") {
        return {
          recommended: "b2/windows-x64-vulkan",
          recommended_installed: "b2/windows-x64-vulkan",
          releases: [{ tag: "b2", variants: [
            { id: "windows-x64-vulkan", asset: "llama-turboquant-windows-x64-vulkan.zip" },
            { id: "windows-x64-cpu", asset: "llama-turboquant-windows-x64-cpu.zip" },
          ] }],
        };
      }
      if (path === "/backends/llamacpp/install") return { path: backendPath };
      return {};
    });
    stopBothMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fake.call.mockReset();
    setConfiguredBackendVariant("auto");
    rmSync(dir, { recursive: true, force: true });
  });

  /** What `models start` and the TUI do: one rescue, one retry on device cpu. */
  async function startWithRescue(start: (device: string | undefined) => Promise<string>): Promise<string> {
    try {
      return await start(undefined);
    } catch (e) {
      if (!coreCpuFallbackApplies(dir, getConfiguredBackendVariant(), e)) throw e;
      await fallBackToCoreCpuBuild(dir);
      return await start("cpu");
    }
  }

  const installs = () => fake.call.mock.calls.filter(([path]) => path === "/backends/llamacpp/install");

  it("installs the CPU build once after a crash on load, and the retry starts", async () => {
    const start = vi.fn().mockRejectedValueOnce(crash()).mockResolvedValueOnce("started");
    await expect(startWithRescue(start)).resolves.toBe("started");
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]![0]).toBe("cpu");
    expect(installs()).toHaveLength(1);
    expect(installs()[0]![1]).toMatchObject({ version: "b2", backend: "windows-x64-cpu", asset_name: "llama-turboquant-windows-x64-cpu.zip" });
    expect(readCoreBackend(dir)?.backend).toBe("windows-x64-cpu");
    expect(getConfiguredBackendVariant()).toBe("cpu");
    // The failed start's leftovers are stopped before the install.
    expect(stopBothMock).toHaveBeenCalledWith(dir);
    expect(stopBothMock.mock.invocationCallOrder[0]!).toBeLessThan(fake.call.mock.invocationCallOrder[0]!);
    expect(readFileSync(resolveLogFilePath(dir), "utf8")).toContain(CORE_CPU_FALLBACK_LINE);
    expect(CORE_CPU_FALLBACK_LINE).toContain("falling back to the CPU build (slower)");
  });

  it("does not switch for out of memory", async () => {
    const oom = new CoreRequestError(500, "Could not load model: failed to allocate buffer, out of memory");
    const start = vi.fn().mockRejectedValue(oom);
    await expect(startWithRescue(start)).rejects.toBe(oom);
    expect(start).toHaveBeenCalledTimes(1);
    expect(installs()).toHaveLength(0);
    expect(readCoreBackend(dir)?.backend).toBe("windows-x64-vulkan");
  });

  it("does not switch for an out-of-memory line in this run's log", async () => {
    writeFileSync(resolveLogFilePath(dir), "[atomic-agent] launch: model qwen-3.5-4b\nggml_vulkan: ErrorOutOfDeviceMemory\n");
    const start = vi.fn().mockRejectedValue(crash());
    await expect(startWithRescue(start)).rejects.toBeInstanceOf(CoreRequestError);
    expect(installs()).toHaveLength(0);
  });

  it("does not switch off Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const start = vi.fn().mockRejectedValue(crash());
    await expect(startWithRescue(start)).rejects.toBeInstanceOf(CoreRequestError);
    expect(start).toHaveBeenCalledTimes(1);
    expect(installs()).toHaveLength(0);
  });
});
