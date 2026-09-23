import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import type { ArchiveEntry } from "./archive-types.js";
import {
  parseFormatOverride,
  resolveArchive,
  type ArchiveBackendFactories,
} from "./archive-resolver.js";

export interface ListArchiveToolOptions {
  backends?: ArchiveBackendFactories;
}

/**
 * Character budget for an archive tool's summary, shared with
 * `extract-tool.ts` so the two read the same size in a transcript.
 *
 * It is ours to pick because the compressor's is unusable here. Anything
 * above 8000 is dead on arrival: `TOOL_RESULT_RENDER_CAP_CHARS` in
 * `session/conversation-turn.ts` re-cuts every tool result at render time
 * and the archive tools are not among the exempt ones, so the 64 KiB this
 * used to store only ever reached the model as its first 8000 chars —
 * while still charging the packed transcript the full 8000 (~2.2K tokens,
 * a fourteenth of the 32K fallback window) on every turn that carries it,
 * and `heldPackStart` keeps the cut that pays for it.
 *
 * Measured on this repo: a 400-entry listing renders at ~20.8 KB, its
 * first 120 entries at ~5.8 KB. 6000 chars is ~1.7K tokens — enough for a
 * listing a model can actually navigate, small enough that a session can
 * take several without evicting its own history.
 */
export const ARCHIVE_SUMMARY_MAX_CHARS = 6_000;

/**
 * Entries the listing summary carries before it starts hiding them. The
 * character budget above usually bites first; this bound is what keeps a
 * listing of very short paths from becoming a thousand-line wall.
 */
const LISTING_MAX_ENTRIES = 120;

/**
 * `os.fs.archive.list` — enumerate archive contents without touching the
 * filesystem outside the source file. Returns a compact, LLM-friendly
 * listing (one entry per line) plus a structured `entries` array in the
 * details object so the model can decide what to extract next.
 */
export function buildOsFsArchiveListTool(
  options: ListArchiveToolOptions = {},
): ToolDefinition {
  return {
    name: "os.fs.archive.list",
    description:
      "List entries inside an archive (zip, tar, tar.gz/tgz, gz) without extracting. Read-only.",
    readonly: true,
    async run(rawArgs, ctx) {
      const path = rawArgs.path;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error(
          "os.fs.archive.list: `path` must be a non-empty string",
        );
      }
      const formatOverride = parseFormatOverride(rawArgs.format);
      const resolved = await resolveArchive(
        path,
        ctx.workingDir,
        formatOverride,
        options.backends,
      );
      const entries = await resolved.backend.list(resolved.data);
      const output = formatListing(entries);
      return compressToolResult(
        {
          tool: "os.fs.archive.list",
          status: "ok",
          output,
          details: {
            path: resolved.absolute,
            format: resolved.format,
            entryCount: entries.length,
            totalUncompressedBytes: totalSize(entries),
            entries: entries.map((e) => ({
              path: e.path,
              kind: e.kind,
              size: e.size,
              compressedSize: e.compressedSize,
              linkTarget: e.linkTarget,
            })),
          },
        },
        // `formatListing` has already clipped to these bounds and said so
        // in the text; passing them on keeps the compressor from cutting
        // a second time and losing the line that names what was hidden.
        {
          maxSummaryLength: ARCHIVE_SUMMARY_MAX_CHARS,
          maxTailLines: LISTING_MAX_ENTRIES + 1,
        },
      );
    },
  };
}

function formatListing(entries: readonly ArchiveEntry[]): string {
  if (entries.length === 0) return "(empty archive)";
  // Fixed-width columns so visually scanning the listing is easy. Size
  // column is right-aligned; `-` means unknown (tar gives no compressed
  // size, gz/archive streams may not report sizes either).
  const lines = entries.map((e) => {
    const size = e.size === undefined ? "-" : String(e.size);
    const kind = kindLetter(e.kind);
    const target = e.linkTarget ? ` -> ${e.linkTarget}` : "";
    return `${kind} ${size.padStart(10, " ")}  ${e.path}${target}`;
  });
  return clipListing(lines);
}

/**
 * Keep the head of the listing and end with a line naming exactly how
 * many entries were left out.
 *
 * Both halves matter. A listing has no header, so the compressor's
 * tail-slice would drop the *top* of the archive — the manifest, the
 * root directory, the entries a model opens a listing to find — and its
 * head-slice would end the text mid-path with a bare "… [truncated]".
 * Either way the model is handed a partial listing that looks complete,
 * which is how it ends up concluding a file is not in the archive.
 */
function clipListing(lines: readonly string[]): string {
  // Budget against the longest trailer we could end up writing, so the
  // clipped text fits the cap whatever the hidden count turns out to be.
  const budget =
    ARCHIVE_SUMMARY_MAX_CHARS - hiddenEntriesNote(lines.length).length - 1;
  let kept = 0;
  let chars = 0;
  while (kept < lines.length && kept < LISTING_MAX_ENTRIES) {
    const next = chars + (kept > 0 ? 1 : 0) + lines[kept]!.length;
    if (next > budget) break;
    chars = next;
    kept += 1;
  }
  if (kept >= lines.length) return lines.join("\n");
  // One pathologically long path should still be shown rather than
  // replaced by a note saying every entry was hidden.
  const shown = Math.max(1, kept);
  return [
    ...lines.slice(0, shown),
    hiddenEntriesNote(lines.length - shown),
  ].join("\n");
}

function hiddenEntriesNote(hidden: number): string {
  return `… ${hidden} more ${hidden === 1 ? "entry" : "entries"} not shown (listing clipped; entries are in archive order)`;
}

function kindLetter(kind: ArchiveEntry["kind"]): string {
  switch (kind) {
    case "file":
      return "-";
    case "directory":
      return "d";
    case "symlink":
      return "l";
  }
}

function totalSize(entries: readonly ArchiveEntry[]): number {
  let total = 0;
  for (const e of entries) {
    if (typeof e.size === "number") total += e.size;
  }
  return total;
}
