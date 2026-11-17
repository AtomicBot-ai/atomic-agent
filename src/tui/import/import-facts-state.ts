import type { FactCandidate } from "../../memory/import-facts/index.js";

/**
 * "Here is what I learned about you" (ATO-1627): the facts step of the
 * Import tab. The person points it at a ChatGPT or Claude data export,
 * a model reads only their own messages, and they tick which facts to
 * keep. Pure state; the runner (import-facts-runner.ts) calls the
 * shared service in src/import/user-facts.
 *
 * Phases:
 *  - `form`: export kind, path, and which model reads (local unless the
 *    person ticks the cloud row, which says where the text goes).
 *  - `running`: "part N of M", Esc stops and keeps what was found.
 *  - `review`: the candidates, all ticked; space flips one, Enter saves.
 *  - `done`: "Saved N, skipped M (already known)".
 */
export type ImportFactsPhase = "form" | "running" | "review" | "done";
export type ImportFactsExportKind = "claude" | "chatgpt";
export type ImportFactsFocus = "kind" | "path" | "cloud" | "start";
export const IMPORT_FACTS_FOCUS_ORDER: readonly ImportFactsFocus[] = ["kind", "path", "cloud", "start"];

export interface ImportFactsUiState {
  phase: ImportFactsPhase;
  kind: ImportFactsExportKind;
  path: string;
  /** The person ticked "use a cloud model" for this run. Never stored. */
  cloud: boolean;
  focus: ImportFactsFocus;
  /** Which local link would read the chats; `null` = none set up. */
  localLabel: string | null;
  /** The cloud provider the cloud row would use; `null` = none configured. */
  cloudProvider: string | null;
  jobId: string | null;
  /** Shown while running: which link reads, and whether it is local. */
  readingWith: { providerId: string; local: boolean } | null;
  progress: { chunksDone: number; chunksTotal: number; candidates: number };
  candidates: FactCandidate[];
  /** Ids of ticked candidates. */
  checked: string[];
  cursor: number;
  stopped: boolean;
  result: { saved: number; skipped: number; conflicts: number; failed: number } | null;
  error: string | null;
}

export function createInitialImportFactsState(): ImportFactsUiState {
  return {
    phase: "form",
    kind: "claude",
    path: "",
    cloud: false,
    focus: "kind",
    localLabel: null,
    cloudProvider: null,
    jobId: null,
    readingWith: null,
    progress: { chunksDone: 0, chunksTotal: 0, candidates: 0 },
    candidates: [],
    checked: [],
    cursor: 0,
    stopped: false,
    result: null,
    error: null,
  };
}

export function importFactsExportLabel(kind: ImportFactsExportKind): string {
  return kind === "claude" ? "Claude export (.zip)" : "ChatGPT export (.zip)";
}

/** The one line that says which model reads, and where the text goes. */
export function importFactsModelLine(s: Pick<ImportFactsUiState, "cloud" | "localLabel" | "cloudProvider">): string {
  if (s.cloud) {
    return s.cloudProvider
      ? `cloud model (${s.cloudProvider}): the text of your chats will be sent to ${s.cloudProvider}`
      : "no cloud provider is set up";
  }
  return s.localLabel ? `local model (${s.localLabel}): your chats stay on this computer` : "no local model is set up";
}
