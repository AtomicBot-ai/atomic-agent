import { beforeEach, expect, it, vi } from "vitest";

vi.mock("./backend-installer.js", async () => ({
  ...(await vi.importActual<typeof import("./backend-installer.js")>("./backend-installer.js")),
  checkForBackendUpdate: vi.fn(),
  downloadBackend: vi.fn(),
}));
vi.mock("../core/core-backend.js", async () => ({
  ...(await vi.importActual<typeof import("../core/core-backend.js")>("../core/core-backend.js")),
  isCoreBackendInstalled: vi.fn(),
  activateCoreVersion: vi.fn(),
}));
vi.mock("../core/core-state.js", async () => ({
  ...(await vi.importActual<typeof import("../core/core-state.js")>("../core/core-state.js")),
  activeCoreVersion: vi.fn(),
}));

import { checkForBackendUpdate, downloadBackend } from "./backend-installer.js";
import { activateCoreVersion, isCoreBackendInstalled } from "../core/core-backend.js";
import { activeCoreVersion, CORE_VERSION } from "../core/core-state.js";
import { CoreUnavailableError } from "../core/core-errors.js";
import { maybeAutoUpdateBackend } from "./ensure-latest-backend.js";

const DATA = "/nonexistent/atomic-agent-test";
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(activeCoreVersion).mockReturnValue(CORE_VERSION);
});

it("installs a missing Core on the first start, with progress, even with autoUpdate off", async () => {
  vi.mocked(isCoreBackendInstalled).mockReturnValue(false);
  vi.mocked(downloadBackend).mockResolvedValue({ ok: true, tag: `Atomic Core ${CORE_VERSION} · b1` });
  const onWillDownload = vi.fn();
  const onProgress = vi.fn();
  const result = await maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: false, onWillDownload, onProgress });
  expect(result).toEqual({ action: "updated", from: null, to: `Atomic Core ${CORE_VERSION} · b1` });
  expect(onWillDownload).toHaveBeenCalled();
  expect(vi.mocked(downloadBackend).mock.calls[0]?.[1]).toMatchObject({ engine: "atomic-core", onProgress });
  // Core never consults the llama.cpp release feed.
  expect(checkForBackendUpdate).not.toHaveBeenCalled();
});

it("reuses an installed Core of this build's pin without downloading", async () => {
  vi.mocked(isCoreBackendInstalled).mockReturnValue(true);
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true })).resolves.toEqual({ action: "current", tag: `Atomic Core ${CORE_VERSION}` });
  expect(downloadBackend).not.toHaveBeenCalled();
});

/** The older pin is active and installed; this build's pin is installed beside it or not. */
function olderPinActive(newPinInstalled: boolean) {
  vi.mocked(activeCoreVersion).mockReturnValue("0.11.2");
  vi.mocked(isCoreBackendInstalled).mockImplementation((_dir: string, version?: string) => version === undefined || version === "0.11.2" || newPinInstalled);
}

it("moves an older pinned Core to this build's pin when allowed, and only then", async () => {
  olderPinActive(false);
  vi.mocked(downloadBackend).mockResolvedValue({ ok: true, tag: `Atomic Core ${CORE_VERSION} · b2`, activated: true });
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: false })).resolves.toMatchObject({ action: "current", tag: "Atomic Core 0.11.2" });
  expect(downloadBackend).not.toHaveBeenCalled();
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true })).resolves.toEqual({ action: "updated", from: "Atomic Core 0.11.2", to: `Atomic Core ${CORE_VERSION} · b2` });
});

it("installs the new pin beside an older Core that is serving, and switches only once it is idle", async () => {
  olderPinActive(false);
  // Core installed the new version into its own folder but left the active one serving.
  vi.mocked(downloadBackend).mockResolvedValue({ ok: true, tag: `Atomic Core ${CORE_VERSION} · b2`, activated: false });
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true, keepDaemonRunning: true })).resolves.toEqual({ action: "deferred", reason: "daemon_live" });
  expect(downloadBackend).toHaveBeenCalledTimes(1);

  // Installed beside it now: a start while a model still runs keeps deferring, without downloading again.
  olderPinActive(true);
  vi.mocked(activateCoreVersion).mockResolvedValue(false);
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true })).resolves.toEqual({ action: "deferred", reason: "daemon_live" });
  // The next idle start switches.
  vi.mocked(activateCoreVersion).mockResolvedValue(true);
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true })).resolves.toMatchObject({ action: "updated", from: "Atomic Core 0.11.2" });
  expect(activateCoreVersion).toHaveBeenLastCalledWith(DATA, CORE_VERSION);
  expect(downloadBackend).toHaveBeenCalledTimes(1);
});

it("reports a computer without a Core build as non-retryable, for the start to fall back", async () => {
  vi.mocked(isCoreBackendInstalled).mockReturnValue(false);
  vi.mocked(downloadBackend).mockRejectedValue(new CoreUnavailableError({ stage: "backend", reasonCode: "no_backend", detail: "Atomic Core found no compatible inference backend for this computer" }));
  const result = await maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true });
  expect(result).toMatchObject({ action: "update_failed", backendUsable: false, coreFailure: { reasonCode: "no_backend", retryable: false } });
  expect(result.action === "update_failed" && result.error).not.toContain("atomic-agent models update");
});

it("reports a failed install with what to offer next instead of throwing", async () => {
  vi.mocked(isCoreBackendInstalled).mockReturnValue(false);
  vi.mocked(downloadBackend).mockRejectedValue(new CoreUnavailableError({ stage: "download", reasonCode: "network", detail: "fetch failed" }));
  const result = await maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true });
  expect(result).toMatchObject({
    action: "update_failed",
    backendUsable: false,
    coreFailure: { stage: "download", reasonCode: "network", retryable: true },
  });
  expect(result.action === "update_failed" && result.error).toContain("atomic-agent models update");
  expect(result.action === "update_failed" && result.error).not.toMatch(/llama/i);
});

it("keeps an older install serving when its upgrade fails", async () => {
  olderPinActive(false);
  vi.mocked(downloadBackend).mockRejectedValue(new Error("Stop local models before updating the engine. Your running models are unchanged."));
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true })).resolves.toMatchObject({ action: "update_failed", backendUsable: true });
});
