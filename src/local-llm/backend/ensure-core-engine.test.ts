import { beforeEach, expect, it, vi } from "vitest";

vi.mock("./backend-installer.js", async () => ({
  ...(await vi.importActual<typeof import("./backend-installer.js")>("./backend-installer.js")),
  checkForBackendUpdate: vi.fn(),
  downloadBackend: vi.fn(),
}));
vi.mock("../core/core-backend.js", async () => ({
  ...(await vi.importActual<typeof import("../core/core-backend.js")>("../core/core-backend.js")),
  isCoreBackendInstalled: vi.fn(),
}));
vi.mock("../core/core-state.js", async () => ({
  ...(await vi.importActual<typeof import("../core/core-state.js")>("../core/core-state.js")),
  activeCoreVersion: vi.fn(),
}));

import { checkForBackendUpdate, downloadBackend } from "./backend-installer.js";
import { isCoreBackendInstalled } from "../core/core-backend.js";
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

it("moves an older pinned Core to this build's pin when allowed, and only then", async () => {
  vi.mocked(isCoreBackendInstalled).mockReturnValue(true);
  vi.mocked(activeCoreVersion).mockReturnValue("0.11.2");
  vi.mocked(downloadBackend).mockResolvedValue({ ok: true, tag: `Atomic Core ${CORE_VERSION} · b2` });
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: false })).resolves.toMatchObject({ action: "current", tag: "Atomic Core 0.11.2" });
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true, keepDaemonRunning: true })).resolves.toEqual({ action: "deferred", reason: "daemon_live" });
  expect(downloadBackend).not.toHaveBeenCalled();
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true })).resolves.toEqual({ action: "updated", from: "Atomic Core 0.11.2", to: `Atomic Core ${CORE_VERSION} · b2` });
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
  expect(result.action === "update_failed" && result.error).toContain("atomic-agent models engine llama-server");
});

it("keeps an older install serving when its upgrade fails", async () => {
  vi.mocked(isCoreBackendInstalled).mockReturnValue(true);
  vi.mocked(activeCoreVersion).mockReturnValue("0.11.2");
  vi.mocked(downloadBackend).mockRejectedValue(new Error("Stop local models before updating the engine. Your running models are unchanged."));
  await expect(maybeAutoUpdateBackend(DATA, { engine: "atomic-core", enabled: true })).resolves.toMatchObject({ action: "update_failed", backendUsable: true });
});
