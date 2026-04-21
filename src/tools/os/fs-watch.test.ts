import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool-registry.js";
import { osFsWatchTool } from "./fs-watch.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("os.fs.watch", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-watch-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("captures a create event and returns early on stopAfterFirst", async () => {
    const file = join(dir, "new.txt");
    const watchPromise = osFsWatchTool.run(
      { path: ".", recursive: true, timeoutMs: 3000, stopAfterFirst: true },
      makeCtx(dir),
    );
    // Give the watcher a beat to boot before we mutate the tree.
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(file, "sacred\n", "utf8");
    const result = await watchPromise;

    expect(result.status).toBe("ok");
    expect(result.details.eventsReceived).toBeGreaterThanOrEqual(1);
    expect(result.details.timedOut).toBe(false);
    const events = result.details.events as { kind: string; path: string }[];
    expect(events.some((e) => e.kind === "add" && e.path === "new.txt")).toBe(true);
  });

  it("captures change events on an existing file", async () => {
    const file = join(dir, "live.txt");
    await writeFile(file, "one\n", "utf8");
    const watchPromise = osFsWatchTool.run(
      { path: "live.txt", timeoutMs: 2000 },
      makeCtx(dir),
    );
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(file, "two\n", "utf8");
    const result = await watchPromise;

    const events = result.details.events as { kind: string }[];
    expect(events.some((e) => e.kind === "change")).toBe(true);
  });

  it("times out cleanly when nothing changes", async () => {
    const result = await osFsWatchTool.run(
      { path: ".", timeoutMs: 300 },
      makeCtx(dir),
    );
    expect(result.details.timedOut).toBe(true);
    expect(result.details.eventsReceived).toBe(0);
    expect(result.summary).toContain("no events");
  });

  it("rejects timeout beyond the cap", async () => {
    await expect(
      osFsWatchTool.run(
        { path: ".", timeoutMs: 120_000 },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/cap/);
  });

  it("respects the events filter", async () => {
    const file = join(dir, "stuff.txt");
    await writeFile(file, "x", "utf8");
    const watchPromise = osFsWatchTool.run(
      { path: ".", recursive: true, timeoutMs: 1500, events: ["unlink"] },
      makeCtx(dir),
    );
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(file, "y", "utf8");
    await unlink(file);
    const result = await watchPromise;

    const events = result.details.events as { kind: string }[];
    expect(events.every((e) => e.kind === "unlink")).toBe(true);
  });
});
