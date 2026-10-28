import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../backend/macos-min-version.js", async () => {
  const actual = await vi.importActual<typeof import("../backend/macos-min-version.js")>(
    "../backend/macos-min-version.js",
  );
  return {
    ...actual,
    assertBackendRunsOnThisMac: vi.fn((binPath: string) => {
      throw new actual.MacosTooOldError(`too old for ${binPath}`, { major: 26, minor: 0 }, { major: 15, minor: 6 });
    }),
  };
});

import { resolvePlatformAsset } from "../backend/platform-assets.js";
import { MacosTooOldError, assertBackendRunsOnThisMac } from "../backend/macos-min-version.js";
import { resolveServerBinPath } from "../backend-paths.js";
import { startDaemon, startEmbeddingDaemon } from "./daemon-lifecycle.js";

/**
 * ATO-116 wiring: both start paths ask about the macOS minimum of the
 * binary they are about to spawn, before anything is spawned.
 */
describe("the macOS minimum check on the start paths", () => {
  let dataDir: string | undefined;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  function installedBinary(): string {
    dataDir = mkdtempSync(join(tmpdir(), "macos-min-start-"));
    const binPath = resolveServerBinPath(dataDir, resolvePlatformAsset().binaryName, "llama-server");
    mkdirSync(dirname(binPath), { recursive: true });
    writeFileSync(binPath, "");
    return binPath;
  }

  it("the chat start refuses before the spawn", async () => {
    const binPath = installedBinary();
    await expect(
      startDaemon({ dataDir: dataDir!, modelId: "qwen-3.5-4b" as never, port: 0, engine: "llama-server" } as never),
    ).rejects.toBeInstanceOf(MacosTooOldError);
    expect(assertBackendRunsOnThisMac).toHaveBeenCalledWith(binPath);
  });

  it("the embedding start refuses before the spawn", async () => {
    const binPath = installedBinary();
    await expect(
      startEmbeddingDaemon({ dataDir: dataDir!, modelId: "jina-embeddings-v2-base-en" as never, port: 0, engine: "llama-server" } as never),
    ).rejects.toBeInstanceOf(MacosTooOldError);
    expect(assertBackendRunsOnThisMac).toHaveBeenCalledWith(binPath);
  });
});
