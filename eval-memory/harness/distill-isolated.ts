/**
 * Run a distill (consolidator) call in isolation against the managed
 * llama-server. Uses a fresh `MemoryStore` to host the seeded
 * "episodes" so the distill prompt sees a realistic shape (numbered
 * ids, tag intersection), but does NOT touch any `LessonStore`.
 *
 * The returned `ParsedDistill` is the runner's pre-write view of what
 * the model produced — exactly the surface E4's gold-lesson rubric
 * grades against.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, type MemoryEntry } from "../../src/memory/memory-store.js";
import {
  buildDistillPrompt,
  DISTILL_GRAMMAR,
  parseDistillOutput,
  DistillParseError,
  type ParsedDistill,
} from "../../src/memory/consolidator/index.js";

import type { LlmCompleteParams, LlmCompleteResult } from "./llm-client.js";

export interface IsolatedDistillInput {
  /** Free-form episode bodies + their shared tags. */
  episodes: ReadonlyArray<{ content: string; tags?: readonly string[] }>;
  sharedTags: readonly string[];
  sessionId?: string;
  signal?: AbortSignal;
}

export type IsolatedDistillOutcome =
  | { kind: "lesson"; parsed: Extract<ParsedDistill, { kind: "lesson" }>; raw: string; durationMs: number }
  | { kind: "none"; raw: string; durationMs: number }
  | { kind: "parse_failed"; raw: string; reason: string; durationMs: number }
  | { kind: "http_failed"; reason: string };

export interface IsolatedDistillDeps {
  llmComplete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  slotId?: number;
  temperature?: number;
  maxTokens?: number;
}

export async function runIsolatedDistill(
  input: IsolatedDistillInput,
  deps: IsolatedDistillDeps,
): Promise<IsolatedDistillOutcome> {
  const tmp = mkdtempSync(join(tmpdir(), "atomic-eval-distill-"));
  const store = new MemoryStore({
    dbFile: join(tmp, "memory.sqlite"),
    maxEntries: input.episodes.length + 4,
    dedup: { enabled: false, fts5Threshold: 0.95 },
    eviction: { utilityWeighted: false, maxAgeMs: Number.MAX_SAFE_INTEGER },
  });
  try {
    const seeded: MemoryEntry[] = [];
    for (const e of input.episodes) {
      const stored = store.store({
        content: e.content,
        ...(e.tags ? { tags: [...e.tags] } : {}),
      });
      seeded.push(stored);
    }
    const prompt = buildDistillPrompt({
      episodes: seeded,
      sharedTags: input.sharedTags,
    });
    const completionParams: LlmCompleteParams = {
      prompt,
      grammar: DISTILL_GRAMMAR,
      slotId: deps.slotId ?? -1,
      temperature: deps.temperature ?? 0.2,
      maxTokens: deps.maxTokens ?? 512,
      cachePrompt: false,
    };
    if (input.sessionId !== undefined) completionParams.sessionId = input.sessionId;
    if (input.signal !== undefined) completionParams.signal = input.signal;
    let result: LlmCompleteResult;
    try {
      result = await deps.llmComplete(completionParams);
    } catch (err) {
      return {
        kind: "http_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    const raw = result.content;
    try {
      const parsed = parseDistillOutput(raw);
      if (parsed.kind === "none") {
        return { kind: "none", raw, durationMs: result.durationMs };
      }
      return { kind: "lesson", parsed, raw, durationMs: result.durationMs };
    } catch (err) {
      const reason =
        err instanceof DistillParseError ? `parse:${err.reason}` : (err instanceof Error ? err.message : String(err));
      return { kind: "parse_failed", raw, reason, durationMs: result.durationMs };
    }
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
