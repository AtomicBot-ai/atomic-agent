/**
 * Phase-7b mirror of `distill-isolated.ts`. Runs one combined
 * lesson+procedure distill call against the managed llama-server
 * and returns the parsed shape (lesson half always graded; procedure
 * half may be `null` when the model judged the cluster non-procedural).
 *
 * Same isolation guarantees as the lesson-only harness — a fresh
 * `MemoryStore` is used only so the episodes have realistic ids and
 * tags in the prompt. No `LessonStore` / `ProcedureStore` is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, type MemoryEntry } from "../../src/memory/memory-store.js";
import {
  buildDistillPrompt,
  DistillParseError,
} from "../../src/memory/consolidator/index.js";
import { DISTILL_WITH_PROCEDURE_GRAMMAR } from "../../src/memory/consolidator/distill-grammar.js";
import {
  parseDistillWithProcedureOutput,
  type ParsedDistillWithProcedure,
  type ParsedProcedure,
} from "../../src/memory/consolidator/distill-parser.js";

import type { LlmCompleteParams, LlmCompleteResult } from "./llm-client.js";

export interface IsolatedProcDistillInput {
  episodes: ReadonlyArray<{ content: string; tags?: readonly string[] }>;
  sharedTags: readonly string[];
  sessionId?: string;
  signal?: AbortSignal;
}

export type IsolatedProcDistillOutcome =
  | {
      kind: "lesson";
      parsed: Extract<ParsedDistillWithProcedure, { kind: "lesson" }>;
      procedure: ParsedProcedure | null;
      raw: string;
      durationMs: number;
    }
  | { kind: "none"; raw: string; durationMs: number }
  | { kind: "parse_failed"; raw: string; reason: string; durationMs: number }
  | { kind: "http_failed"; reason: string };

export interface IsolatedProcDistillDeps {
  llmComplete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  slotId?: number;
  temperature?: number;
  maxTokens?: number;
}

export async function runIsolatedDistillWithProcedure(
  input: IsolatedProcDistillInput,
  deps: IsolatedProcDistillDeps,
): Promise<IsolatedProcDistillOutcome> {
  const tmp = mkdtempSync(join(tmpdir(), "atomic-eval-distill-proc-"));
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
      withProcedure: true,
    });
    const completionParams: LlmCompleteParams = {
      prompt,
      grammar: DISTILL_WITH_PROCEDURE_GRAMMAR,
      slotId: deps.slotId ?? -1,
      temperature: deps.temperature ?? 0.2,
      maxTokens: deps.maxTokens ?? 768,
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
      const parsed = parseDistillWithProcedureOutput(raw);
      if (parsed.kind === "none") {
        return { kind: "none", raw, durationMs: result.durationMs };
      }
      return {
        kind: "lesson",
        parsed,
        procedure: parsed.procedure,
        raw,
        durationMs: result.durationMs,
      };
    } catch (err) {
      const reason =
        err instanceof DistillParseError
          ? `parse:${err.reason}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { kind: "parse_failed", raw, reason, durationMs: result.durationMs };
    }
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
