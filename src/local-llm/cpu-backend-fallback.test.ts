import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadBackendMock = vi.hoisted(() => vi.fn());
const stopBothMock = vi.hoisted(() => vi.fn());

vi.mock("./backend-installer.js", () => ({
  downloadBackend: downloadBackendMock,
}));
vi.mock("./daemon-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon-lifecycle.js")>()),
  stopChatAndEmbeddingDaemons: stopBothMock,
}));

import {
  fallBackToCpuBackend,
  shouldFallBackToCpuBackend,
} from "./cpu-backend-fallback.js";
import { DaemonHealthError } from "./daemon-lifecycle.js";
import {
  WINDOWS_BACKEND_ASSETS,
  getConfiguredBackendVariant,
  setConfiguredBackendVariant,
} from "./windows-backend-variant.js";

const healthError = new DaemonHealthError(
  "llama-server did not become healthy within 30000ms. Log tail:\n(no log)",
);

describe("shouldFallBackToCpuBackend", () => {
  const eligible = {
    installedAsset: WINDOWS_BACKEND_ASSETS.vulkan,
    configuredVariant: "auto" as const,
    error: healthError,
    platform: "win32" as const,
  };

  it("falls back for a Vulkan install that never became healthy", () => {
    expect(shouldFallBackToCpuBackend(eligible)).toBe(true);
  });

  it("falls back for either CUDA install too", () => {
    expect(
      shouldFallBackToCpuBackend({
        ...eligible,
        installedAsset: WINDOWS_BACKEND_ASSETS.cuda124,
      }),
    ).toBe(true);
    expect(
      shouldFallBackToCpuBackend({
        ...eligible,
        installedAsset: WINDOWS_BACKEND_ASSETS.cuda133,
      }),
    ).toBe(true);
  });

  it("falls back for a pre-`asset`-field install (undefined asset)", () => {
    expect(
      shouldFallBackToCpuBackend({ ...eligible, installedAsset: undefined }),
    ).toBe(true);
  });

  it("never falls back off Windows", () => {
    expect(shouldFallBackToCpuBackend({ ...eligible, platform: "darwin" })).toBe(
      false,
    );
    expect(shouldFallBackToCpuBackend({ ...eligible, platform: "linux" })).toBe(
      false,
    );
  });

  it("honours an operator-pinned variant, including 'cpu' itself", () => {
    expect(
      shouldFallBackToCpuBackend({ ...eligible, configuredVariant: "vulkan" }),
    ).toBe(false);
    expect(
      shouldFallBackToCpuBackend({ ...eligible, configuredVariant: "cpu" }),
    ).toBe(false);
  });

  it("does not fall back when the CPU build is already installed", () => {
    expect(
      shouldFallBackToCpuBackend({
        ...eligible,
        installedAsset: WINDOWS_BACKEND_ASSETS.cpu,
      }),
    ).toBe(false);
  });

  it("only reacts to a health-wait failure, not pre-spawn errors", () => {
    // A missing model, a bound port or an "already running" daemon would
    // fail the CPU build identically — no swap can fix those.
    expect(
      shouldFallBackToCpuBackend({
        ...eligible,
        error: new Error("model qwen not downloaded"),
      }),
    ).toBe(false);
    expect(
      shouldFallBackToCpuBackend({ ...eligible, error: "not even an Error" }),
    ).toBe(false);
  });
});

describe("fallBackToCpuBackend", () => {
  beforeEach(() => {
    setConfiguredBackendVariant("auto");
    downloadBackendMock.mockReset().mockResolvedValue({ ok: true, tag: "turboquant-x" });
    stopBothMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    setConfiguredBackendVariant("auto");
  });

  it("flips the variant to cpu, stops the half-started daemon, re-downloads", async () => {
    const result = await fallBackToCpuBackend("/data");
    expect(result).toEqual({ tag: "turboquant-x" });
    expect(getConfiguredBackendVariant()).toBe("cpu");
    expect(stopBothMock).toHaveBeenCalledWith("/data");
    expect(downloadBackendMock).toHaveBeenCalledWith("/data", {});
    // The stop must land before the download, or the Windows file lock
    // held by a hung loader would fail the backend swap.
    expect(stopBothMock.mock.invocationCallOrder[0]!).toBeLessThan(
      downloadBackendMock.mock.invocationCallOrder[0]!,
    );
  });

  it("still downloads when stopping the old daemon fails", async () => {
    stopBothMock.mockRejectedValue(new Error("foreign pid"));
    await expect(fallBackToCpuBackend("/data")).resolves.toEqual({
      tag: "turboquant-x",
    });
    expect(downloadBackendMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed download, leaving the cpu preference set", async () => {
    downloadBackendMock.mockRejectedValue(new Error("HTTP 503"));
    await expect(fallBackToCpuBackend("/data")).rejects.toThrow("HTTP 503");
    expect(getConfiguredBackendVariant()).toBe("cpu");
  });

  it("forwards progress callback and abort signal to the download", async () => {
    const onProgress = vi.fn();
    const signal = AbortSignal.timeout(60_000);
    await fallBackToCpuBackend("/data", { onProgress, signal });
    expect(downloadBackendMock).toHaveBeenCalledWith("/data", {
      onProgress,
      signal,
    });
  });
});
