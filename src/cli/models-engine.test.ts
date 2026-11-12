import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getUserConfigPath } from "../config/config-file.js";
import { setConfigNoticeSink } from "../config/config-primitives.js";
import { USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "../config/config-schema.js";
import { resetConfigCache } from "../config/index.js";
import { modelsEngineCommand } from "./models-engine.js";

// The running-model guard probes real ports; the gate under test sits before it.
vi.mock("../local-llm/engine-selection.js", () => ({
  selectManagedEngine: vi.fn(async (_d: string, _c: number, _e: number, persist: () => void) => { persist(); }),
}));

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "models-engine-"));
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  resetConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ATOMIC_AGENT_STATE_DIR;
  resetConfigCache();
  rmSync(stateDir, { recursive: true, force: true });
});

async function status(): Promise<Record<string, unknown>> {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await modelsEngineCommand(["status"])).toBe(0);
  const line = String(out.mock.calls.at(-1)?.[0]);
  out.mockRestore();
  return JSON.parse(line) as Record<string, unknown>;
}

it("reports Atomic Chat as the default engine, always offered", async () => {
  expect(await status()).toMatchObject({ engine: "atomic-core", choiceEnabled: true });
});

async function choose(engine: string): Promise<number> {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try { return await modelsEngineCommand([engine]); } finally { out.mockRestore(); }
}

it("switches to llama.cpp and back without any opt-in", async () => {
  expect(await choose("llama-server")).toBe(0);
  expect(await status()).toMatchObject({ engine: "llama-server", choiceEnabled: true });
  resetConfigCache();
  expect(await choose("atomic-core")).toBe(0);
  expect(await status()).toMatchObject({ engine: "atomic-core" });
});

/* ATO-1265: a newer build's engine reads here as atomic-core; `models engine atomic-core` is still a choice. */
it("writes atomic-core over a newer build's engine when it is picked here", async () => {
  const path = getUserConfigPath(stateDir);
  const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
  tree.version = USER_CONFIG_VERSION;
  tree.localModels.managed = { ...tree.localModels.managed, engine: "atomic-core-next", backendVariant: "future-gpu" };
  writeFileSync(path, JSON.stringify(tree));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  setConfigNoticeSink(() => {});
  try {
    resetConfigCache();
    expect(await status()).toMatchObject({ engine: "atomic-core" });
    expect(await choose("atomic-core")).toBe(0);
    const managed = (JSON.parse(readFileSync(path, "utf8")) as { localModels: { managed: Record<string, unknown> } }).localModels.managed;
    expect(managed.engine).toBe("atomic-core");
    expect(managed.backendVariant).toBe("future-gpu");
  } finally {
    setConfigNoticeSink(null);
  }
});
