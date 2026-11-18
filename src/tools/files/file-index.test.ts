import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EmbeddingUnavailableError, type EmbeddingClient } from "../../memory/embeddings/embedding-client.js";
import type { Extractor } from "../os/read-document/index.js";
import { FileIndex, type FileIndexOptions } from "./file-index.js";
import { FolderRejectedError } from "./file-index-types.js";
import { isIndexDone, statusFrom } from "./file-indexer.js";
import { extractFileText } from "./file-text.js";
import { walkFolder } from "./file-walker.js";

let root: string;
let docs: string;
let index: FileIndex | null = null;
let reads: string[];

/** Three "pages" in the PDF extractor's own output format. */
const fakePdf: Extractor = async () => ({
  format: "pdf",
  text: "--- page 1 ---\nCover page.\n\n--- page 2 ---\nTermination needs thirty days notice.\n\n--- page 3 ---\nSignatures.",
  pageCount: 3,
  warnings: [],
  textLayer: { status: "ok", pagesChecked: 3, pagesWithoutText: [], ocrNeeded: false },
});

function open(extra: Partial<FileIndexOptions> = {}): FileIndex {
  index = new FileIndex({
    dbFile: join(root, "state", "files-index.sqlite"),
    // Temp folders are under `/var` on macOS, a system folder.
    validation: { systemDirs: [], home: join(root, "home") },
    extract: (path, signal) => {
      reads.push(path);
      return extractFileText(path, { signal, extractors: { pdf: fakePdf } });
    },
    ...extra,
  });
  return index;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-file-index-")));
  docs = join(root, "docs");
  mkdirSync(join(docs, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(docs, ".hidden"), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(join(docs, "contract.pdf"), "%PDF fake");
  writeFileSync(join(docs, "notes.md"), "# Notes\nThe lease termination date is in March.");
  writeFileSync(join(docs, "photo.png"), "not really a png");
  writeFileSync(join(docs, "script.ts"), "export const termination = 1;");
  writeFileSync(join(docs, "node_modules", "pkg", "readme.md"), "termination inside node_modules");
  writeFileSync(join(docs, ".hidden", "secret.md"), "termination inside a hidden folder");
  reads = [];
});

afterEach(async () => {
  await index?.close();
  index = null;
  rmSync(root, { recursive: true, force: true });
});

describe("FileIndex: add a folder, index it, search it", () => {
  it("indexes supported files, skips media when off, ignores node_modules, hidden and code", async () => {
    const fileIndex = open();
    const folder = await fileIndex.addFolder(docs);
    expect(folder).toMatchObject({ path: docs, name: "docs" });
    await fileIndex.idle();
    const status = fileIndex.status();
    expect(status).toMatchObject({ running: false, found: 3, indexed: 2, failed: 0, skipped: 1 });
    expect(status.current).toBeUndefined();
    expect(isIndexDone(status)).toBe(true);
    expect(fileIndex.listFolders()).toEqual([expect.objectContaining({ path: docs, fileCount: 3, indexedCount: 2 })]);
    expect(reads.sort()).toEqual([join(docs, "contract.pdf"), join(docs, "notes.md"), join(docs, "photo.png")].sort());
  });

  it("finds the PDF page and hands back a ready citation", async () => {
    const fileIndex = open();
    await fileIndex.addFolder(docs);
    await fileIndex.idle();
    const hits = await fileIndex.search({ query: "thirty days notice" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: join(docs, "contract.pdf"), page: 2 });
    expect(hits[0]!.cite).toBe(`[contract.pdf, p. 2](file://${join(docs, "contract.pdf")}#page=2)`);
    const both = await fileIndex.search({ query: "termination" });
    expect(both.map((hit) => hit.path).sort()).toEqual([join(docs, "contract.pdf"), join(docs, "notes.md")].sort());
    const notes = both.find((hit) => hit.path.endsWith("notes.md"))!;
    expect(notes.page).toBeUndefined();
    expect(notes.cite).toBe(`[notes.md](file://${join(docs, "notes.md")})`);
  });

  it("re-reads only what changed, and drops what vanished", async () => {
    const fileIndex = open();
    await fileIndex.addFolder(docs);
    await fileIndex.idle();
    reads = [];
    writeFileSync(join(docs, "notes.md"), "Renewal is automatic every year, the notes say.");
    utimesSync(join(docs, "notes.md"), new Date(), new Date(Date.now() + 5000));
    rmSync(join(docs, "contract.pdf"));
    fileIndex.start();
    await fileIndex.idle();
    expect(reads).toEqual([join(docs, "notes.md")]);
    expect(fileIndex.status()).toMatchObject({ found: 2, indexed: 1, skipped: 1 });
    expect(await fileIndex.search({ query: "termination" })).toEqual([]);
    expect(await fileIndex.search({ query: "renewal" })).toHaveLength(1);
  });

  it("keeps the index when the folder cannot be read (unmounted drive), and when the walk is cut short", async () => {
    let mode: "real" | "unreadable" | "truncated" = "real";
    const fileIndex = open({
      walk: async (folderRoot, options) => {
        if (mode === "unreadable") {
          options.report?.unreadable.push(folderRoot);
          return [];
        }
        const files = await walkFolder(folderRoot, options);
        if (mode === "truncated" && options.report) {
          options.report.truncated = true;
          return files.slice(0, 1);
        }
        return files;
      },
    });
    await fileIndex.addFolder(docs);
    await fileIndex.idle();
    expect(fileIndex.status()).toMatchObject({ found: 3, indexed: 2 });

    mode = "unreadable";
    fileIndex.start();
    await fileIndex.idle();
    expect(fileIndex.status()).toMatchObject({ found: 3, indexed: 2 });
    expect(fileIndex.status().lastError).toMatchObject({ path: docs });
    expect(await fileIndex.search({ query: "termination" })).not.toEqual([]);

    mode = "truncated";
    fileIndex.start();
    await fileIndex.idle();
    expect(fileIndex.status()).toMatchObject({ found: 3, indexed: 2 });
  });

  it("counts a file over the size cap as skipped and a reader error as failed", async () => {
    writeFileSync(join(docs, "big.txt"), "x".repeat(200));
    const fileIndex = open({
      maxFileBytes: 100,
      extract: async (path) => (path.endsWith(".pdf") ? { status: "failed", error: "bad xref" } : { status: "ok", segments: [{ text: "ok" }] }),
    });
    await fileIndex.addFolder(docs);
    await fileIndex.idle();
    const status = fileIndex.status();
    expect(status).toMatchObject({ found: 4, indexed: 2, failed: 1, skipped: 1 });
    expect(status.lastError).toMatchObject({ path: join(docs, "contract.pdf"), message: "bad xref" });
  });

  it("stops in the middle of a file and leaves it pending", async () => {
    let started!: () => void;
    const reading = new Promise<void>((resolve) => (started = resolve));
    const fileIndex = open({
      extract: (_path, signal) =>
        new Promise((resolve) => {
          started();
          signal.addEventListener("abort", () => resolve({ status: "failed", error: "aborted" }));
        }),
    });
    await fileIndex.addFolder(docs);
    await reading;
    expect(fileIndex.status().running).toBe(true);
    expect(fileIndex.status().current).toBeDefined();
    await fileIndex.close();
    index = null;
    const reopened = open({ extract: async () => ({ status: "ok", segments: [{ text: "done" }] }) });
    expect(reopened.status()).toMatchObject({ running: false, found: 3, indexed: 0, failed: 0 });
  });

  it("removes a folder with everything it held", async () => {
    const fileIndex = open();
    await fileIndex.addFolder(docs);
    await fileIndex.idle();
    expect(await fileIndex.removeFolder(docs)).toBe(true);
    expect(await fileIndex.removeFolder(docs)).toBe(false);
    expect(fileIndex.listFolders()).toEqual([]);
    expect(fileIndex.status()).toMatchObject({ found: 0, indexed: 0 });
    expect(await fileIndex.search({ query: "termination" })).toEqual([]);
  });

  it("refuses a search folder that is not in My files", async () => {
    const fileIndex = open();
    await fileIndex.addFolder(docs);
    await expect(fileIndex.search({ query: "x", folder: join(root, "home") })).rejects.toBeInstanceOf(FolderRejectedError);
    await expect(fileIndex.search({ query: "termination", folder: docs })).resolves.toBeDefined();
  });

  it("rejects a folder twice with already_added", async () => {
    const fileIndex = open();
    await fileIndex.addFolder(docs);
    await expect(fileIndex.addFolder(docs)).rejects.toMatchObject({ code: "already_added" });
  });
});

/** Two meaning axes: animals and vehicles. */
function fakeEmbedding(options: { down?: boolean } = {}): EmbeddingClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    dim: 3,
    model: "fake-embed",
    calls,
    async embed(req) {
      calls.push(req.purpose ?? "");
      if (options.down) throw new EmbeddingUnavailableError("down");
      const text = req.text.toLowerCase();
      const animal = /cat|kitten|dog/.test(text) ? 1 : 0;
      const vehicle = /car|truck|vehicle/.test(text) ? 1 : 0;
      return { vector: new Float32Array([animal, vehicle, 0.05]), model: "fake-embed" };
    },
  };
}

describe("FileIndex with local embeddings", () => {
  beforeEach(() => {
    rmSync(join(docs, "contract.pdf"));
    writeFileSync(join(docs, "notes.md"), "My cat sleeps all day on the sofa.");
    writeFileSync(join(docs, "garage.txt"), "The truck needs new tyres.");
  });

  it("embeds chunks as documents and finds a passage by meaning alone", async () => {
    const client = fakeEmbedding();
    const fileIndex = open({ embedding: () => client });
    await fileIndex.addFolder(docs);
    await fileIndex.idle();
    expect(client.calls.filter((p) => p === "document")).toHaveLength(2);
    const hits = await fileIndex.search({ query: "kitten" });
    expect(hits.map((hit) => hit.path)).toEqual([join(docs, "notes.md")]);
    expect(hits[0]!.cite).toBe(`[notes.md](file://${join(docs, "notes.md")})`);
  });

  it("falls back to keywords when the embedding model does not answer", async () => {
    const fileIndex = open({ embedding: () => fakeEmbedding({ down: true }) });
    await fileIndex.addFolder(docs);
    await fileIndex.idle();
    expect(fileIndex.status()).toMatchObject({ indexed: 2 });
    expect(await fileIndex.search({ query: "kitten" })).toEqual([]);
    expect((await fileIndex.search({ query: "truck" })).map((hit) => hit.path)).toEqual([join(docs, "garage.txt")]);
  });
});

describe("status maths", () => {
  it("is done only when nothing runs and every found file is accounted for", () => {
    const at = "2026-11-18T00:00:00.000Z";
    expect(isIndexDone(statusFrom({ found: 5, indexed: 3, failed: 1, skipped: 1 }, { running: false, updatedAt: at }))).toBe(true);
    expect(isIndexDone(statusFrom({ found: 5, indexed: 3, failed: 1, skipped: 1 }, { running: true, updatedAt: at }))).toBe(false);
    expect(isIndexDone(statusFrom({ found: 5, indexed: 2, failed: 1, skipped: 1 }, { running: false, updatedAt: at }))).toBe(false);
    expect(isIndexDone(statusFrom({ found: 0, indexed: 0, failed: 0, skipped: 0 }, { running: false, updatedAt: at }))).toBe(true);
  });

  it("leaves current and lastError out when there are none", () => {
    const status = statusFrom({ found: 1, indexed: 0, failed: 0, skipped: 0 }, { running: true, updatedAt: "t" });
    expect(Object.keys(status).sort()).toEqual(["failed", "found", "indexed", "running", "skipped", "updatedAt"]);
  });
});
