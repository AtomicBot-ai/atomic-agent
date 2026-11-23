import { isAbsolute } from "node:path";

import { getConfig } from "../config/index.js";
import {
  ImportFactsBusyError,
  ImportFactsJobNotReadyError,
  ImportFactsJobs,
  ImportFactsModelError,
  ImportReceiptNotFoundError,
  isImportReceiptId,
  listImportReceipts,
  saveImportFacts,
  startImportFacts,
  undoImportFacts,
  type ImportFactsServiceDeps,
} from "../import/user-facts/index.js";
import { resolveLlmConfig } from "../llm/provider/index.js";
import { ImportFactsConsentError, type ImportFactsEngine } from "../memory/import-facts/index.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * Facts about the person from a ChatGPT or Claude export (ATO-1617), for
 * the desktop import wizard (ATO-1629). The terminal calls the same
 * service in-process (import-facts-service.ts).
 *
 * - `POST /api/import/facts/start` `{ source: "claude"|"chatgpt", path, engine? }`
 *   → `{ job }`. `engine` defaults to `{ kind: "local" }`; a cloud engine is
 *   `{ kind: "cloud", provider, cloudConsent: true }`, the person's tick for
 *   this run. `403 cloud_consent_required`, `422 no_local_model` /
 *   `unknown_provider` / `not_cloud`, `409 busy`, `400` for a bad body.
 * - `GET /api/import/facts/jobs/{id}` → `{ job }` (candidates once it ended).
 * - `POST /api/import/facts/jobs/{id}/stop`, `DELETE /api/import/facts/jobs/{id}`.
 * - `POST /api/import/facts/jobs/{id}/save` `{ approvedIds: string[] }` → counts + `receiptId`.
 * - `GET /api/import/facts/receipts`, `POST /api/import/facts/receipts/{id}/undo`.
 *
 * Nothing here logs message text; job views carry quotes only to the
 * client that started the run.
 */
const jobsByRuntime = new WeakMap<AgentRuntime, ImportFactsJobs>();

function serviceDeps(runtime: AgentRuntime): ImportFactsServiceDeps {
  let jobs = jobsByRuntime.get(runtime);
  if (!jobs) {
    jobs = new ImportFactsJobs();
    jobsByRuntime.set(runtime, jobs);
  }
  const config = getConfig();
  const resolved = resolveLlmConfig(config);
  return {
    jobs,
    llm: {
      providers: resolved.providers,
      activeTextProvider: resolved.activeTextProvider,
      getProvider: (id) => runtime.providerRegistry.getProvider(id),
    },
    profileStore: runtime.profileStore,
    memoryStore: runtime.notesStore,
    stateDir: config.paths.stateDir,
  };
}

export function createStartImportFactsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch {
      sendError(res, 400, openaiError("Invalid JSON"));
      return;
    }
    const parsed = parseStartBody(body);
    if (typeof parsed === "string") {
      sendError(res, 400, openaiError(parsed));
      return;
    }
    try {
      sendJson(res, 200, { job: startImportFacts(serviceDeps(ctx.runtime), parsed) });
    } catch (err) {
      if (err instanceof ImportFactsConsentError) {
        sendError(res, 403, openaiError(err.message, "invalid_request_error", "engine", "cloud_consent_required"));
      } else if (err instanceof ImportFactsModelError) {
        sendError(res, 422, openaiError(err.message, "invalid_request_error", "engine", err.code));
      } else if (err instanceof ImportFactsBusyError) {
        sendError(res, 409, openaiError(err.message, "invalid_request_error", null, "busy"));
      } else {
        throw err;
      }
    }
  };
}

export function createGetImportFactsJobHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const job = serviceDeps(ctx.runtime).jobs.get(ctx.params.id ?? "");
    if (!job) {
      sendError(res, 404, openaiError("no such facts import", "invalid_request_error", null, "not_found"));
      return;
    }
    sendJson(res, 200, { job });
  };
}

export function createStopImportFactsJobHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    sendJson(res, 200, { stopped: serviceDeps(ctx.runtime).jobs.stop(ctx.params.id ?? "") });
  };
}

export function createForgetImportFactsJobHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    serviceDeps(ctx.runtime).jobs.forget(ctx.params.id ?? "");
    sendJson(res, 200, { forgotten: true });
  };
}

export function createSaveImportFactsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch {
      sendError(res, 400, openaiError("Invalid JSON"));
      return;
    }
    const ids = (body as { approvedIds?: unknown } | null)?.approvedIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      sendError(res, 400, openaiError("approvedIds must be a list of candidate ids", "invalid_request_error", "approvedIds"));
      return;
    }
    try {
      sendJson(res, 200, saveImportFacts(serviceDeps(ctx.runtime), ctx.params.id ?? "", ids as string[]));
    } catch (err) {
      if (!(err instanceof ImportFactsJobNotReadyError)) throw err;
      sendError(res, 409, openaiError(err.message, "invalid_request_error", null, "not_ready"));
    }
  };
}

export function createListImportReceiptsHandler(): HttpHandler {
  return async (_req, res) => {
    const receipts = listImportReceipts(getConfig().paths.stateDir).map((r) => ({
      id: r.id,
      source: r.source,
      savedAt: r.savedAt,
      profileFacts: r.profile.length,
      notes: r.noteIds.length,
    }));
    sendJson(res, 200, { receipts });
  };
}

export function createUndoImportReceiptHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id ?? "";
    if (!isImportReceiptId(id)) {
      sendError(res, 400, openaiError("bad receipt id", "invalid_request_error", "id"));
      return;
    }
    try {
      sendJson(res, 200, undoImportFacts(serviceDeps(ctx.runtime), id));
    } catch (err) {
      if (!(err instanceof ImportReceiptNotFoundError)) throw err;
      sendError(res, 404, openaiError(err.message, "invalid_request_error", null, "not_found"));
    }
  };
}

/** Exported for tests. A string is the 400 message. */
export function parseStartBody(body: unknown): { source: "claude" | "chatgpt"; path: string; engine: ImportFactsEngine } | string {
  if (!body || typeof body !== "object") return "body must be an object";
  const b = body as Record<string, unknown>;
  if (b.source !== "claude" && b.source !== "chatgpt") return 'source must be "claude" or "chatgpt"';
  if (typeof b.path !== "string" || !isAbsolute(b.path)) return "path must be the absolute path of the export .zip or its folder";
  const e = b.engine;
  if (e === undefined || e === null) return { source: b.source, path: b.path, engine: { kind: "local" } };
  if (typeof e !== "object") return "engine must be an object";
  const eng = e as Record<string, unknown>;
  if (eng.kind === "local") return { source: b.source, path: b.path, engine: { kind: "local" } };
  if (eng.kind !== "cloud") return 'engine.kind must be "local" or "cloud"';
  if (typeof eng.provider !== "string" || eng.provider.length === 0) return "engine.provider is required for a cloud engine";
  // Only a literal `true` is consent; the service refuses anything else with 403.
  return { source: b.source, path: b.path, engine: { kind: "cloud", provider: eng.provider, cloudConsent: eng.cloudConsent === true } };
}

