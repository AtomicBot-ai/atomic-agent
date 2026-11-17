import { randomUUID } from "node:crypto";

import {
  extractFactCandidates,
  type FactCandidate,
  type ImportFactsComplete,
  type ImportFactsEngine,
  type ImportFactsProgress,
} from "../../memory/import-facts/index.js";

import {
  collectUserMessages,
  type ChatExportSource,
  type CollectedUserMessagesStats,
  type ExportChat,
} from "./collect-user-messages.js";

/**
 * One facts import at a time, run in the background so a screen can show
 * "chunk N of M", stop it, and then list what was found (ATO-1627 terminal,
 * ATO-1629 desktop). Nothing here writes memory: saving the ticked
 * candidates is a separate call (save-fact-candidates.ts).
 *
 * The job keeps the candidates in memory only, for {@link IMPORT_FACTS_JOB_TTL_MS}
 * after it ends; they are the person's own words and are never written
 * to disk or logged. A job a screen forgot is dropped when the next one
 * starts or the TTL passes.
 */
export const IMPORT_FACTS_JOB_TTL_MS = 60 * 60_000;

export type ImportFactsJobState = "reading" | "extracting" | "done" | "stopped" | "failed";

export interface ImportFactsJobView {
  id: string;
  source: ChatExportSource;
  state: ImportFactsJobState;
  /** Which link reads the chats: shown next to the progress. */
  providerId: string;
  local: boolean;
  progress: ImportFactsProgress;
  stats: CollectedUserMessagesStats | null;
  failedChunks: number;
  dropped: { ungrounded: number; sensitive: number; duplicate: number };
  /** Present once the job ended (done or stopped). */
  candidates: FactCandidate[] | null;
  error: string | null;
}

export interface StartImportFactsJobInput {
  source: ChatExportSource;
  engine: ImportFactsEngine;
  providerId: string;
  local: boolean;
  complete: ImportFactsComplete;
  readChats: () => Promise<ExportChat[]>;
  knownProfile?: readonly { key: string; value: string }[];
  nowMs?: number;
}

export class ImportFactsJobs {
  private job: (ImportFactsJobView & { controller: AbortController; endedAt: number | null; done: Promise<void> }) | null = null;

  constructor(private readonly clock: () => number = Date.now) {}

  /** Starts a run. A running one is refused (`null`); a finished one is replaced. */
  start(input: StartImportFactsJobInput): ImportFactsJobView | null {
    this.expire();
    if (this.job && this.job.endedAt === null) return null;
    const controller = new AbortController();
    const job = {
      id: randomUUID(),
      source: input.source,
      state: "reading" as ImportFactsJobState,
      providerId: input.providerId,
      local: input.local,
      progress: { chunksDone: 0, chunksTotal: 0, candidates: 0 },
      stats: null,
      failedChunks: 0,
      dropped: { ungrounded: 0, sensitive: 0, duplicate: 0 },
      candidates: null,
      error: null,
      controller,
      endedAt: null as number | null,
      done: Promise.resolve(),
    };
    this.job = job;
    job.done = this.run(job, input);
    return view(job);
  }

  get(id: string): ImportFactsJobView | null {
    this.expire();
    return this.job && this.job.id === id ? view(this.job) : null;
  }

  /** Candidates of a finished job, for saving. `null` while running or unknown. */
  candidatesOf(id: string): FactCandidate[] | null {
    const job = this.get(id);
    return job?.candidates ?? null;
  }

  stop(id: string): boolean {
    if (!this.job || this.job.id !== id || this.job.endedAt !== null) return false;
    this.job.controller.abort();
    return true;
  }

  /** Drop a job and its candidates (after saving, or when the screen is closed). */
  forget(id: string): void {
    if (this.job?.id !== id) return;
    this.job.controller.abort();
    this.job = null;
  }

  /** For tests and shutdown: resolves when the current job has ended. */
  async settled(): Promise<void> {
    await this.job?.done;
  }

  private async run(job: NonNullable<ImportFactsJobs["job"]>, input: StartImportFactsJobInput): Promise<void> {
    try {
      const chats = await input.readChats();
      const collected = collectUserMessages(chats, { nowMs: input.nowMs ?? this.clock() });
      job.stats = collected.stats;
      job.progress = { chunksDone: 0, chunksTotal: collected.chunks.length, candidates: 0 };
      if (job.controller.signal.aborted) {
        this.end(job, "stopped", []);
        return;
      }
      job.state = "extracting";
      const result = await extractFactCandidates({
        chunks: collected.chunks,
        engine: input.engine,
        complete: input.complete,
        signal: job.controller.signal,
        ...(input.knownProfile ? { knownProfile: input.knownProfile } : {}),
        onProgress: (p) => {
          job.progress = p;
        },
      });
      job.failedChunks = result.failedChunks;
      job.dropped = result.dropped;
      job.progress = { chunksDone: result.chunksDone, chunksTotal: result.chunksTotal, candidates: result.candidates.length };
      const allFailed = result.chunksTotal > 0 && result.failedChunks === result.chunksTotal;
      if (allFailed) {
        job.error = "the model did not answer for any part of the chats";
        this.end(job, "failed", []);
        return;
      }
      this.end(job, result.stopped ? "stopped" : "done", result.candidates);
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
      this.end(job, "failed", null);
    }
  }

  private end(job: NonNullable<ImportFactsJobs["job"]>, state: ImportFactsJobState, candidates: FactCandidate[] | null): void {
    job.state = state;
    job.candidates = candidates;
    job.endedAt = this.clock();
  }

  private expire(): void {
    if (this.job?.endedAt != null && this.clock() - this.job.endedAt > IMPORT_FACTS_JOB_TTL_MS) this.job = null;
  }
}

function view(job: ImportFactsJobView): ImportFactsJobView {
  return {
    id: job.id,
    source: job.source,
    state: job.state,
    providerId: job.providerId,
    local: job.local,
    progress: { ...job.progress },
    stats: job.stats ? { ...job.stats } : null,
    failedChunks: job.failedChunks,
    dropped: { ...job.dropped },
    candidates: job.candidates ? job.candidates.map((c) => ({ ...c })) : null,
    error: job.error,
  };
}
