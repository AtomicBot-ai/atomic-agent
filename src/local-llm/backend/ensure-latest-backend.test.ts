import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./backend-installer.js", async () => {
  const actual = await vi.importActual<typeof import("./backend-installer.js")>(
    "./backend-installer.js",
  );
  return {
    ...actual,
    checkForBackendUpdate: vi.fn(),
    downloadBackend: vi.fn(),
    isBackendDownloaded: vi.fn(),
  };
});

vi.mock("../server/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<typeof import("../server/daemon-lifecycle.js")>(
    "../server/daemon-lifecycle.js",
  );
  return {
    ...actual,
    readRunningPid: vi.fn(),
    stopChatAndEmbeddingDaemons: vi.fn(),
  };
});

vi.mock("../server/session-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../server/session-registry.js")>(
    "../server/session-registry.js",
  );
  return {
    ...actual,
    hasOtherLiveSessions: vi.fn(),
  };
});

import {
  checkForBackendUpdate,
  downloadBackend,
  isBackendDownloaded,
} from "./backend-installer.js";
import {
  readRunningPid,
  stopChatAndEmbeddingDaemons,
} from "../server/daemon-lifecycle.js";
import { resolveBackendCheckFilePath } from "../backend-paths.js";
import { writeBackendVersion } from "./backend-version.js";
import {
  AUTO_UPDATE_RECHECK_MS,
  AUTO_UPDATE_RETRY_MS,
  checkForBackendUpdateForPanel,
  maybeAutoUpdateBackend,
} from "./ensure-latest-backend.js";
import { hasOtherLiveSessions } from "../server/session-registry.js";
import { resolveDownloadAsset } from "./windows-backend-variant.js";

describe("maybeAutoUpdateBackend", () => {
  afterEach(() => {
    vi.mocked(checkForBackendUpdate).mockReset();
    vi.mocked(downloadBackend).mockReset();
    vi.mocked(readRunningPid).mockReset();
    vi.mocked(stopChatAndEmbeddingDaemons).mockReset();
    vi.mocked(hasOtherLiveSessions).mockReset();
    vi.mocked(hasOtherLiveSessions).mockReturnValue(false);
    vi.mocked(isBackendDownloaded).mockReset();
    vi.mocked(isBackendDownloaded).mockReturnValue(true);
  });

  it("is a no-op when autoUpdate is off", async () => {
    const result = await maybeAutoUpdateBackend("/tmp/data", {
      enabled: false,
    });
    expect(result).toEqual({ action: "skipped" });
    expect(checkForBackendUpdate).not.toHaveBeenCalled();
    expect(downloadBackend).not.toHaveBeenCalled();
  });

  it("does not download when the installed tag already matches latest", async () => {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: false,
      latestTag: "turboquant-07b9908",
      currentTag: "turboquant-07b9908",
    });

    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: true });
    expect(result).toEqual({
      action: "current",
      tag: "turboquant-07b9908",
    });
    expect(downloadBackend).not.toHaveBeenCalled();
    expect(stopChatAndEmbeddingDaemons).not.toHaveBeenCalled();
  });

  it("stops a running daemon then downloads when a newer tag exists", async () => {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: true,
      latestTag: "turboquant-07b9908",
      currentTag: "b10269-1.5.1",
    });
    vi.mocked(readRunningPid).mockReturnValue(4242);
    vi.mocked(stopChatAndEmbeddingDaemons).mockResolvedValue();
    vi.mocked(downloadBackend).mockResolvedValue({
      ok: true,
      tag: "turboquant-07b9908",
    });

    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: true });
    expect(result).toEqual({
      action: "updated",
      from: "b10269-1.5.1",
      to: "turboquant-07b9908",
    });
    expect(stopChatAndEmbeddingDaemons).toHaveBeenCalledWith("/tmp/data");
    expect(downloadBackend).toHaveBeenCalledTimes(1);
  });

  it("does not stop when nothing is running, then still downloads", async () => {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: true,
      latestTag: "turboquant-new",
      currentTag: null,
    });
    vi.mocked(readRunningPid).mockReturnValue(null);
    vi.mocked(downloadBackend).mockResolvedValue({
      ok: true,
      tag: "turboquant-new",
    });

    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: true });
    expect(result.action).toBe("updated");
    expect(stopChatAndEmbeddingDaemons).not.toHaveBeenCalled();
  });

  it("defers the download when another live session owns the running daemon", async () => {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: true,
      latestTag: "turboquant-new",
      currentTag: "old",
    });
    vi.mocked(readRunningPid).mockReturnValue(99);
    vi.mocked(hasOtherLiveSessions).mockReturnValue(true);

    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: true });
    expect(result).toEqual({ action: "deferred", reason: "other_session" });
    expect(stopChatAndEmbeddingDaemons).not.toHaveBeenCalled();
    expect(downloadBackend).not.toHaveBeenCalled();
  });

  it("folds a download failure into update_failed so start can continue", async () => {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: true,
      latestTag: "turboquant-new",
      currentTag: "turboquant-old",
    });
    vi.mocked(readRunningPid).mockReturnValue(4242);
    vi.mocked(stopChatAndEmbeddingDaemons).mockResolvedValue();
    vi.mocked(downloadBackend).mockRejectedValue(new Error("socket hang up"));
    // Staged install: the previous binary survives a failed download.
    vi.mocked(isBackendDownloaded).mockReturnValue(true);

    // The daemon has already been stopped at this point, so throwing
    // would leave the user with nothing running at all.
    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: true });
    expect(result).toEqual({
      action: "update_failed",
      error: "socket hang up",
      backendUsable: true,
    });
    expect(stopChatAndEmbeddingDaemons).toHaveBeenCalledWith("/tmp/data");
  });

  it("reports backendUsable false when nothing is left to start", async () => {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: true,
      latestTag: "turboquant-new",
      currentTag: null,
    });
    vi.mocked(readRunningPid).mockReturnValue(null);
    vi.mocked(downloadBackend).mockRejectedValue(new Error("disk full"));
    vi.mocked(isBackendDownloaded).mockReturnValue(false);

    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: true });
    expect(result).toEqual({
      action: "update_failed",
      error: "disk full",
      backendUsable: false,
    });
  });

  it("folds a daemon-stop failure into update_failed rather than throwing", async () => {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: true,
      latestTag: "turboquant-new",
      currentTag: "turboquant-old",
    });
    vi.mocked(readRunningPid).mockReturnValue(4242);
    vi.mocked(stopChatAndEmbeddingDaemons).mockRejectedValue(
      new Error("kill EPERM"),
    );

    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: true });
    expect(result).toEqual({
      action: "update_failed",
      error: "kill EPERM",
      backendUsable: true,
    });
    expect(downloadBackend).not.toHaveBeenCalled();
  });

  it("folds a GitHub check failure into check_failed so start can continue", async () => {
    vi.mocked(checkForBackendUpdate).mockRejectedValue(
      new Error("GitHub API rate-limited (HTTP 403)"),
    );

    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: true });
    expect(result).toEqual({
      action: "check_failed",
      error: "GitHub API rate-limited (HTTP 403)",
    });
    expect(downloadBackend).not.toHaveBeenCalled();
  });
});

/**
 * Backlog 39: every switch to the local model in the desktop runs a fresh
 * `models start`, so the process-wide release cache never helped and each
 * start asked GitHub (up to 5 s) before the model began to load. The
 * start paths pass `recheckAfterMs`: a recent answer for the build on
 * disk stands, whichever process got it.
 */
describe("maybeAutoUpdateBackend with recheckAfterMs (backlog 39)", () => {
  const INSTALLED = "turboquant-6df272c";
  let dataDir: string;
  let clock: number;
  const now = () => clock;
  const start = () =>
    maybeAutoUpdateBackend(dataDir, {
      enabled: true,
      recheckAfterMs: AUTO_UPDATE_RECHECK_MS,
      now,
    });
  const install = (tag: string, asset = resolveDownloadAsset().assetName) =>
    writeBackendVersion(dataDir, {
      tag,
      downloadedAt: new Date(clock).toISOString(),
      asset,
    });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-auto-update-"));
    clock = 1_790_909_708_032;
    install(INSTALLED);
    vi.mocked(checkForBackendUpdate).mockReset();
    vi.mocked(downloadBackend).mockReset();
    vi.mocked(readRunningPid).mockReset();
    vi.mocked(readRunningPid).mockReturnValue(null);
    vi.mocked(hasOtherLiveSessions).mockReturnValue(false);
    vi.mocked(isBackendDownloaded).mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function nothingNewer(): void {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: false,
      latestTag: INSTALLED,
      currentTag: INSTALLED,
    });
  }

  it("asks GitHub once, then trusts that answer for six hours", async () => {
    nothingNewer();
    expect(await start()).toEqual({ action: "current", tag: INSTALLED });
    const checkedAt = clock;
    clock += 60_000;
    expect(await start()).toEqual({ action: "recent", tag: INSTALLED, checkedAt });
    clock = checkedAt + AUTO_UPDATE_RECHECK_MS - 1;
    expect((await start()).action).toBe("recent");
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(1);
    clock = checkedAt + AUTO_UPDATE_RECHECK_MS;
    expect(await start()).toEqual({ action: "current", tag: INSTALLED });
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(2);
  });

  it("asks again once another build is on disk", async () => {
    nothingNewer();
    await start();
    install("turboquant-7a1c0de");
    await start();
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(2);
  });

  it("always asks while the machine wants another variant than the one installed", async () => {
    // The installed asset is not what this machine resolves (on Windows:
    // an NVIDIA driver installed since the Vulkan build) — an update in
    // itself, however recent the last check.
    install(INSTALLED, "llama-turboquant-some-other-variant.zip");
    nothingNewer();
    await start();
    clock += 60_000;
    await start();
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(2);
  });

  it("holds off a failed check for fifteen minutes, not six hours", async () => {
    vi.mocked(checkForBackendUpdate).mockRejectedValue(new Error("fetch failed"));
    expect(await start()).toEqual({ action: "check_failed", error: "fetch failed" });
    const failedAt = clock;
    clock += AUTO_UPDATE_RETRY_MS - 1;
    expect(await start()).toEqual({ action: "recent", tag: null, checkedAt: failedAt });
    clock = failedAt + AUTO_UPDATE_RETRY_MS;
    expect((await start()).action).toBe("check_failed");
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(2);
  });

  it("records the update it installed, so the next start does not ask", async () => {
    vi.mocked(checkForBackendUpdate).mockResolvedValue({
      updateAvailable: true,
      latestTag: "turboquant-7a1c0de",
      currentTag: INSTALLED,
    });
    vi.mocked(downloadBackend).mockImplementation(async () => {
      install("turboquant-7a1c0de");
      return { ok: true, tag: "turboquant-7a1c0de" };
    });
    expect((await start()).action).toBe("updated");
    clock += 60_000;
    expect((await start()).action).toBe("recent");
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(1);
  });

  it("remembers nothing and always asks without recheckAfterMs (models update, an explicit check)", async () => {
    nothingNewer();
    await maybeAutoUpdateBackend(dataDir, { enabled: true, now });
    await maybeAutoUpdateBackend(dataDir, { enabled: true, now });
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(2);
    expect(existsSync(resolveBackendCheckFilePath(dataDir))).toBe(false);
  });

  it("does not trust a check stamped in the future (a clock set back)", async () => {
    nothingNewer();
    await start();
    clock -= 60_000;
    await start();
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(2);
  });

  it("drops the record when the Models panel finds an update, so the next start asks and installs it", async () => {
    nothingNewer();
    await start();
    expect(existsSync(resolveBackendCheckFilePath(dataDir))).toBe(true);
    vi.mocked(checkForBackendUpdate).mockResolvedValueOnce({
      updateAvailable: true,
      latestTag: "turboquant-7a1c0de",
      currentTag: INSTALLED,
    });
    expect((await checkForBackendUpdateForPanel(dataDir)).updateAvailable).toBe(true);
    expect(existsSync(resolveBackendCheckFilePath(dataDir))).toBe(false);
    clock += 60_000;
    await start();
    // The first start, the panel, and this start: it did not answer `recent`.
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(3);
  });

  it("keeps the record when the Models panel finds nothing newer", async () => {
    nothingNewer();
    await start();
    expect((await checkForBackendUpdateForPanel(dataDir)).updateAvailable).toBe(false);
    clock += 60_000;
    expect((await start()).action).toBe("recent");
    expect(checkForBackendUpdate).toHaveBeenCalledTimes(2);
  });
});
