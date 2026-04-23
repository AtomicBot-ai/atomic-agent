import { compressToolResult } from "../../../compressor/result-compressor.js";
import { resolveUserPath } from "../expand-home.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import { DEFAULT_EXTRACT_LIMITS, type ExtractLimits } from "./archive-types.js";
import {
  parseFormatOverride,
  resolveArchive,
  type ArchiveBackendFactories,
} from "./archive-resolver.js";

export interface ExtractArchiveToolOptions extends DangerousToolOptions {
  backends?: ArchiveBackendFactories;
}

/**
 * `os.fs.archive.extract` — materialise an archive to disk.
 *
 * Security features baked in by the backend layer:
 *   - Zip-slip guard (absolute paths, backslashes, traversal escaping dest).
 *   - Per-entry / total-size / entry-count caps to blunt decompression
 *     bombs.
 *   - Symlinks skipped by default; opt in via `followSymlinks=true`, and
 *     even then the link target must resolve inside destDir.
 *
 * The tool itself routes every call through the approval gate — it is a
 * write operation by definition and should never surprise the user.
 */
export function buildOsFsArchiveExtractTool(
  options: ExtractArchiveToolOptions,
): ToolDefinition {
  return {
    name: "os.fs.archive.extract",
    description:
      "Extract an archive (zip, tar, tar.gz/tgz, gz) into destDir. Dangerous — always requires approval. Zip-slip / symlink-escape / decompression-bomb safeguards are always on.",
    readonly: false,
    async run(rawArgs, ctx) {
      const path = rawArgs.path;
      const destRaw = rawArgs.destDir;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error(
          "os.fs.archive.extract: `path` must be a non-empty string",
        );
      }
      if (typeof destRaw !== "string" || destRaw.length === 0) {
        throw new Error(
          "os.fs.archive.extract: `destDir` must be a non-empty string",
        );
      }
      const overwrite = rawArgs.overwrite === true;
      const followSymlinks = rawArgs.followSymlinks === true;
      const include = parseStringArray(rawArgs.include, "include");
      const formatOverride = parseFormatOverride(rawArgs.format);
      const limits = parseLimits(rawArgs.limits);

      const destDir = resolveUserPath(destRaw, ctx.workingDir);

      const resolved = await resolveArchive(
        path,
        ctx.workingDir,
        formatOverride,
        options.backends,
      );

      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.fs.archive.extract",
          reason: `extract ${resolved.format} ${resolved.absolute} → ${destDir}`,
          preview: buildApprovalPreview({
            source: resolved.absolute,
            dest: destDir,
            overwrite,
            followSymlinks,
            limits,
            include,
          }),
          affectedResources: [destDir],
        },
        ctx.signal,
      );

      const report = await resolved.backend.extract(resolved.data, {
        destDir,
        overwrite,
        followSymlinks,
        limits,
        include,
      });

      const output = formatReport(report, destDir);
      return compressToolResult(
        {
          tool: "os.fs.archive.extract",
          status: "ok",
          output,
          details: {
            source: resolved.absolute,
            destDir,
            format: resolved.format,
            extractedEntries: report.extractedEntries,
            totalBytesWritten: report.totalBytesWritten,
            skippedCount: report.skippedEntries.length,
            skippedEntries: report.skippedEntries,
            warnings: report.warnings,
            limits,
          },
        },
        { maxSummaryLength: 64 * 1024, maxTailLines: 2000 },
      );
    },
  };
}

function parseStringArray(
  raw: unknown,
  field: string,
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`os.fs.archive.extract: \`${field}\` must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`os.fs.archive.extract: \`${field}\` entries must be non-empty strings`);
    }
    out.push(item);
  }
  return out;
}

function parseLimits(raw: unknown): ExtractLimits {
  if (raw === undefined || raw === null) return DEFAULT_EXTRACT_LIMITS;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("os.fs.archive.extract: `limits` must be an object");
  }
  const obj = raw as Record<string, unknown>;
  return {
    maxTotalBytes: readLimit(obj.maxTotalBytes, DEFAULT_EXTRACT_LIMITS.maxTotalBytes, "maxTotalBytes"),
    maxEntryBytes: readLimit(obj.maxEntryBytes, DEFAULT_EXTRACT_LIMITS.maxEntryBytes, "maxEntryBytes"),
    maxEntries: readLimit(obj.maxEntries, DEFAULT_EXTRACT_LIMITS.maxEntries, "maxEntries"),
  };
}

function readLimit(raw: unknown, fallback: number, field: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `os.fs.archive.extract: \`limits.${field}\` must be a positive number`,
    );
  }
  return Math.floor(raw);
}

function buildApprovalPreview(args: {
  source: string;
  dest: string;
  overwrite: boolean;
  followSymlinks: boolean;
  limits: ExtractLimits;
  include: readonly string[] | undefined;
}): string {
  const lines = [
    `source: ${args.source}`,
    `dest:   ${args.dest}`,
    `overwrite: ${args.overwrite}`,
    `followSymlinks: ${args.followSymlinks}`,
    `limits: ${args.limits.maxTotalBytes}B total / ${args.limits.maxEntryBytes}B per entry / ${args.limits.maxEntries} entries`,
  ];
  if (args.include && args.include.length > 0) {
    lines.push(`include: ${args.include.join(", ")}`);
  }
  return lines.join("\n");
}

function formatReport(
  report: {
    extractedEntries: number;
    totalBytesWritten: number;
    skippedEntries: Array<{ path: string; reason: string }>;
    warnings: string[];
  },
  destDir: string,
): string {
  const lines = [
    `extracted ${report.extractedEntries} entries (${report.totalBytesWritten} bytes) to ${destDir}`,
  ];
  if (report.skippedEntries.length > 0) {
    lines.push(`skipped ${report.skippedEntries.length} entries:`);
    for (const s of report.skippedEntries.slice(0, 20)) {
      lines.push(`  - ${s.path}: ${s.reason}`);
    }
    if (report.skippedEntries.length > 20) {
      lines.push(`  … ${report.skippedEntries.length - 20} more skipped`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push(`warnings:`);
    for (const w of report.warnings.slice(0, 20)) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join("\n");
}
