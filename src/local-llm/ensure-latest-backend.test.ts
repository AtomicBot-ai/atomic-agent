import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./backend-installer.js", async () => {
  const actual =
    await vi.importActual<typeof import("./backend-installer.js")>(
      "./backend-installer.js",
    );
  return {
    ...actual,
    checkForBackendUpdate: vi.fn(),
    downloadBackend: vi.fn(),
    isBackendDownloaded: vi.fn(),
  };
});

vi.mock("./daemon-lifecycle.js", async () => {
  const actual =
    await vi.importActual<typeof import("./daemon-lifecycle.js")>(
      "./daemon-lifecycle.js",
    );
  return {
    ...actual,
    readRunningPid: vi.fn(),
    stopChatAndEmbeddingDaemons: vi.fn(),
  };
});

vi.mock("./session-registry.js", async () => {
  const actual =
    await vi.importActual<typeof import("./session-registry.js")>(
      "./session-registry.js",
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
} from "./daemon-lifecycle.js";
import { maybeAutoUpdateBackend } from "./ensure-latest-backend.js";
import { hasOtherLiveSessions } from "./session-registry.js";

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
    const result = await maybeAutoUpdateBackend("/tmp/data", { enabled: false });
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
