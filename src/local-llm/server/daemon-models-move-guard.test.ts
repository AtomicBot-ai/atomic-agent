import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireModelsDirMoveLock } from "../models-dir-move-lock.js";
import {
  startDaemon,
  startEmbeddingDaemon,
  type DaemonStartOptions,
  type EmbeddingDaemonStartOptions,
} from "./daemon-lifecycle.js";

/**
 * ATO-2503: no model start while `models dir` moves the models folder,
 * so a desktop auto-restart cannot load a half-copied GGUF. The check
 * comes first, before any port, binary or model probe.
 */
describe("model starts during a models folder move", () => {
  let dataDir: string;
  let release: () => void;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-daemon-move-guard-"));
    release = acquireModelsDirMoveLock(dataDir);
  });
  afterEach(() => {
    release();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses the chat model start", async () => {
    const opts = { dataDir, modelId: "qwen-3.5-4b", port: 1 } as unknown as DaemonStartOptions;
    await expect(startDaemon(opts)).rejects.toThrow(/being moved to another folder/);
  });

  it("refuses the embedding model start", async () => {
    const opts = { dataDir, modelId: "embeddinggemma-300m", port: 1 } as unknown as EmbeddingDaemonStartOptions;
    await expect(startEmbeddingDaemon(opts)).rejects.toThrow(/being moved to another folder/);
  });
});
