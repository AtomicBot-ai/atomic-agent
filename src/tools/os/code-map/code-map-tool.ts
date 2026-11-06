import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { compressToolResult, retainToolOutput } from "../../../compressor/result-compressor.js";
import { resolveUserPath } from "../expand-home.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";
import { compileGlob, matchesAny } from "../fs/fs-glob-pattern.js";
import { DEFAULT_IGNORE } from "../fs/fs-glob.js";
import { orMissing } from "../fs/fs-missing-path.js";
import {
  createWalkBudget,
  describeWalkStop,
  type WalkBudgetLimits,
  type WalkStop,
} from "../fs/fs-walk-budget.js";
import { CODE_MAP_MAX_TOKENS, CODE_MAP_MIN_TOKENS, OS_FS_CODE_MAP_CONTRACT } from "./code-map-contract.js";
import { OutlineCache } from "./code-map-cache.js";
import { rankFiles, type RankInput } from "./code-map-rank.js";
import { renderFileOutline, renderProjectMap } from "./code-map-render.js";
import { languageForPath, type FileOutline, type OutlineBackend } from "./outline-types.js";
import { regexOutlineBackend } from "./regex-outline.js";
import { combineBackends, loadTreeSitterBackend } from "./tree-sitter-outline.js";

const TOOL = OS_FS_CODE_MAP_CONTRACT.name;

/** Smaller than glob's: a map is a first look, not an inventory. */
export const CODE_MAP_WALK_BUDGET: WalkBudgetLimits = { maxMs: 10_000, maxEntries: 60_000 };
/** Source files outlined per project map. */
export const CODE_MAP_MAX_FILES = 3_000;
/** Larger files are generated, vendored or data; skipped. */
export const CODE_MAP_MAX_FILE_BYTES = 400_000;
/** Default budget when the step's window is unknown. */
export const CODE_MAP_DEFAULT_TOKENS = 1_500;
const READ_CONCURRENCY = 16;

export interface CodeMapArgs {
  path: string | undefined;
  maxTokens: number | undefined;
  focus: string[];
}

export function parseCodeMapArgs(raw: Record<string, unknown>): CodeMapArgs {
  const path = raw.path;
  if (path !== undefined && path !== null && (typeof path !== "string" || path.trim().length === 0)) {
    throw new Error(`${TOOL}: \`path\` must be a non-empty string when given`);
  }
  const maxTokens = raw.maxTokens;
  if (maxTokens !== undefined && maxTokens !== null && (typeof maxTokens !== "number" || !Number.isFinite(maxTokens))) {
    throw new Error(`${TOOL}: \`maxTokens\` must be a number`);
  }
  const focus = raw.focus;
  if (focus !== undefined && focus !== null && (!Array.isArray(focus) || focus.some((f) => typeof f !== "string"))) {
    throw new Error(`${TOOL}: \`focus\` must be an array of strings`);
  }
  return {
    path: typeof path === "string" ? path.trim() : undefined,
    maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
    focus: Array.isArray(focus) ? (focus as string[]).map((f) => f.trim()).filter((f) => f.length > 0) : [],
  };
}

/**
 * The map's token budget: what was asked, clamped; otherwise ~3% of the
 * step's window (32K → ~1K, 128K → ~4K), or a fixed default.
 */
export function codeMapBudget(requested: number | undefined, contextWindow: number | undefined): number {
  const raw = requested ?? (contextWindow !== undefined && contextWindow > 0
    ? Math.floor(contextWindow * 0.03)
    : CODE_MAP_DEFAULT_TOKENS);
  return Math.min(CODE_MAP_MAX_TOKENS, Math.max(CODE_MAP_MIN_TOKENS, Math.floor(raw)));
}

/** Split `focus` into paths (have a slash or a source extension) and names. */
export function splitFocus(focus: readonly string[]): { files: string[]; idents: string[] } {
  const files: string[] = [];
  const idents: string[] = [];
  for (const item of focus) {
    if (item.includes("/") || item.includes("\\") || languageForPath(item) !== null) {
      files.push(item.replace(/\\/g, "/").replace(/^\.\//, ""));
    } else {
      idents.push(item);
    }
  }
  return { files, idents };
}

export interface CodeMapDeps {
  cache: OutlineCache;
  /** The parser; default: tree-sitter when available, regex otherwise. */
  backend: () => Promise<OutlineBackend>;
  budget: WalkBudgetLimits;
  now: () => number;
}

let defaultBackend: Promise<OutlineBackend> | null = null;

/** Regex always; tree-sitter on top when `ATOMIC_AGENT_TREE_SITTER_DIR` holds grammars and the module loads. */
export function resolveDefaultOutlineBackend(): Promise<OutlineBackend> {
  defaultBackend ??= loadTreeSitterBackend(process.env.ATOMIC_AGENT_TREE_SITTER_DIR).then(
    (ts) => combineBackends(ts, regexOutlineBackend),
    () => regexOutlineBackend,
  );
  return defaultBackend;
}

const sharedCache = new OutlineCache();

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function outlineFile(
  absolute: string,
  backend: OutlineBackend,
  cache: OutlineCache,
): Promise<FileOutline | null> {
  const language = languageForPath(absolute);
  if (language === null) return null;
  const info = await stat(absolute);
  if (!info.isFile() || info.size > CODE_MAP_MAX_FILE_BYTES) return null;
  const cached = cache.get(backend.id, absolute, info.mtimeMs, info.size);
  if (cached) return cached;
  const source = await readFile(absolute, "utf8");
  const outline = await backend.outline(source, language);
  cache.set(backend.id, absolute, info.mtimeMs, info.size, outline);
  return outline;
}

interface Walked {
  files: string[];
  scanned: number;
  stop: WalkStop | null;
  capped: boolean;
}

async function walkSources(root: string, limits: WalkBudgetLimits, ctx: ToolContext, now: () => number): Promise<Walked> {
  const ignore = DEFAULT_IGNORE.map((p) => compileGlob(p));
  const budget = createWalkBudget(limits, { now, signal: ctx.signal });
  const files: string[] = [];
  let scanned = 0;
  let stop: WalkStop | null = null;
  let capped = false;
  const walk = async (dir: string): Promise<void> => {
    if (capped || (stop = budget.check(scanned)) !== null) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (capped || (stop = budget.check(scanned)) !== null) return;
      scanned++;
      // Dot folders are tool state (.git, .venv, .next…), never the project's code.
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (entry.isDirectory()) {
        if (matchesAny(ignore, `${rel}/`) || matchesAny(ignore, `${rel}/x`)) continue;
        await walk(abs);
      } else if (entry.isFile() && languageForPath(entry.name) !== null) {
        if (matchesAny(ignore, rel)) continue;
        files.push(abs);
        if (files.length >= CODE_MAP_MAX_FILES) capped = true;
      }
    }
  };
  await walk(root);
  return { files, scanned, stop: stop as WalkStop | null, capped };
}

export function buildOsFsCodeMapTool(deps: Partial<CodeMapDeps> = {}): ToolDefinition {
  const cache = deps.cache ?? sharedCache;
  const getBackend = deps.backend ?? resolveDefaultOutlineBackend;
  const limits = deps.budget ?? CODE_MAP_WALK_BUDGET;
  const now = deps.now ?? Date.now;
  return {
    name: TOOL,
    description: OS_FS_CODE_MAP_CONTRACT.description,
    readonly: OS_FS_CODE_MAP_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const args = parseCodeMapArgs(rawArgs);
      const absolute = args.path === undefined ? ctx.workingDir : resolveUserPath(args.path, ctx.workingDir);
      const info = await orMissing(TOOL, absolute, ctx, () => stat(absolute));
      if ("missing" in info) return info.missing;
      const maxTokens = codeMapBudget(args.maxTokens, ctx.contextWindowTokens);
      const backend = await getBackend();

      if (info.isFile()) {
        const outline = await outlineFile(absolute, backend, cache);
        if (outline === null) {
          throw new Error(
            `${TOOL}: ${absolute} is not a source file this map reads (TS/JS, Python, Go, Rust, Java under ${CODE_MAP_MAX_FILE_BYTES} bytes); use os.fs.read`,
          );
        }
        const shownPath = toPosix(relative(ctx.workingDir, absolute)) || absolute;
        const rendered = renderFileOutline(shownPath.startsWith("..") ? absolute : shownPath, outline, maxTokens);
        const hidden = rendered.filesTotal - rendered.filesShown;
        const output = [
          rendered.text,
          ...(outline.symbols.length === 0 ? ["(no declarations found; read it with os.fs.read)"] : []),
          ...(hidden > 0 ? [`[${hidden} more symbols not shown: raise maxTokens, or os.fs.read with offset/limit]`] : []),
        ].join("\n");
        return compressToolResult(
          {
            tool: TOOL,
            status: "ok",
            output,
            details: { mode: "file", path: absolute, symbols: outline.symbols.length, shown: rendered.filesShown, tokens: rendered.tokens, backend: backend.id },
          },
          { maxSummaryLength: maxTokens * 5 + 400, maxTailLines: 5_000 },
        );
      }

      const walked = await walkSources(absolute, limits, ctx, now);
      const inputs: RankInput[] = [];
      for (let i = 0; i < walked.files.length; i += READ_CONCURRENCY) {
        ctx.signal.throwIfAborted();
        const batch = walked.files.slice(i, i + READ_CONCURRENCY);
        const outlines = await Promise.all(
          batch.map((file) => outlineFile(file, backend, cache).catch(() => null)),
        );
        outlines.forEach((outline, j) => {
          if (outline) inputs.push({ path: toPosix(relative(absolute, batch[j]!)), outline });
        });
      }
      const focus = splitFocus(args.focus);
      const ranked = rankFiles(inputs, { files: new Set(focus.files), idents: new Set(focus.idents) });
      const header = `Code map of ${absolute}: files ranked by how much the rest of the code references them; L<n> = line. Outline one file with ${TOOL} {"path":"<file>"}, read it with os.fs.read.`;
      const rendered = renderProjectMap(ranked, Math.max(0, maxTokens - 60));
      const hidden = rendered.filesTotal - rendered.filesShown;
      const notes = [
        ...(walked.capped ? [`[stopped at ${CODE_MAP_MAX_FILES} source files: pass a subfolder as path]`] : []),
        ...(hidden > 0 ? [`[${hidden} more files not shown: pass a subfolder as path, focus on a file or name, or raise maxTokens]`] : []),
      ];
      const body = inputs.length === 0
        ? "(no TS/JS, Python, Go, Rust or Java source files found here)"
        : rendered.text;
      const output = [header, body, ...notes].join("\n");
      const result = compressToolResult(
        {
          tool: TOOL,
          status: "ok",
          output,
          details: {
            mode: "project",
            root: absolute,
            filesScanned: walked.scanned,
            filesOutlined: inputs.length,
            filesShown: rendered.filesShown,
            tokens: rendered.tokens,
            backend: backend.id,
            truncated: hidden > 0 || walked.capped || walked.stop !== null,
            ...(walked.stop === null ? {} : { stoppedBy: walked.stop.reason, note: describeWalkStop(walked.stop) }),
          },
        },
        { maxSummaryLength: maxTokens * 5 + 800, maxTailLines: 5_000 },
      );
      if (walked.stop === null) return result;
      const note = `${describeWalkStop(walked.stop)}\n`;
      return retainToolOutput(
        result,
        { ...result, summary: `${note}${result.summary}`, truncated: true },
        { prefix: note, truncated: true },
      );
    },
  };
}
