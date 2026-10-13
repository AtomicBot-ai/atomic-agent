// The Core the installer carries (desktop/main/core-bundle.ts
// BUNDLED_CORE_VERSION) must be the one the agent installs by default (its
// CORE_VERSION: the last of CORE_VERSIONS in src/local-llm/core/core-state.ts).
// scripts/fetch-core.mjs fails the build on a mismatch; this fails the tests.
// Run: npm run test:unit (reads both files as text; no build needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentCoreVersion, assertCoreVersionsMatch, bundledCoreVersion } from "../scripts/fetch-core.mjs";

test("the bundled Core is the agent's CORE_VERSION", () => {
  assert.equal(bundledCoreVersion(), agentCoreVersion(), "bump desktop/main/core-bundle.ts and src/local-llm/core/core-state.ts together");
  assert.doesNotThrow(() => assertCoreVersionsMatch());
});

test("the agent's version is the LAST of CORE_VERSIONS", () => {
  assert.equal(agentCoreVersion('export const CORE_VERSIONS = ["0.11.2", "0.13.6"] as const;'), "0.13.6");
  assert.throws(() => agentCoreVersion("export const CORE_VERSION = '1.0.0';"), /CORE_VERSIONS not found/);
});

test("a mismatch fails with both versions named", () => {
  assert.throws(() => assertCoreVersionsMatch("0.13.6", "0.14.0"), /0\.13\.6.*0\.14\.0/);
});
