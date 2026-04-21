import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, basename } from "node:path";
import { gunzipSync } from "node:zlib";
import type {
  ArchiveBackend,
  ArchiveEntry,
  ExtractOptions,
  ExtractReport,
} from "./archive-types.js";
import { ExtractBudget } from "./archive-safety.js";

/**
 * gzip backend — not really an archive, but a single-file compression
 * container. We present it as an archive with a single synthetic entry
 * whose path is the source filename with `.gz` stripped. This keeps the
 * external tool surface uniform.
 *
 * Because the gzip format does not carry an entry name, the caller must
 * pass the source filename via the extract destination so we can derive
 * the target name. `list` returns the same synthetic name.
 */
export class GzipBackend implements ArchiveBackend {
  readonly format = "gz" as const;

  constructor(private readonly sourceFilename: string) {}

  async list(data: Buffer): Promise<ArchiveEntry[]> {
    const decompressed = gunzipSync(data);
    const entryName = stripGzSuffix(this.sourceFilename);
    return [
      {
        path: entryName,
        kind: "file",
        size: decompressed.length,
        compressedSize: data.length,
      },
    ];
  }

  async readEntry(data: Buffer, path: string): Promise<Buffer> {
    const entryName = stripGzSuffix(this.sourceFilename);
    if (path !== entryName) {
      throw new Error(`entry not found: ${path} (gz contains only ${entryName})`);
    }
    return gunzipSync(data);
  }

  async extract(data: Buffer, options: ExtractOptions): Promise<ExtractReport> {
    const budget = new ExtractBudget(options.limits);
    const report: ExtractReport = {
      extractedEntries: 0,
      totalBytesWritten: 0,
      skippedEntries: [],
      warnings: [],
    };
    const entryName = stripGzSuffix(this.sourceFilename);
    const target = join(options.destDir, entryName);
    const decompressed = gunzipSync(data);
    const decision = budget.chargeEntry(decompressed.length);
    if (!decision.ok) {
      report.skippedEntries.push({ path: entryName, reason: decision.reason });
      return report;
    }
    if (!options.overwrite && (await pathExists(target))) {
      report.skippedEntries.push({
        path: entryName,
        reason: "destination exists and overwrite=false",
      });
      return report;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, decompressed);
    report.extractedEntries = 1;
    report.totalBytesWritten = decompressed.length;
    return report;
  }
}

function stripGzSuffix(filename: string): string {
  const base = basename(filename);
  return base.toLowerCase().endsWith(".gz") ? base.slice(0, -3) : base;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
