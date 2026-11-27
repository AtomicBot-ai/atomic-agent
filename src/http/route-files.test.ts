import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileIndex } from "../tools/files/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";

// ATO-1621: the desktop's My files screen talks to these routes (contract w6-memory-files).
describe("/api/files routes", () => {
  let harness: Harness;
  let root: string;
  let docs: string;
  let index: FileIndex;

  beforeEach(async () => {
    harness = await startTestHarness();
    root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-http-files-")));
    docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "notes.md"), "The lease termination date is in March.");
    writeFileSync(join(root, "plain.txt"), "x");
    // The harness runtime opened its own index in its state dir; this one
    // lets temp folders through (they sit under /var on macOS).
    index = new FileIndex({
      dbFile: join(harness.stateDir, "routes-files-index.sqlite"),
      validation: { systemDirs: [], home: join(root, "home") },
    });
    (harness.runtime as { fileIndex?: FileIndex }).fileIndex = index;
  });

  afterEach(async () => {
    await index.close();
    await harness.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${harness.baseUrl}${path}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });

  it("adds, lists and removes a folder in the contract's shapes", async () => {
    const added = await call("POST", "/api/files/folders", { path: docs });
    expect(added.status).toBe(200);
    const { folder } = (await added.json()) as { folder: Record<string, unknown> };
    expect(folder).toEqual({ path: docs, name: "docs", fileCount: expect.any(Number), indexedCount: expect.any(Number), addedAt: expect.any(String) });
    expect(new Date(folder.addedAt as string).toISOString()).toBe(folder.addedAt);

    await index.idle();
    const listed = await call("GET", "/api/files/folders");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ folders: [expect.objectContaining({ path: docs, name: "docs", fileCount: 1, indexedCount: 1 })] });

    const removed = await call("DELETE", "/api/files/folders", { path: docs });
    expect(await removed.json()).toEqual({ removed: true });
    const again = await call("DELETE", "/api/files/folders", { path: docs });
    expect(await again.json()).toEqual({ removed: false });
    expect(await (await call("GET", "/api/files/folders")).json()).toEqual({ folders: [] });
  });

  it("reports status with the done condition the desktop reads", async () => {
    await call("POST", "/api/files/folders", { path: docs });
    await index.idle();
    const response = await call("GET", "/api/files/status");
    expect(response.status).toBe(200);
    const status = (await response.json()) as Record<string, unknown>;
    expect(status).toMatchObject({ running: false, found: 1, indexed: 1, failed: 0, skipped: 0 });
    expect(typeof status.updatedAt).toBe("string");
    expect(status.current).toBeUndefined();
    // ATO-2501: the desktop shows these two.
    expect(status.ocrPages).toBe(0);
    expect(status.skippedReasons).toEqual([]);
  });

  it("retries skipped files on POST /api/files/retry (ATO-2501)", async () => {
    writeFileSync(join(docs, "photo.png"), "not really a png");
    await call("POST", "/api/files/folders", { path: docs });
    await index.idle();
    const before = (await (await call("GET", "/api/files/status")).json()) as { skipped: number; skippedReasons: { reason: string; count: number }[] };
    expect(before.skipped).toBe(1);
    expect(before.skippedReasons).toEqual([{ reason: "disabled", count: 1 }]);
    const response = await call("POST", "/api/files/retry");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requeued: 1 });
    await index.idle();
    // Media is still off in this index, so the photo is skipped again.
    expect(((await (await call("GET", "/api/files/status")).json()) as { skipped: number }).skipped).toBe(1);
  });

  it("answers 400 with each folder error code", async () => {
    await call("POST", "/api/files/folders", { path: docs });
    const cases: Array<[unknown, string]> = [
      [{ path: "relative/docs" }, "not_absolute"],
      [{}, "not_absolute"],
      [{ path: "/" }, "too_broad"],
      [{ path: join(root, "missing") }, "not_found"],
      [{ path: join(root, "plain.txt") }, "not_a_directory"],
      [{ path: docs }, "already_added"],
    ];
    mkdirSync(join(docs, "inner"));
    cases.push([{ path: join(docs, "inner") }, "inside_added"]);
    for (const [body, code] of cases) {
      const response = await call("POST", "/api/files/folders", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      const payload = (await response.json()) as { error: { code: string; message: string } };
      expect(payload.error.code, JSON.stringify(body)).toBe(code);
      expect(payload.error.message.length).toBeGreaterThan(0);
    }
  });

  it("answers 501 on a runtime without a file index", async () => {
    (harness.runtime as { fileIndex?: FileIndex }).fileIndex = undefined;
    expect((await call("GET", "/api/files/folders")).status).toBe(501);
    expect((await call("POST", "/api/files/folders", { path: docs })).status).toBe(501);
    expect((await call("DELETE", "/api/files/folders", { path: docs })).status).toBe(501);
    expect((await call("GET", "/api/files/status")).status).toBe(501);
    expect((await call("POST", "/api/files/retry")).status).toBe(501);
    const caps = (await (await call("GET", "/api/capabilities")).json()) as { fileIndex: boolean };
    expect(caps.fileIndex).toBe(false);
  });

  it("advertises fileIndex in capabilities and offers files.search", async () => {
    const caps = (await (await call("GET", "/api/capabilities")).json()) as { fileIndex: boolean };
    expect(caps.fileIndex).toBe(true);
    expect(harness.runtime.toolRegistry.has("files.search")).toBe(true);
  });
});
