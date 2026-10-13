import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { EmbeddingUnavailableError, type EmbeddingClient } from "../../memory/embeddings/embedding-client.js";
import { EmbeddingStore } from "../../memory/embeddings/embedding-store.js";
import { EmbeddingWriter } from "../../memory/embeddings/embedding-writer.js";
import { buildNotesRecallTool } from "./notes-recall.js";

function makeCtx(workingDir = "/work"): ToolContext {
  return {
    workingDir,
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.notes.recall", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-notes-recall-tool-"));
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ranked matches and exposes them in details", async () => {
    store.store({ content: "the cat sat on the mat" }, 1);
    store.store({ content: "unrelated trivia" }, 2);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: "cat" }, makeCtx());
    expect(result.status).toBe("ok");
    const entries = result.details.entries as Array<{ content: string }>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.content).toMatch(/cat/);
  });

  it("defaults scope to 'all' (cross-project)", async () => {
    store.store({ content: "alpha from a", workingDir: "/repos/a" }, 1);
    store.store({ content: "alpha from b", workingDir: "/repos/b" }, 2);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: "alpha" }, makeCtx("/repos/a"));
    expect(result.details.scope).toBe("all");
    expect(result.details.count).toBe(2);
  });

  it("scope='project' uses the ctx workingDir", async () => {
    store.store({ content: "alpha from a", workingDir: "/repos/a" }, 1);
    store.store({ content: "alpha from b", workingDir: "/repos/b" }, 2);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run(
      { query: "alpha", scope: "project" },
      makeCtx("/repos/a"),
    );
    const entries = result.details.entries as Array<{ workingDir: string }>;
    expect(entries.map((e) => e.workingDir)).toEqual(["/repos/a"]);
  });

  it("empty query yields an ok tool-result with zero entries", async () => {
    store.store({ content: "something" }, 1);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: "" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
  });

  it("returns validation error for non-string query", async () => {
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: 42 }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("query");
  });

  it("fetches a single note when called with { id }", async () => {
    const entry = store.store({ content: "drill-in body" }, 1);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ id: entry.id }, makeCtx());
    expect(result.status).toBe("ok");
    const entries = result.details.entries as Array<{
      id: number;
      content: string;
    }>;
    expect(result.details.count).toBe(1);
    expect(entries[0]?.id).toBe(entry.id);
    expect(entries[0]?.content).toBe("drill-in body");
    expect(result.details.scope).toBe("id");
  });

  it("returns zero-count ok when the id is not found", async () => {
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ id: 9999 }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
  });

  it("rejects non-positive-integer ids", async () => {
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ id: "abc" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("id");
  });
  describe("with embeddings attached", () => {
    // "pet" and "кот" embed alike; nothing else in these notes shares a word with the query.
    function attach(embed?: EmbeddingClient["embed"]): void {
      const client: EmbeddingClient = {
        dim: 2,
        model: "fake",
        embed: embed ?? (async ({ text }) => {
          const lower = text.toLowerCase();
          const pet = lower.includes("pet") || lower.includes("кот") ? 1 : 0;
          return { vector: new Float32Array([pet, 1 - pet]), model: "fake" };
        }),
      };
      const vectors = new EmbeddingStore({ db: store.getDatabaseHandleForEmbeddings() });
      store.attachEmbeddings({ writer: new EmbeddingWriter({ client, store: vectors }), store: vectors });
    }

    it("returns a note found by meaning alone, in the same output shape", async () => {
      attach();
      const cat = await store.storeAsync({ content: "мой кот Барсик любит огурцы" }, 1);
      await store.storeAsync({ content: "рецепт борща" }, 2);
      const tool = buildNotesRecallTool({ store, defaultK: 5 });
      const result = await tool.run({ query: "what does my pet like?" }, makeCtx());
      expect(result.status).toBe("ok");
      expect(result.fullOutput).toBe(`- #${cat.id} мой кот Барсик любит огурцы`);
      expect(result.details).toMatchObject({
        count: 1,
        scope: "all",
        entries: [{ id: cat.id, content: "мой кот Барсик любит огурцы", tags: [], workingDir: null, updatedAt: 1 }],
      });
    });

    it("falls back to keyword recall when the model is unavailable", async () => {
      store.store({ content: "the cat sat on the mat" }, 1);
      attach(async () => { throw new EmbeddingUnavailableError("down"); });
      const tool = buildNotesRecallTool({ store, defaultK: 5 });
      const result = await tool.run({ query: "cat" }, makeCtx());
      expect(result.fullOutput).toBe("- #1 the cat sat on the mat");
      expect(result.details.count).toBe(1);
    });
  });

  it("keeps the keyword output unchanged without embeddings", async () => {
    store.store({ content: "the cat sat on the mat" }, 1);
    store.store({ content: "мой кот Барсик любит огурцы" }, 2);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: "cat" }, makeCtx());
    expect(result.fullOutput).toBe("- #1 the cat sat on the mat");
    expect(result.details).toMatchObject({
      count: 1,
      scope: "all",
      entries: [{ id: 1, content: "the cat sat on the mat", tags: [], workingDir: null, updatedAt: 1 }],
    });
    expect((await tool.run({ query: "what does my pet like?" }, makeCtx())).fullOutput).toBe("(no matches)");
  });
});
