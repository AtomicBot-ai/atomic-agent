import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resetConfigCache } from "../config/index.js";
import { ATOMIC_CORE_EXPERIMENTAL_ENV } from "../local-llm/core/experimental.js";
import { modelsEngineCommand } from "./models-engine.js";

// The running-model guard probes real ports; the gate under test sits before it.
vi.mock("../local-llm/engine-selection.js", () => ({
  selectManagedEngine: vi.fn(async (_d: string, _c: number, _e: number, persist: () => void) => { persist(); }),
}));

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "models-engine-"));
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  delete process.env[ATOMIC_CORE_EXPERIMENTAL_ENV];
  resetConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ATOMIC_AGENT_STATE_DIR;
  delete process.env[ATOMIC_CORE_EXPERIMENTAL_ENV];
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

it("reports whether frontends may offer Atomic Chat", async () => {
  expect(await status()).toMatchObject({ engine: "llama-server", choiceEnabled: false });
  process.env[ATOMIC_CORE_EXPERIMENTAL_ENV] = "1";
  expect(await status()).toMatchObject({ engine: "llama-server", choiceEnabled: true });
});

async function choose(engine: string): Promise<number> {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try { return await modelsEngineCommand([engine]); } finally { out.mockRestore(); }
}

it("refuses atomic-core without the experimental opt-in, like the TUI", async () => {
  await expect(choose("atomic-core")).rejects.toThrow(`Set ${ATOMIC_CORE_EXPERIMENTAL_ENV}=1`);
  expect(await status()).toMatchObject({ engine: "llama-server" });
});

it("selects atomic-core with the opt-in, and always allows switching back", async () => {
  process.env[ATOMIC_CORE_EXPERIMENTAL_ENV] = "1";
  expect(await choose("atomic-core")).toBe(0);
  expect(await status()).toMatchObject({ engine: "atomic-core" });
  delete process.env[ATOMIC_CORE_EXPERIMENTAL_ENV];
  resetConfigCache();
  expect(await choose("llama-server")).toBe(0);
  expect(await status()).toMatchObject({ engine: "llama-server", choiceEnabled: false });
});
