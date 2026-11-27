import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUserConfigFileSync } from "../config/config-file.js";
import {
  DEFAULT_MODEL_SHARE_PORT,
  isModelShareMode,
  modelShareSettingsOf,
  readModelShareSettings,
  writeModelShareMode,
} from "./model-share-settings.js";

/** ATO-2483: off / local / network, as the config file holds them. */
describe("model share settings", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "model-share-settings-"));
    path = join(dir, "config.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads off, local and network from share and shareNetwork, port 8787 by default", () => {
    expect(modelShareSettingsOf(undefined)).toEqual({ mode: "off", port: DEFAULT_MODEL_SHARE_PORT });
    expect(modelShareSettingsOf({ share: false, shareNetwork: true })).toEqual({ mode: "off", port: 8787 });
    expect(modelShareSettingsOf({ share: true })).toEqual({ mode: "local", port: 8787 });
    expect(modelShareSettingsOf({ share: true, shareNetwork: true, sharePort: 9000 })).toEqual({ mode: "network", port: 9000 });
  });

  it("knows only the three modes", () => {
    expect(["off", "local", "network"].every(isModelShareMode)).toBe(true);
    expect(isModelShareMode("lan")).toBe(false);
    expect(isModelShareMode(true)).toBe(false);
  });

  it("writes each mode, and turning sharing off forgets the network choice", () => {
    writeModelShareMode(path, "network");
    expect(readUserConfigFileSync(path)?.localModels.managed).toMatchObject({ share: true, shareNetwork: true });
    expect(readModelShareSettings(path).mode).toBe("network");

    writeModelShareMode(path, "off");
    const off = readUserConfigFileSync(path)?.localModels.managed;
    expect(off?.share).toBe(false);
    expect(off?.shareNetwork).toBeUndefined();

    // On again without asking for the network: this computer only.
    writeModelShareMode(path, "local");
    expect(readModelShareSettings(path).mode).toBe("local");
    expect(readUserConfigFileSync(path)?.localModels.managed.shareNetwork).toBeUndefined();
  });

  it("reads a file that is not there as off", () => {
    expect(readModelShareSettings(join(dir, "missing", "config.json")).mode).toBe("off");
  });
});
