import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resetConfigCache } from "./config-cache.js";
import { ensureUserConfigFileSync, getUserConfigPath, writeUserConfigFileSync } from "./config-file.js";
import { ConfigValidationError } from "./config-validation-error.js";
import { getConfig } from "./index.js";
import { bindProjectPersonaInConfig, setActivePersonaInConfig } from "./persona-commands.js";

describe("persona config writers (ATO-54)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-personas-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    const path = getUserConfigPath(stateDir);
    const file = ensureUserConfigFileSync(path);
    writeUserConfigFileSync(path, {
      ...file,
      agent: {
        ...file.agent,
        personas: {
          projects: {},
          definitions: { reviewer: { instructions: "Review first." } },
        },
      },
    });
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  function onDisk(): { agent: { personas?: Record<string, unknown> } } {
    return JSON.parse(readFileSync(getUserConfigPath(stateDir), "utf8")) as {
      agent: { personas?: Record<string, unknown> };
    };
  }

  it("sets and clears the active persona", () => {
    setActivePersonaInConfig("reviewer");
    expect(getConfig().agent.personas?.active).toBe("reviewer");
    expect(onDisk().agent.personas?.active).toBe("reviewer");
    setActivePersonaInConfig("default");
    expect(getConfig().agent.personas?.active).toBeUndefined();
    expect(onDisk().agent.personas).not.toHaveProperty("active");
  });

  it("refuses a persona that is not defined and leaves the file alone", () => {
    expect(() => setActivePersonaInConfig("ghost")).toThrow(ConfigValidationError);
    expect(() => setActivePersonaInConfig("ghost")).toThrow(/defined: reviewer/);
    expect(onDisk().agent.personas).not.toHaveProperty("active");
  });

  it("binds and unbinds a folder, stored resolved", () => {
    const dir = bindProjectPersonaInConfig(join(stateDir, "repo", ".."), "reviewer");
    expect(dir).toBe(resolve(stateDir));
    expect(getConfig().agent.personas?.projects).toEqual({ [resolve(stateDir)]: "reviewer" });
    bindProjectPersonaInConfig(stateDir, "default");
    expect(getConfig().agent.personas?.projects).toEqual({});
  });
});
