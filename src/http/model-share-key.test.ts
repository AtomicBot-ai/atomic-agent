import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serveApiKeyPath } from "../cli/serve-api-key.js";
import {
  ensureModelShareKey,
  MODEL_SHARE_KEY_FILE,
  modelShareKeyPath,
  readModelShareKey,
  rotateModelShareKey,
} from "./model-share-key.js";

/** ATO-2336: the share key is its own owner-only file, apart from serve's key. */
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "model-share-key-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("model share key", () => {
  it("is absent until made, then the same key on every read", () => {
    expect(readModelShareKey(stateDir)).toBeNull();
    const key = ensureModelShareKey(stateDir);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureModelShareKey(stateDir)).toBe(key);
    expect(readModelShareKey(stateDir)).toBe(key);
  });

  it("lives in its own file, not the serve API key's", () => {
    expect(modelShareKeyPath(stateDir)).toBe(join(stateDir, MODEL_SHARE_KEY_FILE));
    expect(modelShareKeyPath(stateDir)).not.toBe(serveApiKeyPath(stateDir));
  });

  it.skipIf(process.platform === "win32")("is readable by its owner only", () => {
    ensureModelShareKey(stateDir);
    expect(statSync(modelShareKeyPath(stateDir)).mode & 0o777).toBe(0o600);
  });

  it("rotates to a new key that replaces the old one", () => {
    const before = ensureModelShareKey(stateDir);
    const after = rotateModelShareKey(stateDir);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    expect(readModelShareKey(stateDir)).toBe(after);
    if (process.platform !== "win32") {
      expect(statSync(modelShareKeyPath(stateDir)).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates into a state dir that has no key yet", () => {
    const key = rotateModelShareKey(stateDir);
    expect(key).not.toBeNull();
    expect(readModelShareKey(stateDir)).toBe(key);
  });
});
