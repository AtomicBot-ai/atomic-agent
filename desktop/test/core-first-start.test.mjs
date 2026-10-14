// Unit tests for the first start under Atomic Chat Core (main/agent-cli.ts),
// against the built output.
// Run: npm run build && npm run test:unit
// A `models start` that may install Core's backend first gets a longer time
// limit than a plain model load, and an embedding start never begins while
// that backend is missing (it would install it inside its 60 s cap).
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// The app's state dir, throwaway: set before agent-cli loads.
const home = mkdtempSync(join(tmpdir(), "core-first-start-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
after(() => rmSync(home, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const cli = require("../out/main/agent-cli.js");
const { BUNDLED_CORE_VERSION } = require("../out/main/core-bundle.js");

const models = join(home, "models");
const EXE = process.platform === "win32" ? "atomic-chat-core.exe" : "atomic-chat-core";

function config(engine, extra = {}) {
  writeFileSync(join(home, "config.json"), JSON.stringify({ localModels: { mode: "managed", managed: { ...(engine ? { engine } : {}), ...extra } } }));
}
function installCore(version, { backend = true } = {}) {
  const dir = join(models, "core", "versions", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, EXE), "core\n");
  writeFileSync(join(models, "core", "active.json"), JSON.stringify({ version }));
  if (backend) {
    const bin = join(dir, "llama-server");
    writeFileSync(bin, "llama\n");
    writeFileSync(join(dir, "backend.json"), JSON.stringify({ coreVersion: version, binary: bin }));
  }
}
beforeEach(() => rmSync(models, { recursive: true, force: true }));

test("Core with no backend on disk: the start may install, so it gets the long limit", () => {
  config("atomic-core");
  assert.equal(cli.backendInstalled(), false);
  assert.equal(cli.coreInstallMayRun(), true);
  assert.equal(cli.startTimeoutMs(), cli.START_WITH_INSTALL_TIMEOUT_MS);
  assert.ok(cli.START_WITH_INSTALL_TIMEOUT_MS >= 15 * 60_000);
});

test("no engine named is Core too (the default)", () => {
  config(null);
  assert.equal(cli.managedEngineNow(), "atomic-core");
  assert.equal(cli.coreInstallMayRun(), true);
});

test("the seeded binary alone is not enough: its backend still has to come down", () => {
  config("atomic-core");
  installCore(BUNDLED_CORE_VERSION, { backend: false });
  assert.equal(cli.coreInstallMayRun(), true);
});

test("Core installed with its backend, at the version this build carries: a plain model load", () => {
  config("atomic-core");
  installCore(BUNDLED_CORE_VERSION);
  assert.equal(cli.backendInstalled(), true);
  assert.equal(cli.coreInstallMayRun(), false);
  assert.equal(cli.startTimeoutMs(), cli.START_TIMEOUT_MS);
});

test("an older Core active after a version bump: the start may install the new one", () => {
  config("atomic-core");
  installCore("0.0.1");
  assert.equal(cli.coreInstallMayRun(), true);
});

test("an older Core active with engine updates off: the agent keeps it, so a plain model load", () => {
  config("atomic-core", { autoUpdate: false });
  installCore("0.0.1");
  assert.equal(cli.managedAutoUpdateNow(), false);
  assert.equal(cli.coreInstallMayRun(), false);
  assert.equal(cli.startTimeoutMs(), cli.START_TIMEOUT_MS);
});

test("updates off still installs a missing backend first", () => {
  config("atomic-core", { autoUpdate: false });
  assert.equal(cli.coreInstallMayRun(), true);
});

test("llama.cpp never gets the long limit", () => {
  config("llama-server");
  assert.equal(cli.coreInstallMayRun(), false);
  assert.equal(cli.startTimeoutMs(), cli.START_TIMEOUT_MS);
});

test("an embedding start waits while Core's backend is missing: nothing is spawned", async () => {
  config("atomic-core");
  const r = await cli.modelsStartEmbedding();
  assert.equal(r.notStarted, true);
  assert.equal(r.error, cli.EMBEDDING_WAITS_FOR_ENGINE);
});
