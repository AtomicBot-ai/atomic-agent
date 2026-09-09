import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  persistSessionRailOrder,
  readSessionRailOrder,
} from "./persist-session-rail.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

describe("persistSessionRailOrder", () => {
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

  it("writes the order to config.json and getConfig() picks it up", () => {
    expect(readSessionRailOrder()).toEqual([]);
    persistSessionRailOrder(["s-b", "s-a"]);
    const onDisk = JSON.parse(readFileSync(getConfig().paths.userConfigFile, "utf8"));
    expect(onDisk.tui.sessionRail.order).toEqual(["s-b", "s-a"]);
    expect(readSessionRailOrder()).toEqual(["s-b", "s-a"]);
  });

  it("replaces the previous order and leaves the rest of tui alone", () => {
    persistSessionRailOrder(["s-a"]);
    persistSessionRailOrder(["s-b", "s-a"]);
    expect(getConfig().tui.sessionRail.order).toEqual(["s-b", "s-a"]);
    expect(getConfig().tui.theme).toBe("auto");
    expect(getConfig().tui.mouse).toBe(true);
  });
});
