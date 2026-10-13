import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../memory-store.js";
import { backfillEmbeddings, countPendingEmbeddings } from "./embedding-backfill.js";
import { EmbeddingUnavailableError, type EmbeddingClient, type EmbedRequest } from "./embedding-client.js";
import { EmbeddingStore } from "./embedding-store.js";
import { EmbeddingWriter } from "./embedding-writer.js";

/** Deterministic client that records what it was asked to embed. */
class FakeClient implements EmbeddingClient {
  readonly dim = 4;
  readonly requests: EmbedRequest[] = [];
  /** Throw this (once per call) from the Nth call onwards (1-based). */
  failFrom: { call: number; error: Error } | null = null;
  onEmbed: ((req: EmbedRequest) => void) | null = null;
  constructor(readonly model: string) {}
  async embed(req: EmbedRequest) {
    this.requests.push(req);
    this.onEmbed?.(req);
    if (this.failFrom && this.requests.length >= this.failFrom.call) throw this.failFrom.error;
    return { vector: new Float32Array([req.text.length, 1, 0, 0]), model: this.model };
  }
}

describe("backfillEmbeddings", () => {
  let tmp: string;
  let notes: MemoryStore;
  let vectors: EmbeddingStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-emb-backfill-"));
    notes = new MemoryStore({ dbFile: join(tmp, "memory.sqlite"), maxEntries: 100 });
    vectors = new EmbeddingStore({ db: notes.getDatabaseHandleForEmbeddings() });
  });

  afterEach(() => {
    notes.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const db = () => notes.getDatabaseHandleForEmbeddings();
  const writerFor = (client: EmbeddingClient) => new EmbeddingWriter({ client, store: vectors });
  const seed = (...contents: string[]) => contents.map((content) => notes.store({ content }).id);
  const vectorFor = (memoryId: number, model: string) => vectors.get(memoryId, model);
  const run = (client: EmbeddingClient, opts: Parameters<typeof backfillEmbeddings>[1] = {}) =>
    backfillEmbeddings({ db: db(), writer: writerFor(client) }, opts);

  it("embeds only the notes missing a vector for the current model, as documents with the stored text", async () => {
    const [a, b, c] = seed("alpha note", "beta note", "gamma note");
    vectors.upsert({ memoryId: b!, model: "new", dim: 4, vector: new Float32Array([9, 9, 9, 9]), createdAt: 1 });
    const client = new FakeClient("new");
    const result = await run(client);
    expect(result).toEqual({ model: "new", embedded: 2, skipped: 0, remaining: 0 });
    expect(client.requests.map((r) => [r.text, r.purpose])).toEqual([["gamma note", "document"], ["alpha note", "document"]]);
    expect(vectorFor(a!, "new")).not.toBeNull();
    expect(Array.from(vectorFor(b!, "new")!.vector)).toEqual([9, 9, 9, 9]);
    expect(vectorFor(c!, "new")).not.toBeNull();
  });

  it("gives notes with an old model's vector a new one and leaves the old vectors alone", async () => {
    const [a, b] = seed("first", "second");
    await run(new FakeClient("old"));
    expect(vectors.countByModel("old")).toBe(2);
    const result = await run(new FakeClient("new"));
    expect(result).toMatchObject({ embedded: 2, remaining: 0 });
    expect(vectors.countByModel("new")).toBe(2);
    expect(vectors.countByModel("old")).toBe(2);
    expect(vectorFor(a!, "old")).not.toBeNull();
    expect(vectorFor(b!, "new")).not.toBeNull();
  });

  it("goes newest first, across batches", async () => {
    seed("n1", "n2", "n3", "n4", "n5");
    const client = new FakeClient("m");
    let pauses = 0;
    await run(client, { batchSize: 2, pause: async () => { pauses += 1; } });
    expect(client.requests.map((r) => r.text)).toEqual(["n5", "n4", "n3", "n2", "n1"]);
    expect(pauses).toBe(3);
  });

  it("stops cleanly on abort and reports what is left", async () => {
    seed("n1", "n2", "n3", "n4");
    const controller = new AbortController();
    const client = new FakeClient("m");
    client.onEmbed = () => { if (client.requests.length === 2) controller.abort(); };
    const progress: number[] = [];
    const result = await run(client, { signal: controller.signal, onProgress: (p) => progress.push(p.embedded) });
    expect(result).toEqual({ model: "m", embedded: 2, skipped: 0, remaining: 2, stoppedReason: "aborted" });
    expect(progress).toEqual([1, 2]);
    expect(client.requests.every((r) => r.signal === controller.signal)).toBe(true);
  });

  it("stops quietly when the model goes away, keeping what was done", async () => {
    seed("n1", "n2", "n3");
    const client = new FakeClient("m");
    client.failFrom = { call: 2, error: new EmbeddingUnavailableError("daemon down") };
    const result = await run(client);
    expect(result).toEqual({ model: "m", embedded: 1, skipped: 0, remaining: 2, stoppedReason: "unavailable" });
    expect(client.requests).toHaveLength(2);
  });

  it("stops on an unexpected write error instead of walking the corpus into it", async () => {
    seed("n1", "n2");
    const client = new FakeClient("m");
    client.failFrom = { call: 1, error: new Error("bug") };
    await expect(run(client)).resolves.toMatchObject({ embedded: 0, remaining: 2, stoppedReason: "failed" });
    expect(client.requests).toHaveLength(1);
  });

  it("skips a note removed between the read and the write", async () => {
    const [a, b] = seed("n1", "n2");
    const client = new FakeClient("m");
    // The newest note goes while its embed is in flight: its upsert then
    // fails on the foreign key.
    client.onEmbed = (req) => { if (req.text === "n2") notes.remove(b!); };
    const result = await run(client);
    expect(result).toEqual({ model: "m", embedded: 1, skipped: 1, remaining: 0 });
    expect(vectorFor(a!, "m")).not.toBeNull();
  });

  it("skips notes with empty content without embedding them", async () => {
    seed("real note");
    db().prepare(`INSERT INTO memories (content, created_at, updated_at, source) VALUES ('   ', 1, 1, 'agent')`).run();
    const client = new FakeClient("m");
    const result = await run(client);
    expect(result).toEqual({ model: "m", embedded: 1, skipped: 1, remaining: 0 });
    expect(client.requests.map((r) => r.text)).toEqual(["real note"]);
    expect(countPendingEmbeddings(db(), "m")).toBe(0);
  });

  it("is a no-op the second time", async () => {
    seed("n1", "n2");
    await run(new FakeClient("m"));
    const again = new FakeClient("m");
    await expect(run(again)).resolves.toEqual({ model: "m", embedded: 0, skipped: 0, remaining: 0 });
    expect(again.requests).toHaveLength(0);
  });

  it("never throws when the store is closed under it", async () => {
    seed("n1");
    const handle = db();
    notes.close();
    await expect(
      backfillEmbeddings({ db: handle, writer: new EmbeddingWriter({ client: new FakeClient("m"), store: vectors }) }),
    ).resolves.toMatchObject({ embedded: 0, stoppedReason: "failed" });
    // Reopen so afterEach can close it again.
    notes = new MemoryStore({ dbFile: join(tmp, "memory.sqlite"), maxEntries: 100 });
  });
});
