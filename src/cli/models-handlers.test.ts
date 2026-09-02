import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../local-llm/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../local-llm/index.js")>(
      "../local-llm/index.js",
    );
  return {
    ...actual,
    maybeAutoUpdateBackend: vi.fn(),
    resolveManagedDevice: vi.fn(),
    startChatAndEmbeddingDaemons: vi.fn(),
    fallBackToCpuBackend: vi.fn(),
  };
});

import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import * as localLlm from "../local-llm/index.js";
import { resolveBackendDir } from "../local-llm/index.js";
import { writeBackendVersion } from "../local-llm/backend-version.js";
import { DaemonHealthError } from "../local-llm/daemon-lifecycle.js";
import {
  WINDOWS_BACKEND_ASSETS,
  setConfiguredBackendVariant,
} from "../local-llm/windows-backend-variant.js";
import { runLocalModelsStart } from "./models-handlers.js";

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
    vi.mocked(localLlm.resolveManagedDevice).mockReset().mockResolvedValue("Vulkan0");
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

  it("retries once on the CPU device and persists the variant", async () => {
    const dataDir = prepareManagedWindowsInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons)
      .mockRejectedValueOnce(healthError())
      .mockResolvedValueOnce({ chat: { pid: 777 }, embedding: { skipped: true } });

    await expect(runLocalModelsStart()).resolves.toBe(0);

    // The download must carry a deadline and progress — the exact
    // stalled-open-connection hazard the auto-update path guards.
    expect(localLlm.fallBackToCpuBackend).toHaveBeenCalledTimes(1);
    const [calledDataDir, dlOpts] = vi.mocked(localLlm.fallBackToCpuBackend).mock
      .calls[0]! as [string, { signal?: AbortSignal; onProgress?: unknown }];
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
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(healthError());
    vi.mocked(localLlm.fallBackToCpuBackend).mockRejectedValue(new Error("HTTP 503"));

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
