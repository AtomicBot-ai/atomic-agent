import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFileRestore, planFileRestore, uncoveredToolCalls } from "./fs-checkpoint-restore.js";
import { FileCheckpointStore } from "./fs-checkpoint-store.js";

describe("planFileRestore / applyFileRestore (ATO-1056)", () => {
  let root: string;
  let work: string;
  let clock: number;
  let store: FileCheckpointStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aa-rst-root-"));
    work = mkdtempSync(join(tmpdir(), "aa-rst-work-"));
    clock = 100;
    store = new FileCheckpointStore(root, () => clock);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  /** Save `path` as the tool would, then let the "tool" write `next` (null = leave it). */
  async function change(path: string, next: string | null): Promise<void> {
    await store.capture("s-1", path, "os.fs.write");
    if (next !== null) writeFileSync(path, next);
  }

  it("puts back the content before the point, removes files made after it, and skips untouched ones", async () => {
    const edited = join(work, "edited.txt");
    const created = join(work, "created.txt");
    const declined = join(work, "declined.txt");
    const earlier = join(work, "earlier.txt");
    writeFileSync(edited, "original");
    writeFileSync(declined, "same");
    writeFileSync(earlier, "e0");
    // Before the point (question at 200): not part of the rollback.
    await change(earlier, "e1");
    clock = 200;
    await change(edited, "edit 1");
    clock = 300;
    await change(edited, "edit 2");
    await change(created, "brand new");
    await change(declined, null);

    const plan = await planFileRestore(store, "s-1", 200);
    expect(plan.items.map((i) => [i.path, i.action])).toEqual([
      [edited, "restore"],
      [created, "delete"],
    ]);
    expect(plan.notRestorable).toEqual([]);
    expect(plan.incomplete).toBe(false);

    const done = await applyFileRestore(store, "s-1", plan);
    expect(done).toEqual({ restored: [edited], deleted: [created], failed: [] });
    expect(readFileSync(edited, "utf8")).toBe("original");
    expect(existsSync(created)).toBe(false);
    expect(readFileSync(earlier, "utf8")).toBe("e1");
  });

  it("brings back a file the agent removed, folder included", async () => {
    const dir = join(work, "deep", "er");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "notes.md");
    writeFileSync(file, "keep me");
    await change(file, null);
    rmSync(join(work, "deep"), { recursive: true });
    const plan = await planFileRestore(store, "s-1", 0);
    expect(plan.items.map((i) => i.action)).toEqual(["restore"]);
    await applyFileRestore(store, "s-1", plan);
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });

  it("lists files it has no copy of as not restorable", async () => {
    const bin = join(work, "photo.bin");
    writeFileSync(bin, Buffer.from([0, 1, 2]));
    await change(bin, "text now");
    const plan = await planFileRestore(store, "s-1", 0);
    expect(plan.items).toEqual([]);
    expect(plan.notRestorable).toEqual([{ path: bin, reason: "binary" }]);
  });

  it("reports a file it cannot write and carries on", async () => {
    const blocked = join(work, "blocked");
    const ok = join(work, "ok.txt");
    writeFileSync(ok, "ok0");
    await change(ok, "ok1");
    await store.capture("s-1", join(blocked, "inner.txt"), "os.fs.write");
    // A file now stands where the folder would go, so the write fails.
    writeFileSync(blocked, "a file, not a folder");
    const plan = await planFileRestore(store, "s-1", 0);
    plan.items.push({ path: join(blocked, "inner.txt"), action: "restore", entry: plan.items[0]!.entry });
    const done = await applyFileRestore(store, "s-1", plan);
    expect(done.restored).toEqual([ok]);
    expect(done.failed.map((f) => f.path)).toEqual([join(blocked, "inner.txt")]);
  });
});

describe("uncoveredToolCalls", () => {
  it("counts the calls whose file changes have no checkpoint", () => {
    const call = (tool: string) => ({ kind: "assistant_tool_call", tool });
    expect(
      uncoveredToolCalls([
        { kind: "user" },
        call("os.shell.run"),
        call("os.shell.run"),
        call("os.fs.write"),
        call("os.git.status"),
        call("os.git.commit"),
        call("os.fs.archive.extract"),
        call("fusion.delegate"),
        { kind: "tool_result", tool: "os.shell.run" },
      ]),
    ).toEqual([
      { tool: "os.shell.run", count: 2 },
      { tool: "os.git.commit", count: 1 },
      { tool: "os.fs.archive.extract", count: 1 },
      { tool: "fusion.delegate", count: 1 },
    ]);
  });
});
