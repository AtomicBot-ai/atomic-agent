/**
 * `os.code.lsp` (ATO-2373): go to definition, find references, hover and
 * symbols through the language servers the after-edit diagnostics
 * already start (`lsp-server-pool.ts`, the same pool, so one server per
 * language per repository serves both). Registered only when
 * `tools.lsp.enabled` is on; the servers come from PATH and are never
 * installed, start only inside a git work tree, and ask once in a folder
 * the operator has not trusted.
 *
 * Precedent: Claude Code's LSP tool (goToDefinition, findReferences,
 * hover, documentSymbol), OpenCode's `lsp` tool and its server list.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import { isUnderAny, sessionReadRoots } from "../../read-scope/index.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";
import { resolveUserPath } from "../expand-home.js";
import { orMissing } from "../fs/fs-missing-path.js";
import { navigate, type LspNavAnswer } from "../fs/lsp/lsp-navigation.js";
import type { LspServerPool, LspUnavailable } from "../fs/lsp/lsp-server-pool.js";
import type { LspServerSpec } from "../fs/lsp/lsp-servers.js";
import { parseLspArgs, resolveCharacter } from "./code-lsp-args.js";
import { OS_CODE_LSP_CONTRACT } from "./code-lsp-contract.js";
import { formatLspAnswer } from "./code-lsp-format.js";
import { displayPath } from "./code-search.js";

const TOOL = OS_CODE_LSP_CONTRACT.name;
/** A file larger than this is not sent to a server nor read for hit lines. */
export const LSP_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How long a call waits for a server that is still starting. */
export const LSP_NAV_STARTUP_WAIT_MS = 30_000;
/** How long one navigation request may take. */
export const LSP_NAV_REQUEST_TIMEOUT_MS = 20_000;

export interface OsCodeLspDeps {
  readonly pool: LspServerPool;
  readonly startupWaitMs?: number;
  readonly requestTimeoutMs?: number;
}

export function buildOsCodeLspTool(deps: OsCodeLspDeps): ToolDefinition {
  const startupWaitMs = deps.startupWaitMs ?? LSP_NAV_STARTUP_WAIT_MS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? LSP_NAV_REQUEST_TIMEOUT_MS;
  return {
    name: TOOL,
    description: OS_CODE_LSP_CONTRACT.description,
    readonly: OS_CODE_LSP_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const args = parseLspArgs(rawArgs);
      const absolute = resolveUserPath(args.path, ctx.workingDir);
      const read = await orMissing(TOOL, absolute, ctx, () => readSource(absolute));
      if (typeof read !== "string") return read.missing;
      const text = read;
      const character = resolveCharacter(args, text);
      const shown = displayPath(absolute, ctx.workingDir);
      const target =
        args.action === "symbols" ? shown : `${shown}:${args.line}:${character + 1}`;
      const outcome = await deps.pool.withServer(absolute, ctx, startupWaitMs, ({ client, spec }) =>
        navigate(
          client,
          {
            action: args.action,
            absolute,
            languageId: spec.languageId(absolute),
            text,
            line: args.line - 1,
            character,
            ...(args.query === undefined ? {} : { query: args.query }),
          },
          requestTimeoutMs,
        ),
      );
      if (!outcome.ok) {
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: unavailableMessage(outcome.reason, absolute, outcome.spec),
          details: { unavailable: outcome.reason, path: shown },
        });
      }
      const files = await loadHitFiles(outcome.value, args.maxResults, ctx, absolute, text);
      const formatted = formatLspAnswer(outcome.value, {
        action: args.action,
        target,
        ...(args.action === "symbols" && args.query !== undefined ? { query: args.query } : {}),
        maxResults: args.maxResults,
        displayPath: (path) => displayPath(path, ctx.workingDir),
        lineOf: (path, line) => files.get(path)?.[line - 1] ?? null,
      });
      return compressToolResult(
        {
          tool: TOOL,
          status: "ok",
          output: formatted.text,
          details: {
            action: args.action,
            path: shown,
            total: formatted.total,
            shown: formatted.shown,
            ...(args.action === "symbols" ? {} : { line: args.line, col: character + 1 }),
          },
        },
        { maxSummaryLength: 32 * 1024, maxTailLines: 1000 },
      );
    },
  };
}

async function readSource(absolute: string): Promise<string> {
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`${TOOL}: ${absolute} is not a regular file`);
  if (info.size > LSP_MAX_FILE_BYTES) {
    throw new Error(`${TOOL}: ${absolute} is larger than ${LSP_MAX_FILE_BYTES} bytes`);
  }
  return readFile(absolute, "utf8");
}

/**
 * The lines of the files the shown hits point into, each read once, and
 * only for a file the session may read: a hit outside the read scope (a
 * system library, another checkout) shows its position without code.
 */
async function loadHitFiles(
  answer: LspNavAnswer,
  maxResults: number,
  ctx: Pick<ToolContext, "workingDir" | "readRoots">,
  absolute: string,
  text: string,
): Promise<Map<string, readonly string[]>> {
  const files = new Map<string, readonly string[]>([[absolute, text.split(/\r?\n/)]]);
  if (answer.kind !== "hits") return files;
  const roots = sessionReadRoots(ctx);
  // Twice the cap: a few duplicates are dropped before printing.
  const wanted = new Set<string>();
  for (const h of answer.hits.slice(0, maxResults * 2)) {
    if (h.path !== null && h.label === undefined && !files.has(h.path)) wanted.add(h.path);
  }
  await Promise.all(
    [...wanted].map(async (path) => {
      if (!isUnderAny(path, roots)) return;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > LSP_MAX_FILE_BYTES) return;
        files.set(path, (await readFile(path, "utf8")).split(/\r?\n/));
      } catch {
        // Gone or unreadable: the hit keeps its position only.
      }
    }),
  );
  return files;
}

function unavailableMessage(
  reason: LspUnavailable,
  absolute: string,
  spec: LspServerSpec | undefined,
): string {
  const server = spec?.command ?? "a language server";
  switch (reason) {
    case "no_language":
      return `${TOOL}: no language server is known for ${extname(absolute) || "this kind of"} files. Supported: TypeScript/JavaScript, Python, Go, Rust, C/C++, Java, Swift, C#. Use os.fs.grep or os.code.search instead.`;
    case "no_project":
      return `${TOOL}: ${absolute} is not inside a git repository; language servers start only in one (never at home or a filesystem root). Use os.fs.grep instead.`;
    case "not_installed":
      return `${TOOL}: \`${server}\` is not on PATH. Nothing is installed automatically; install it (or use os.fs.grep / os.code.search instead).`;
    case "declined":
      return `${TOOL}: starting \`${server}\` in this repository was not allowed. Use os.fs.grep or os.code.search instead.`;
    case "failed":
      return `${TOOL}: \`${server}\` could not start in this repository. Use os.fs.grep or os.code.search instead.`;
    case "starting":
      return `${TOOL}: \`${server}\` is still starting; try again in a moment.`;
  }
}
