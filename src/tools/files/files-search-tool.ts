import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "../os/expand-home.js";
import { isGuestSecretPathUnder } from "../read-scope/guest-secret-files.js";
import type { ToolDefinition } from "../tool-registry.js";
import { FILES_SEARCH_MAX_TOP_K } from "./file-index.js";
import { FolderRejectedError, type FileIndexApi, type FileSearchHit } from "./file-index-types.js";
import { isIndexDone } from "./file-indexer.js";

export const FILES_SEARCH_TOOL = "files.search";
const MAX_QUERY_CHARS = 500;

export interface FilesSearchToolOptions {
  index: Pick<FileIndexApi, "search" | "listFolders" | "status">;
}

class ArgsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `files.search` (ATO-1621): passages from the folders the person added
 * in "My files", each with its file, PDF page (or time) and a ready
 * `cite` markdown link the model pastes as is. Read-only; a `folder`
 * argument is checked by the read scope like any read
 * (`read-scope-targets.ts`). File text is outside data, so the output is
 * framed as untrusted.
 */
export function buildFilesSearchTool(options: FilesSearchToolOptions): ToolDefinition {
  return {
    name: FILES_SEARCH_TOOL,
    description:
      "Search the folders the person added in My files (PDF, Word, slides, spreadsheets, e-books, web pages, mail and text files). Pass `query` (words or a question), optional `folder` (one of the added folders or a folder inside one) and `topK` 1..20 (default 8). Each hit gives the file path, the PDF page when there is one, a snippet and a `cite` markdown link. When you use a hit in your answer, paste its `cite` exactly as given, right after the sentence it supports; do not rewrite the link or invent page numbers.",
    readonly: true,
    untrustedOutput: "indexed files",
    async run(rawArgs, ctx) {
      try {
        const query = rawArgs.query;
        if (typeof query !== "string" || query.trim().length === 0) throw new ArgsError("query", "pass a non-empty `query`");
        if (query.length > MAX_QUERY_CHARS) throw new ArgsError("query", `at most ${MAX_QUERY_CHARS} characters`);
        const topK = parseTopK(rawArgs.topK);
        const folder = parseFolder(rawArgs.folder, ctx.workingDir);
        if (options.index.listFolders().length === 0) {
          return compressToolResult({
            tool: FILES_SEARCH_TOOL,
            status: "ok",
            output: "No folders are in My files yet. Ask the person to add a folder on the My files screen, then search again.",
            details: { query, count: 0, hits: [], folders: 0 },
          });
        }
        const found = await options.index.search({
          query,
          ...(folder !== undefined ? { folder } : {}),
          ...(topK !== undefined ? { topK } : {}),
          signal: ctx.signal,
        });
        // A guest never gets a passage of a `.env`, key or `secrets/` file
        // (ATO-2703, `guest-secret-files.ts`).
        const hits = ctx.guest === true
          ? found.filter((hit) => !isGuestSecretPathUnder(ctx.workingDir, hit.path))
          : found;
        return compressToolResult(
          {
            tool: FILES_SEARCH_TOOL,
            status: "ok",
            output: renderHits(query, hits, progressNote(options.index)),
            details: { query, ...(folder !== undefined ? { folder } : {}), count: hits.length, hits },
          },
          { maxSummaryLength: 8000, maxTailLines: 300 },
        );
      } catch (error) {
        if (error instanceof ArgsError || error instanceof FolderRejectedError) {
          const field = error instanceof ArgsError ? error.field : "folder";
          return compressToolResult({
            tool: FILES_SEARCH_TOOL,
            status: "error",
            output: `validation: ${field}: ${error.message}`,
            details: { field, reason: error.message },
          });
        }
        throw error;
      }
    },
  };
}

/** The model-facing text: one block per hit, its `cite` first. */
export function renderHits(query: string, hits: readonly FileSearchHit[], note: string): string {
  if (hits.length === 0) return `(nothing in My files matched "${query.slice(0, 60)}")${note}`;
  const lines = [`${hits.length} passage(s) from My files, best first. Paste a hit's cite as is when you use it.`];
  hits.forEach((hit, i) => {
    const where = hit.page !== undefined ? ` (page ${hit.page})` : "";
    lines.push(`[${i + 1}] cite: ${hit.cite}`, `    file: ${hit.path}${where}`, `    ${hit.snippet}`);
  });
  return `${lines.join("\n")}${note}`;
}

function progressNote(index: Pick<FileIndexApi, "status">): string {
  const status = index.status();
  if (isIndexDone(status)) return "";
  const done = status.indexed + status.failed + status.skipped;
  return `\n(indexing is still running: ${done} of ${status.found} files done, so results may be incomplete)`;
}

function parseTopK(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= FILES_SEARCH_MAX_TOP_K) return value;
  throw new ArgsError("topK", `must be an integer 1..${FILES_SEARCH_MAX_TOP_K}`);
}

function parseFolder(raw: unknown, workingDir: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new ArgsError("folder", "must be a path string");
  return resolveUserPath(raw, workingDir);
}
