import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import {
  formatShellGuardRules,
  persistShellGuardRules,
} from "./persist-shell-guard.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

describe("persistShellGuardRules", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "shell-guard-persist-"));
    mkdirSync(stateDir, { recursive: true });
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalEnv;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes deny/allow to config.json and getConfig() picks them up", () => {
    expect(getConfig().shellGuard).toEqual({ deny: [], allow: [] });
    persistShellGuardRules({
      deny: ["npm publish"],
      allow: ["npm run *", "git status"],
    });
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.shellGuard).toEqual({
      deny: ["npm publish"],
      allow: ["npm run *", "git status"],
    });
    // The cache reset is the point: the guard's live predicate reads
    // through getConfig(), so a rule lands without a restart.
    expect(getConfig().shellGuard).toEqual({
      deny: ["npm publish"],
      allow: ["npm run *", "git status"],
    });
  });

  it("leaves the rest of the config file alone", () => {
    persistShellGuardRules({ deny: ["rm -rf *"], allow: [] });
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.log).toEqual({ level: "info" });
    expect(onDisk.git).toEqual({ remoteSync: false });
    expect(onDisk.version).toBeGreaterThan(0);
  });
});

describe("formatShellGuardRules", () => {
  it("renders deny before allow with the patterns verbatim", () => {
    const text = formatShellGuardRules({
      deny: ["npm publish", "rm -rf *"],
      allow: ["npm run *"],
    });
    expect(text).toContain("deny   npm publish");
    expect(text).toContain("deny   rm -rf *");
    expect(text).toContain("allow  npm run *");
    expect(text.indexOf("npm publish")).toBeLessThan(
      text.indexOf("npm run *"),
    );
  });

  it("says there is nothing rather than answering with silence", () => {
    expect(formatShellGuardRules({ deny: [], allow: [] })).toContain(
      "no shell guard rules",
    );
  });
});
