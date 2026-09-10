import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  persistSessionRailLayout,
  readSessionRailLayout,
} from "./persist-session-rail.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

describe("persistSessionRailLayout", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "session-rail-persist-"));
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

  it("writes order and pinned to config.json and getConfig() picks them up", () => {
    expect(readSessionRailLayout()).toEqual({ order: [], pinned: [] });
    persistSessionRailLayout({ order: ["s-b", "s-a"], pinned: ["s-a"] });
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.tui.sessionRail).toEqual({
      order: ["s-b", "s-a"],
      pinned: ["s-a"],
    });
    expect(readSessionRailLayout()).toEqual({
      order: ["s-b", "s-a"],
      pinned: ["s-a"],
    });
  });

  it("replaces the previous layout and leaves the rest of tui alone", () => {
    persistSessionRailLayout({ order: ["s-a"], pinned: ["s-a"] });
    persistSessionRailLayout({ order: ["s-b", "s-a"], pinned: [] });
    expect(getConfig().tui.sessionRail).toEqual({
      order: ["s-b", "s-a"],
      pinned: [],
    });
    expect(getConfig().tui.theme).toBe("auto");
    expect(getConfig().tui.mouse).toBe(true);
  });
});
