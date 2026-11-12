import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import { MemoryStore } from "../memory-store.js";
import type { ReflectionRunner } from "../reflection/reflection-runner.js";

import {
  createNoteReconcileRunner,
  isSupersededNote,
  type NoteReconcileLlmComplete,
} from "./note-reconcile-runner.js";
import { createReconcileAwareReflectionRunner } from "./reconcile-aware-reflection.js";

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  };
}

describe("note reconciliation (ATO-672)", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-note-reconcile-"));
    store = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 100 });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function runner(llm: NoteReconcileLlmComplete, timeoutMs = 1_000) {
    return createNoteReconcileRunner({
      llmComplete: llm,
      notesStore: store,
      reflectionSlotId: 0,
      timeoutMs,
    });
  }

  it("marks the older note the new one replaces as superseded", async () => {
    const old = store.store({ content: "The user works at Acme as a designer", tags: ["reflection"] });
    const fresh = store.store({ content: "The user now works at Globex as a designer", tags: ["reflection"] });
    let prompt = "";
    const report = await runner(async (p) => {
      prompt = p.prompt;
      return completion(`SUPERSEDE ${old.id}\n`);
    }).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report).toEqual({ outcome: "superseded", marked: [old.id] });
    expect(prompt).toContain(`[${old.id}]`);
    const after = store.get(old.id)!;
    expect(isSupersededNote(after)).toBe(true);
    expect(after.tags).toContain(`superseded-by-${fresh.id}`);
    expect(after.content).toBe("The user works at Acme as a designer");
    expect(isSupersededNote(store.get(fresh.id)!)).toBe(false);
  });

  it("marks the NEW note on DUPLICATE", async () => {
    const old = store.store({ content: "The user prefers dark mode in every editor" });
    const fresh = store.store({ content: "User likes dark mode for the editor" });
    const report = await runner(async () => completion(`DUPLICATE ${old.id}\n`)).reconcile({
      sessionId: "s1",
      notes: [fresh],
    });
    expect(report.outcome).toBe("duplicate");
    expect(isSupersededNote(store.get(fresh.id)!)).toBe(true);
    expect(isSupersededNote(store.get(old.id)!)).toBe(false);
  });

  it("makes no model call when no older note shares words", async () => {
    const fresh = store.store({ content: "zebra quantum lighthouse" });
    let calls = 0;
    const report = await runner(async () => {
      calls += 1;
      return completion("NONE");
    }).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report.outcome).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("makes at most one model call for several new notes", async () => {
    store.store({ content: "The user lives in Lisbon" });
    store.store({ content: "The user drinks green tea" });
    const a = store.store({ content: "The user moved to Porto from Lisbon" });
    const b = store.store({ content: "The user switched to green coffee from tea" });
    let calls = 0;
    await runner(async () => {
      calls += 1;
      return completion("NONE\n");
    }).reconcile({ sessionId: "s1", notes: [a, b] });
    expect(calls).toBe(1);
  });

  it("ignores ids the model was not shown", async () => {
    const unrelated = store.store({ content: "zebra quantum lighthouse" });
    store.store({ content: "The user works at Acme" });
    const fresh = store.store({ content: "The user works at Globex now" });
    const report = await runner(async () => completion(`SUPERSEDE ${unrelated.id}\n`)).reconcile({
      sessionId: "s1",
      notes: [fresh],
    });
    expect(report.outcome).toBe("none");
    expect(isSupersededNote(store.get(unrelated.id)!)).toBe(false);
  });

  it("gives up on timeout without marking anything", async () => {
    const old = store.store({ content: "The user works at Acme" });
    const fresh = store.store({ content: "The user works at Globex now" });
    const report = await runner(
      (p) =>
        new Promise<CompletionResult>((_, reject) => {
          p.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      10,
    ).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report.outcome).toBe("timeout");
    expect(isSupersededNote(store.get(old.id)!)).toBe(false);
  });

  it("the decorator reconciles only notes this reflection wrote", async () => {
    const old = store.store(
      { content: "The user works at Acme", sessionId: "s1", tags: ["reflection"] },
      Date.now() - 10_000,
    );
    let seen: number[] = [];
    const reflection: ReflectionRunner = {
      async reflect() {
        store.store({
          content: "The user works at Globex now",
          sessionId: "s1",
          tags: ["reflection"],
        }, Date.now() + 5);
      },
      abortPending() {},
    };
    const decorated = createReconcileAwareReflectionRunner({
      reflection,
      reconciler: {
        async reconcile(input) {
          seen = input.notes.map((n) => n.id);
          return { outcome: "none", marked: [] };
        },
        abortPending() {},
      },
      notesStore: store,
    });
    await decorated.reflect({ sessionId: "s1", userMessage: "u", assistantReply: "a" });
    expect(seen).toHaveLength(1);
    expect(seen).not.toContain(old.id);
  });

  it("the decorator stays fire-safe when the store is closed", async () => {
    const reflection: ReflectionRunner = {
      async reflect() {
        store.close();
      },
      abortPending() {},
    };
    const decorated = createReconcileAwareReflectionRunner({
      reflection,
      reconciler: {
        reconcile: async () => ({ outcome: "none", marked: [] }),
        abortPending() {},
      },
      notesStore: store,
    });
    await expect(
      decorated.reflect({ sessionId: "s1", userMessage: "u", assistantReply: "a" }),
    ).resolves.toBeUndefined();
    // Reopen so afterEach can close it.
    store = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 100 });
  });
});
