import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";

const DEFAULT_MAX_ENTRIES = 200;
const TOP_EXTENSIONS_IN_HEADER = 5;

type EntryKind = "file" | "dir" | "other";

interface RawEntry {
  name: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
}

interface ParsedArgs {
  path: string;
  pattern: string | null;
  patternRegex: RegExp | null;
  kind: "file" | "dir" | null;
  extensions: string[] | null;
  sort: "name" | "size" | "mtime";
  maxEntries: number;
}

export const osFsListTool: ToolDefinition = {
  name: "os.fs.list",
  description:
    "List entries in a directory with optional filtering and sorting. " +
    "Args: path (required), pattern (glob like *.pdf or *foo*), " +
    "kind ('file'|'dir'), extensions (string[], e.g. ['pdf','docx']), " +
    "sort ('name'|'size'|'mtime', default 'name'), maxEntries (default 200). " +
    "Prefer this over `os.shell.run ls` when looking for specific files.",
  readonly: true,
  async run(rawArgs, ctx) {
    const args = parseArgs(rawArgs);
    const absolute = resolveUserPath(args.path, ctx.workingDir);

    const names = await readdir(absolute);
    const entries = await statEntries(absolute, names);

    const matched = entries.filter((e) => entryMatches(e, args));
    const sorted = sortEntries(matched, args.sort);
    const shown = sorted.slice(0, args.maxEntries);

    const output = renderOutput(absolute, entries, matched, shown, args);

    return compressToolResult(
      {
        tool: "os.fs.list",
        status: "ok",
        output,
        details: {
          path: absolute,
          total: entries.length,
          matched: matched.length,
          shown: shown.length,
          filter: {
            pattern: args.pattern,
            kind: args.kind,
            extensions: args.extensions,
          },
          sort: args.sort,
          entries: shown.map((e) => ({
            name: e.name,
            kind: e.kind,
            size: e.size,
            mtimeMs: e.mtimeMs,
          })),
        },
      },
      { maxSummaryLength: 4000, maxTailLines: 500 },
    );
  },
};

function parseArgs(raw: Record<string, unknown>): ParsedArgs {
  const path = raw.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.list: `path` must be a non-empty string");
  }

  const maxEntries =
    typeof raw.maxEntries === "number" && Number.isFinite(raw.maxEntries)
      ? Math.max(1, Math.floor(raw.maxEntries))
      : DEFAULT_MAX_ENTRIES;

  const pattern =
    typeof raw.pattern === "string" && raw.pattern.length > 0
      ? raw.pattern
      : null;
  const patternRegex = pattern ? compileGlob(pattern) : null;

  let kind: "file" | "dir" | null = null;
  if (raw.kind === "file" || raw.kind === "dir") kind = raw.kind;

  let extensions: string[] | null = null;
  if (Array.isArray(raw.extensions)) {
    const cleaned = raw.extensions
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .map((e) => normaliseExt(e));
    if (cleaned.length > 0) extensions = cleaned;
  }

  let sort: ParsedArgs["sort"] = "name";
  if (raw.sort === "size" || raw.sort === "mtime" || raw.sort === "name") {
    sort = raw.sort;
  }

  return { path, pattern, patternRegex, kind, extensions, sort, maxEntries };
}

async function statEntries(
  absolute: string,
  names: readonly string[],
): Promise<RawEntry[]> {
  const rows: RawEntry[] = [];
  for (const name of names) {
    try {
      const info = await stat(join(absolute, name));
      const kind: EntryKind = info.isFile()
        ? "file"
        : info.isDirectory()
          ? "dir"
          : "other";
      rows.push({ name, kind, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      rows.push({ name, kind: "other", size: 0, mtimeMs: 0 });
    }
  }
  return rows;
}

function entryMatches(e: RawEntry, args: ParsedArgs): boolean {
  if (args.kind && e.kind !== args.kind) return false;
  if (args.extensions) {
    if (e.kind !== "file") return false;
    const ext = normaliseExt(extname(e.name));
    if (!args.extensions.includes(ext)) return false;
  }
  if (args.patternRegex && !args.patternRegex.test(e.name)) return false;
  return true;
}

function sortEntries(rows: RawEntry[], sort: ParsedArgs["sort"]): RawEntry[] {
  const copy = [...rows];
  if (sort === "name") {
    copy.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === "size") {
    copy.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  } else {
    copy.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  }
  return copy;
}

function renderOutput(
  absolute: string,
  all: readonly RawEntry[],
  matched: readonly RawEntry[],
  shown: readonly RawEntry[],
  args: ParsedArgs,
): string {
  const fileCount = all.filter((e) => e.kind === "file").length;
  const dirCount = all.filter((e) => e.kind === "dir").length;
  const otherCount = all.length - fileCount - dirCount;

  const header: string[] = [];
  header.push(`path: ${absolute}`);
  header.push(
    `total: ${all.length} entries (file=${fileCount}, dir=${dirCount}` +
      (otherCount > 0 ? `, other=${otherCount}` : ``) +
      `)`,
  );

  const filterParts = describeFilter(args);
  if (filterParts.length > 0) {
    header.push(`filter: ${filterParts.join(", ")} → matched=${matched.length}`);
  }

  const topExt = topExtensions(all, TOP_EXTENSIONS_IN_HEADER);
  if (topExt.length > 0) {
    header.push(`top extensions: ${topExt.join(", ")}`);
  }

  header.push(`sort: ${args.sort}${args.sort === "name" ? " asc" : " desc"}`);

  const shownLabel =
    matched.length === 0
      ? `(no matches)`
      : shown.length === matched.length
        ? `[showing ${shown.length}/${matched.length}]`
        : `[showing ${shown.length}/${matched.length}; refine with pattern= or extensions= to narrow]`;

  const body =
    shown.length === 0
      ? ``
      : shown.map((e) => formatRow(e, args.sort)).join("\n");

  return [header.join("\n"), shownLabel, body].filter((s) => s.length > 0).join("\n");
}

function describeFilter(args: ParsedArgs): string[] {
  const parts: string[] = [];
  if (args.pattern) parts.push(`pattern=${JSON.stringify(args.pattern)}`);
  if (args.kind) parts.push(`kind=${args.kind}`);
  if (args.extensions) parts.push(`extensions=[${args.extensions.join(",")}]`);
  return parts;
}

function formatRow(e: RawEntry, sort: ParsedArgs["sort"]): string {
  const kind = e.kind.padEnd(4);
  const size = e.size.toString().padStart(10);
  if (sort === "mtime" && e.mtimeMs > 0) {
    const date = new Date(e.mtimeMs).toISOString().slice(0, 10);
    return `${kind} ${size}  ${date}  ${e.name}`;
  }
  return `${kind} ${size}  ${e.name}`;
}

function topExtensions(all: readonly RawEntry[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const e of all) {
    if (e.kind !== "file") continue;
    const ext = normaliseExt(extname(e.name)) || "(no ext)";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([ext, n]) => `${ext}=${n}`);
}

function normaliseExt(input: string): string {
  return input.replace(/^\./, "").toLowerCase();
}

function compileGlob(pattern: string): RegExp {
  let body = "";
  for (const ch of pattern) {
    if (ch === "*") body += ".*";
    else if (ch === "?") body += ".";
    else body += escapeRegex(ch);
  }
  return new RegExp(`^${body}$`, "i");
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
