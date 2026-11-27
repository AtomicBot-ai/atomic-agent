import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { missingModelError, ModelsDirUnreachableError, assertModelsDirUsable } from "./models-dir-guard.js";
import { acquireModelsDirMoveLock } from "./models-dir-move-lock.js";
import { getModelsDirOverride, setModelsDirOverride, unreachableModelsDir } from "./models-dir-override.js";

describe("models folder override follows the config file (ATO-2503)", () => {
  let root: string;
  let file: string;
  let named: string | null;
  let reads: number;
  const source = () => ({
    file,
    read: () => {
      reads += 1;
      return named;
    },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-models-override-"));
    file = join(root, "config.json");
    writeFileSync(file, "{}");
    named = null;
    reads = 0;
  });
  afterEach(() => {
    setModelsDirOverride(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the pushed value while the file is unchanged", () => {
    setModelsDirOverride("/a", source());
    expect(getModelsDirOverride()).toBe("/a");
    expect(getModelsDirOverride()).toBe("/a");
    expect(reads).toBe(0);
  });

  it("reads the key again once another process rewrote the file", () => {
    setModelsDirOverride(null, source());
    named = join(root, "external");
    writeFileSync(file, JSON.stringify({ moved: true }));
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(getModelsDirOverride()).toBe(join(root, "external"));
    expect(reads).toBe(1);
  });

  it("keeps the last folder when the re-read throws", () => {
    setModelsDirOverride("/kept", {
      file,
      read: () => {
        throw new Error("half written");
      },
    });
    writeFileSync(file, "{ broken");
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(getModelsDirOverride()).toBe("/kept");
  });

  it("without a source never reads anything", () => {
    setModelsDirOverride("/plain");
    expect(getModelsDirOverride()).toBe("/plain");
  });
});

describe("unplugged models folder (ATO-2503)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-models-unplugged-"));
  });
  afterEach(() => {
    setModelsDirOverride(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("is reachable with the default folder or an existing override", () => {
    expect(unreachableModelsDir()).toBeNull();
    const there = join(root, "models");
    mkdirSync(there);
    setModelsDirOverride(there);
    expect(unreachableModelsDir()).toBeNull();
    expect(() => assertModelsDirUsable(root)).not.toThrow();
    expect(missingModelError("not downloaded").message).toBe("not downloaded");
  });

  it("names the missing folder instead of 'not downloaded'", () => {
    const gone = join(root, "Volumes", "USB", "models");
    setModelsDirOverride(gone);
    expect(unreachableModelsDir()).toBe(gone);
    const err = missingModelError("model x not downloaded");
    expect(err).toBeInstanceOf(ModelsDirUnreachableError);
    expect(err.message).toContain(gone);
    expect(err.message).toContain("is its disk connected?");
    expect(() => assertModelsDirUsable(root)).toThrow(ModelsDirUnreachableError);
  });

  it("refuses a download while a move holds the marker", () => {
    const release = acquireModelsDirMoveLock(root);
    try {
      expect(() => assertModelsDirUsable(root)).toThrow(/being moved/);
    } finally {
      release();
    }
  });
});
