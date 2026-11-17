import type { ImportFactsEngine } from "../../memory/import-facts/index.js";

import type { ChatExportSource } from "./collect-user-messages.js";
import { bindImportFactsModel, type BindImportFactsModelInput } from "./import-facts-model.js";
import type { ImportFactsJobs, ImportFactsJobView } from "./import-facts-jobs.js";
import {
  deleteImportReceipt,
  readImportReceipt,
  writeImportReceipt,
} from "./import-facts-receipts.js";
import { readChatExport } from "./read-chat-export.js";
import {
  saveFactCandidates,
  undoImportedFacts,
  type ImportFactsMemoryTarget,
  type ImportFactsProfileTarget,
  type UndoImportedFactsResult,
} from "./save-fact-candidates.js";

/**
 * The facts import as three calls, shared by the HTTP routes (the
 * desktop, ATO-1629) and the terminal's import wizard (ATO-1627), which
 * runs the runtime in-process:
 *
 *  1. {@link startImportFacts}: read the export, bind the model, start
 *     the background job. Throws before anything is sent when the
 *     engine is not allowed or no such model exists.
 *  2. {@link saveImportFacts}: write the ticked candidates of a finished
 *     job, persist the receipt, forget the job.
 *  3. {@link undoImportFacts}: take one import back by its receipt.
 */
export interface ImportFactsServiceDeps {
  jobs: ImportFactsJobs;
  llm: Omit<BindImportFactsModelInput, "engine">;
  profileStore: ImportFactsProfileTarget;
  memoryStore: ImportFactsMemoryTarget;
  stateDir: string;
}

export interface StartImportFactsRequest {
  source: ChatExportSource;
  path: string;
  engine: ImportFactsEngine;
}

export class ImportFactsBusyError extends Error {
  constructor() {
    super("a facts import is already running; stop it or wait for it to finish");
    this.name = "ImportFactsBusyError";
  }
}

export function startImportFacts(deps: ImportFactsServiceDeps, req: StartImportFactsRequest): ImportFactsJobView {
  const model = bindImportFactsModel({ ...deps.llm, engine: req.engine });
  const job = deps.jobs.start({
    source: req.source,
    engine: req.engine,
    providerId: model.providerId,
    local: model.local,
    complete: model.complete,
    readChats: () => readChatExport(req.source, req.path),
    knownProfile: deps.profileStore.list().map((f) => ({ key: f.key, value: f.value })),
  });
  if (!job) throw new ImportFactsBusyError();
  return job;
}

export interface SaveImportFactsResult {
  saved: number;
  /** Already known, or merged into an existing note. */
  skipped: number;
  /** Profile keys that hold another value: left as they were. */
  conflicts: { key: string; reason: string }[];
  failed: number;
  /** `null` when nothing was written. */
  receiptId: string | null;
}

export class ImportFactsJobNotReadyError extends Error {
  constructor() {
    super("no finished facts import with this id (it may still be running, or it expired)");
    this.name = "ImportFactsJobNotReadyError";
  }
}

export function saveImportFacts(
  deps: ImportFactsServiceDeps,
  jobId: string,
  approvedIds: readonly string[],
): SaveImportFactsResult {
  const job = deps.jobs.get(jobId);
  const candidates = deps.jobs.candidatesOf(jobId);
  if (!job || !candidates) throw new ImportFactsJobNotReadyError();
  const { report, receipt } = saveFactCandidates({
    candidates,
    approvedIds,
    source: job.source,
    profileStore: deps.profileStore,
    memoryStore: deps.memoryStore,
  });
  const receiptId = writeImportReceipt(deps.stateDir, receipt);
  deps.jobs.forget(jobId);
  let saved = 0;
  let skipped = 0;
  let failed = 0;
  const conflicts: { key: string; reason: string }[] = [];
  for (const item of report.items) {
    if (item.status === "migrated") saved += 1;
    else if (item.status === "skipped") skipped += 1;
    else if (item.status === "conflict") conflicts.push({ key: item.destination ?? "", reason: item.reason ?? "" });
    else failed += 1;
  }
  return { saved, skipped, conflicts, failed, receiptId };
}

export class ImportReceiptNotFoundError extends Error {
  constructor(id: string) {
    super(`no import receipt "${id}"`);
    this.name = "ImportReceiptNotFoundError";
  }
}

export function undoImportFacts(deps: ImportFactsServiceDeps, receiptId: string): UndoImportedFactsResult {
  const receipt = readImportReceipt(deps.stateDir, receiptId);
  if (!receipt) throw new ImportReceiptNotFoundError(receiptId);
  const result = undoImportedFacts(receipt, deps.profileStore, deps.memoryStore);
  deleteImportReceipt(deps.stateDir, receiptId);
  return result;
}
