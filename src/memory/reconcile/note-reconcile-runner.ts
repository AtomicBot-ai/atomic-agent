import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ResponseFormatJsonSchema } from "../../llm/provider/completion-types.js";
import { resolveSlotId, type SlotIdSource } from "../../llm/slot-manager.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { MemoryEntry, MemoryStore } from "../memory-store.js";

import { NOTE_RECONCILE_GRAMMAR } from "./note-reconcile-grammar.js";
import { parseNoteReconcileOutput } from "./note-reconcile-parser.js";
import { buildNoteReconcilePrompt } from "./note-reconcile-prompt.js";
import { NOTE_RECONCILE_RESPONSE_FORMAT } from "./note-reconcile-response-format.js";

/**
 * ATO-672. Closes contradictions between notes: after reflection writes
 * a note, compare it with the few older notes that share words with it
 * and mark the ones it replaces as stale.
 *
 * Bounds (the issue's risk: an extra model call per write):
 *   - at most ONE model call per reflection, for the first new note that
 *     has any similar older note; no candidates → no call;
 *   - its own hard timeout; a timeout or failure gives up for this
 *     reflection (no retry);
 *   - at most `maxSupersede` (default 2) older notes marked per call;
 *   - ids outside the candidates shown to the model are ignored.
 *
 * "Stale" is metadata only, through `MemoryStore.evolveTags` (content
 * stays append-only, the consolidator lease is honoured): the replaced
 * note gets `superseded` plus `superseded-by-<newId>`. With
 * `memory.notes.reconcile` on, the context provider leaves `superseded`
 * notes out of `### recalled` and `### memory-index`; they stay readable
 * by id and in the memory view. A DUPLICATE marks the NEW note instead
 * (`superseded-by-<oldId>`).
 *
 * Fire-safe: `reconcile()` never throws.
 */
export const SUPERSEDED_NOTE_TAG = "superseded";

export type NoteReconcileOutcome =
  | "superseded"
  | "duplicate"
  | "none"
  | "skipped"
  | "aborted"
  | "timeout"
  | "failed";

export interface NoteReconcileReport {
  outcome: NoteReconcileOutcome;
  /** Ids of notes marked `superseded` by this call. */
  marked: number[];
}

export type NoteReconcileLlmComplete = (params: {
  prompt: string;
  grammar: string;
  responseFormat?: ResponseFormatJsonSchema;
  slotId: number;
  sessionId: string;
  signal: AbortSignal;
}) => Promise<CompletionResult>;

export interface NoteReconcileRunnerDeps {
  llmComplete: NoteReconcileLlmComplete;
  notesStore: MemoryStore;
  /** Same side-call slot as reflection. Resolved per call. */
  reflectionSlotId: SlotIdSource;
  timeoutMs: number;
  /** Older notes shown to the model. Default 5. */
  maxCandidates?: number;
  /** Older notes marked per call. Default 2. */
  maxSupersede?: number;
  /** Consolidator lease window honoured by `evolveTags`. Default 60 s. */
  leaseMs?: number;
  logger?: StructuredLogger;
  now?: () => number;
}

export interface NoteReconcileRunner {
  reconcile(input: { sessionId: string; notes: readonly MemoryEntry[] }): Promise<NoteReconcileReport>;
  abortPending(options?: { sessionId?: string }): void;
}

export function isSupersededNote(entry: { tags: readonly string[] }): boolean {
  return entry.tags.includes(SUPERSEDED_NOTE_TAG);
}

export function createNoteReconcileRunner(deps: NoteReconcileRunnerDeps): NoteReconcileRunner {
  const now = deps.now ?? Date.now;
  const maxCandidates = deps.maxCandidates ?? 5;
  const maxSupersede = deps.maxSupersede ?? 2;
  const leaseMs = deps.leaseMs ?? 60_000;
  const pending = new Map<string, AbortController>();

  const finish = (
    sessionId: string,
    startedAt: number,
    outcome: NoteReconcileOutcome,
    marked: number[] = [],
    reason?: string,
  ): NoteReconcileReport => {
    const context = {
      sessionId,
      tookMs: Math.max(0, now() - startedAt),
      marked: marked.length,
      ...(reason ? { reason } : {}),
    };
    if (outcome === "timeout" || outcome === "failed") {
      deps.logger?.warn(`note_reconcile.${outcome}`, context);
    } else if (outcome === "skipped" || outcome === "aborted") {
      deps.logger?.debug(`note_reconcile.${outcome}`, context);
    } else {
      deps.logger?.info(`note_reconcile.${outcome}`, context);
    }
    return { outcome, marked };
  };

  const pickTarget = (
    notes: readonly MemoryEntry[],
  ): { note: MemoryEntry; candidates: MemoryEntry[] } | null => {
    const freshIds = new Set(notes.map((n) => n.id));
    for (const note of notes.slice(0, 3)) {
      if (isSupersededNote(note)) continue;
      const candidates = deps.notesStore
        .findSimilar(note.content, maxCandidates + freshIds.size)
        .filter((c) => !freshIds.has(c.id) && !isSupersededNote(c))
        .slice(0, maxCandidates);
      if (candidates.length > 0) return { note, candidates };
    }
    return null;
  };

  const mark = (id: number, byId: number): boolean => {
    try {
      const result = deps.notesStore.evolveTags(id, [SUPERSEDED_NOTE_TAG, `superseded-by-${byId}`], {
        leaseMs,
        now: now(),
      });
      return result.outcome === "applied";
    } catch {
      return false;
    }
  };

  const runOne = async (input: {
    sessionId: string;
    notes: readonly MemoryEntry[];
  }): Promise<NoteReconcileReport> => {
    const startedAt = now();
    let picked: ReturnType<typeof pickTarget>;
    try {
      picked = pickTarget(input.notes);
    } catch (err) {
      return finish(input.sessionId, startedAt, "failed", [], errorText(err));
    }
    if (!picked) return finish(input.sessionId, startedAt, "skipped", [], "no similar older note");
    const target = picked;

    pending.get(input.sessionId)?.abort();
    const controller = new AbortController();
    pending.set(input.sessionId, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deps.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const completion = await deps.llmComplete({
        prompt: buildNoteReconcilePrompt({
          newNote: target.note.content,
          candidates: target.candidates.map((c) => ({ id: c.id, body: c.content })),
        }),
        grammar: NOTE_RECONCILE_GRAMMAR,
        responseFormat: NOTE_RECONCILE_RESPONSE_FORMAT,
        slotId: resolveSlotId(deps.reflectionSlotId),
        sessionId: `note-reconcile:${input.sessionId}`,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return finish(input.sessionId, startedAt, timedOut ? "timeout" : "aborted");
      }
      const parsed = parseNoteReconcileOutput(completion.content, {
        allowlist: new Set(target.candidates.map((c) => c.id)),
        maxSupersede,
      });
      if (parsed.kind === "none") return finish(input.sessionId, startedAt, "none");
      if (parsed.kind === "duplicate") {
        const marked = mark(target.note.id, parsed.id) ? [target.note.id] : [];
        return finish(input.sessionId, startedAt, marked.length > 0 ? "duplicate" : "none", marked);
      }
      const marked = parsed.ids.filter((id) => mark(id, target.note.id));
      return finish(input.sessionId, startedAt, marked.length > 0 ? "superseded" : "none", marked);
    } catch (err) {
      if (controller.signal.aborted) {
        return finish(input.sessionId, startedAt, timedOut ? "timeout" : "aborted");
      }
      return finish(input.sessionId, startedAt, "failed", [], errorText(err));
    } finally {
      clearTimeout(timer);
      if (pending.get(input.sessionId) === controller) pending.delete(input.sessionId);
    }
  };

  return {
    async reconcile(input) {
      try {
        return await runOne(input);
      } catch (err) {
        deps.logger?.warn("note_reconcile.failed", { sessionId: input.sessionId, reason: errorText(err) });
        return { outcome: "failed", marked: [] };
      }
    },
    abortPending(options) {
      if (options?.sessionId !== undefined) {
        pending.get(options.sessionId)?.abort();
        return;
      }
      for (const controller of pending.values()) controller.abort();
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
