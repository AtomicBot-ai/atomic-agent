import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache, USER_CONFIG_VERSION } from "../../config/index.js";
import { writeTelegramSettings } from "./telegram-settings.js";

// ATO-768: one of the in-process writers that read config.json, patch a
// block and write the whole file back. A newer build's keys must survive.
describe("writeTelegramSettings on a file from a newer build", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-telegram-settings-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("keeps the newer build's nested keys and version", () => {
    const userConfigPath = join(dir, "config.json");
    const newer = USER_CONFIG_VERSION + 1;
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        version: newer,
        memory: { futureKey: 1 },
        telegram: { enabled: false, futureFlag: "x" },
      }),
    );

    const saved = writeTelegramSettings(
      { userConfigPath, stateDir: dir },
      { enabled: true },
    );

    expect(saved.enabled).toBe(true);
    const onDisk = JSON.parse(readFileSync(userConfigPath, "utf8"));
    expect(onDisk.telegram.enabled).toBe(true);
    expect(onDisk.telegram.futureFlag).toBe("x");
    expect(onDisk.memory.futureKey).toBe(1);
    expect(onDisk.version).toBe(newer);
  });
});
