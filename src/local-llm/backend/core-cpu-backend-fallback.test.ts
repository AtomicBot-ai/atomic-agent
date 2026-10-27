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
  revertCoreCpuFallback,
  shouldFallBackToCoreCpuBuild,
} from "./core-cpu-backend-fallback.js";
import { getConfiguredCoreBackendVariant, setConfiguredBackendVariant, setConfiguredCoreBackendVariant } from "./windows-backend-variant.js";

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

  it("never switches for a model llama.cpp cannot read, or Core's load timeout", () => {
    for (const logText of [
      "llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'newarch'",
      "gguf_init_from_file_impl: tensor 'blk.0.attn_q.weight' has invalid ggml type 42",
      "llama_model_load: error loading model: tensor 'blk.3.ffn_up.weight' data is not within the file bounds, model is corrupted or incomplete",
      "llama_model_load: error loading model: done_getting_tensors: wrong number of tensors; expected 291, got 290",
    ]) {
      expect(shouldFallBackToCoreCpuBuild({ ...eligible, logText })).toBe(false);
    }
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(500, "Model load timed out after 180 seconds") })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(504, "load failed", "LOAD_TIMEOUT") })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, error: new CoreRequestError(500, "unknown model architecture: 'newarch'") })).toBe(false);
  });

  it("is not put off by a normal startup log", () => {
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, logText: "main: binding port with default address family\nmain: HTTP server is listening\nllama_model_loader: loaded meta data" })).toBe(true);
  });

  it("never switches off Windows x64", () => {
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, platform: "darwin" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, platform: "linux" })).toBe(false);
    expect(shouldFallBackToCoreCpuBuild({ ...eligible, arch: "arm64" })).toBe(false);
  });

  it("never re-runs once Core is on the CPU build", () => {
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
    setConfiguredCoreBackendVariant("auto");
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
    setConfiguredCoreBackendVariant("auto");
    rmSync(dir, { recursive: true, force: true });
  });

  const installs = () => fake.call.mock.calls.filter(([path]) => path === "/backends/llamacpp/install");

  it("applies to a crash on the GPU build, and installs the CPU build once without persisting anything", async () => {
    expect(coreCpuFallbackApplies(dir, crash())).toBe(true);
    const swap = await fallBackToCoreCpuBuild(dir);
    expect(installs()).toHaveLength(1);
    expect(installs()[0]![1]).toMatchObject({ version: "b2", backend: "windows-x64-cpu", asset_name: "llama-turboquant-windows-x64-cpu.zip" });
    expect(readCoreBackend(dir)?.backend).toBe("windows-x64-cpu");
    // In-process only: the caller records it after the retry served the model.
    expect(getConfiguredCoreBackendVariant()).toBe("cpu");
    expect(swap.previous?.backend).toBe("windows-x64-vulkan");
    expect(swap.previousVariant).toBe("auto");
    // The failed start's leftovers are stopped before the install.
    expect(stopBothMock).toHaveBeenCalledWith(dir);
    expect(stopBothMock.mock.invocationCallOrder[0]!).toBeLessThan(fake.call.mock.invocationCallOrder[0]!);
    expect(readFileSync(resolveLogFilePath(dir), "utf8")).toContain(CORE_CPU_FALLBACK_LINE);
    expect(CORE_CPU_FALLBACK_LINE).toContain("falling back to the CPU build (slower)");
    // Now on the CPU build: a second failure never rescues again.
    expect(coreCpuFallbackApplies(dir, crash())).toBe(false);
  });

  it("puts the GPU build back when the CPU retry fails too", async () => {
    const swap = await fallBackToCoreCpuBuild(dir);
    revertCoreCpuFallback(dir, swap);
    expect(readCoreBackend(dir)?.backend).toBe("windows-x64-vulkan");
    expect(getConfiguredCoreBackendVariant()).toBe("auto");
    expect(coreCpuFallbackApplies(dir, crash())).toBe(true);
  });

  it("changes nothing when the CPU install fails, so the next start can rescue again", async () => {
    fake.call.mockImplementation(async (path: string) => {
      if (path === "/backends/llamacpp/catalog") throw new CoreRequestError(400, "catalog refused");
      return {};
    });
    await expect(fallBackToCoreCpuBuild(dir)).rejects.toBeTruthy();
    expect(getConfiguredCoreBackendVariant()).toBe("auto");
    expect(readCoreBackend(dir)?.backend).toBe("windows-x64-vulkan");
    expect(coreCpuFallbackApplies(dir, crash())).toBe(true);
  });

  it("does not apply for out of memory, in the answer or in this run's log", () => {
    expect(coreCpuFallbackApplies(dir, new CoreRequestError(500, "Could not load model: failed to allocate buffer, out of memory"))).toBe(false);
    writeFileSync(resolveLogFilePath(dir), "[atomic-agent] launch: model qwen-3.5-4b\nggml_vulkan: ErrorOutOfDeviceMemory\n");
    expect(coreCpuFallbackApplies(dir, crash())).toBe(false);
    expect(installs()).toHaveLength(0);
  });

  it("does not apply off Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(coreCpuFallbackApplies(dir, crash())).toBe(false);
  });

  it("ignores the llama-server engine's backendVariant", () => {
    setConfiguredBackendVariant("cpu");
    expect(coreCpuFallbackApplies(dir, crash())).toBe(true);
  });
});
