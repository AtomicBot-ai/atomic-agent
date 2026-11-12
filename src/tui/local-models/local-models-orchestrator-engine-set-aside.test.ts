import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../local-llm/engine-selection.js", () => ({
  // The real guard probes ports and takes the engine lock; only its persist step matters here.
  selectManagedEngine: vi.fn(async (_dir: string, _chat: number, _emb: number, persist: () => void) => persist()),
}));

import { getUserConfigPath } from "../../config/config-file.js";
import { setConfigNoticeSink } from "../../config/config-primitives.js";
import { USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "../../config/config-schema.js";
import { resetConfigCache } from "../../config/index.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

/* ATO-1265: a newer build's engine reads here as atomic-core; picking Atomic Chat must still write it. */
let stateDir: string;
let path: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "local-models-engine-set-aside-"));
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  setConfigNoticeSink(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  path = getUserConfigPath(stateDir);
  const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
  tree.version = USER_CONFIG_VERSION;
  tree.localModels.managed = { ...tree.localModels.managed, engine: "atomic-core-next", backendVariant: "future-gpu" };
  writeFileSync(path, JSON.stringify(tree));
  resetConfigCache();
});
afterEach(() => {
  setConfigNoticeSink(null);
  delete process.env.ATOMIC_AGENT_STATE_DIR;
  resetConfigCache();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

it("choosing Atomic Chat over a newer build's engine writes atomic-core and keeps the variant", async () => {
  const emitted: Array<{ type: string; text?: string }> = [];
  const orchestrator = new LocalModelsOrchestrator({ emit: (a: unknown) => { emitted.push(a as { type: string; text?: string }); }, subscribe: () => () => {} });
  vi.spyOn(orchestrator as unknown as { refresh: () => Promise<void> }, "refresh").mockResolvedValue();
  await expect(orchestrator.chooseEngine("atomic-core")).resolves.toBe(true);
  expect(emitted.some(a => a.type === "composer_notice" && a.text === "Atomic Chat is already selected.")).toBe(false);
  const managed = (JSON.parse(readFileSync(path, "utf8")) as { localModels: { managed: Record<string, unknown> } }).localModels.managed;
  expect(managed.engine).toBe("atomic-core");
  expect(managed.backendVariant).toBe("future-gpu");
});
