/**
 * ATO-1348: `models update` refused because another process holds the
 * engine operation lock must leave Atomic Core alone. The lock's holder
 * (Studio putting Core in place, a model load) may have just started a Core
 * it is about to use; a retire right after the refusal pulled it out from
 * under that caller. Any other failure still retires an idle Core.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../local-llm/index.js", async () => ({
  ...(await vi.importActual<typeof import("../local-llm/index.js")>("../local-llm/index.js")),
  checkForBackendUpdate: vi.fn(async () => ({ updateAvailable: true, latestTag: "core-test", currentTag: null })),
  downloadBackend: vi.fn(),
}));

vi.mock("../local-llm/core/core-sessions.js", async () => ({
  ...(await vi.importActual<typeof import("../local-llm/core/core-sessions.js")>("../local-llm/core/core-sessions.js")),
  retireIdleCore: vi.fn(async () => false),
}));

vi.mock("../analytics/index.js", async () => ({
  ...(await vi.importActual<typeof import("../analytics/index.js")>("../analytics/index.js")),
  reportLocalEngineFailed: vi.fn(async () => {}),
}));

import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import * as localLlm from "../local-llm/index.js";
import { retireIdleCore } from "../local-llm/core/core-sessions.js";
import { isCoreOperationBusy, withCoreOperation } from "../local-llm/core/core-operation.js";
import { coreRoot } from "../local-llm/core/core-state.js";
import { runLocalModelsUpdate } from "./models-handlers.js";

describe("runLocalModelsUpdate when the engine is busy (ATO-1348)", () => {
  let stateDir: string;
  let stderrChunks: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-update-busy-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
        managed: { ...USER_CONFIG_DEFAULTS.localModels.managed, engine: "atomic-core" },
      },
    });
    resetConfigCache();
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.mocked(retireIdleCore).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  /** The refusal exactly as the install gets it: a live process (this one) holds the lock. */
  async function realBusyRefusal(): Promise<unknown> {
    const root = coreRoot(getConfig().paths.localModelsDataDir);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "operation.lock"), String(process.pid));
    const err = await withCoreOperation(getConfig().paths.localModelsDataDir, async () => undefined, { waitMs: 0 }).then(
      () => null,
      (e: unknown) => e,
    );
    rmSync(join(root, "operation.lock"), { force: true });
    return err;
  }

  it("leaves Core running and says why", async () => {
    const busy = await realBusyRefusal();
    expect(isCoreOperationBusy(busy)).toBe(true);
    vi.mocked(localLlm.downloadBackend).mockRejectedValueOnce(busy);

    await expect(runLocalModelsUpdate()).resolves.toBe(1);
    expect(retireIdleCore).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toMatch(/Another engine operation is running/);
  });

  it("still retires an idle Core after any other failure", async () => {
    vi.mocked(localLlm.downloadBackend).mockRejectedValueOnce(new Error("disk full"));

    await expect(runLocalModelsUpdate()).resolves.toBe(1);
    expect(retireIdleCore).toHaveBeenCalledTimes(1);
  });

  it("does not take an ordinary error for a busy engine", () => {
    expect(isCoreOperationBusy(new Error("Another engine operation is running. Wait for it to finish."))).toBe(false);
  });
});
