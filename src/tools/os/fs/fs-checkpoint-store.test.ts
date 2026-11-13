import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECKPOINT_MAX_ENTRIES,
  CHECKPOINT_MAX_FILE_BYTES,
  FileCheckpointStore,
  looksBinary,
} from "./fs-checkpoint-store.js";

describe("FileCheckpointStore (ATO-1056)", () => {
  let root: string;
  let work: string;
  let clock: number;
  let store: FileCheckpointStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aa-ckpt-root-"));
    work = mkdtempSync(join(tmpdir(), "aa-ckpt-work-"));
    clock = 1000;
    store = new FileCheckpointStore(root, () => clock);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("saves what a file held, and that a missing file did not exist", async () => {
    const a = join(work, "a.txt");
    writeFileSync(a, "before");
    await store.capture("s-1", a, "os.fs.write");
    clock = 2000;
    await store.capture("s-1", join(work, "new.txt"), "os.fs.write");

    const { entries, incomplete } = await store.since("s-1", 0);
    expect(incomplete).toBe(false);
    expect(entries.map((e) => [e.path, e.existed, e.at, e.tool])).toEqual([
      [a, true, 1000, "os.fs.write"],
      [join(work, "new.txt"), false, 2000, "os.fs.write"],
    ]);
    expect((await store.readCopy("s-1", entries[0]!)).toString("utf8")).toBe("before");
    expect(entries[1]!.file).toBeUndefined();
    // Another session sees nothing of it.
    expect((await store.since("s-2", 0)).entries).toEqual([]);
  });

  it("returns only the entries taken at or after the time asked for", async () => {
    const a = join(work, "a.txt");
    writeFileSync(a, "v1");
    await store.capture("s-1", a, "os.fs.edit");
    clock = 5000;
    writeFileSync(a, "v2");
    await store.capture("s-1", a, "os.fs.edit");
    const { entries } = await store.since("s-1", 5000);
    expect(entries).toHaveLength(1);
    expect((await store.readCopy("s-1", entries[0]!)).toString("utf8")).toBe("v2");
  });

  it("notes a folder, a binary file and a huge file without copying them", async () => {
    const dir = join(work, "folder");
    mkdirSync(dir);
    const bin = join(work, "img.bin");
    writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
    const huge = join(work, "huge.txt");
    writeFileSync(huge, Buffer.alloc(CHECKPOINT_MAX_FILE_BYTES + 1, 97));
    await store.capture("s-1", dir, "os.fs.move");
    await store.capture("s-1", bin, "os.fs.write");
    await store.capture("s-1", huge, "os.fs.write");
    const { entries } = await store.since("s-1", 0);
    expect(entries.map((e) => [e.skipped, e.existed, e.file])).toEqual([
      ["not_a_file", true, undefined],
      ["binary", true, undefined],
      ["too_large", true, undefined],
    ]);
  });

  it("drops the oldest past the entry cap and says a point before that is incomplete", async () => {
    const a = join(work, "a.txt");
    writeFileSync(a, "x");
    for (let i = 0; i < CHECKPOINT_MAX_ENTRIES + 2; i++) {
      clock = 1000 + i;
      await store.capture("s-1", a, "os.fs.edit");
    }
    const all = await store.since("s-1", 0);
    expect(all.entries).toHaveLength(CHECKPOINT_MAX_ENTRIES);
    expect(all.incomplete).toBe(true);
    // The two dropped were taken at 1000 and 1001.
    expect((await store.since("s-1", 1002)).incomplete).toBe(false);
    expect(existsSync(join(store.sessionDir("s-1"), "1.bin"))).toBe(false);
  });

  it("forgets the entries of removed turns and their copies", async () => {
    const a = join(work, "a.txt");
    writeFileSync(a, "one");
    await store.capture("s-1", a, "os.fs.write");
    clock = 3000;
    await store.capture("s-1", a, "os.fs.write");
    await store.dropSince("s-1", 3000);
    const { entries } = await store.since("s-1", 0);
    expect(entries.map((e) => e.at)).toEqual([1000]);
    expect(existsSync(join(store.sessionDir("s-1"), "2.bin"))).toBe(false);
    expect(readFileSync(join(store.sessionDir("s-1"), "1.bin"), "utf8")).toBe("one");
  });

  it("removes session folders untouched for a month on its first capture", async () => {
    const old = new FileCheckpointStore(root, () => Date.now());
    const a = join(work, "a.txt");
    writeFileSync(a, "x");
    await old.capture("s-old", a, "os.fs.write");
    const index = join(old.sessionDir("s-old"), "index.json");
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(index, longAgo, longAgo);
    const fresh = new FileCheckpointStore(root, () => Date.now());
    await fresh.capture("s-new", a, "os.fs.write");
    expect(existsSync(old.sessionDir("s-old"))).toBe(false);
    expect((await fresh.since("s-new", 0)).entries).toHaveLength(1);
  });

  it("never throws when the root cannot be written", async () => {
    const file = join(work, "not-a-dir");
    writeFileSync(file, "x");
    const broken = new FileCheckpointStore(join(file, "under"));
    await expect(broken.capture("s-1", file, "os.fs.write")).resolves.toBeUndefined();
  });

  it("calls a file with a NUL in its head binary", () => {
    expect(looksBinary(Buffer.from("plain text\n"))).toBe(false);
    expect(looksBinary(Buffer.from([65, 0, 66]))).toBe(true);
  });
});
