import { mkdir, writeFile, symlink, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import JSZip from "jszip";
import type {
  ArchiveBackend,
  ArchiveEntry,
  ArchiveEntryKind,
  ExtractOptions,
  ExtractReport,
} from "./archive-types.js";
import {
  ExtractBudget,
  describeSanitizationError,
  sanitizeEntryPath,
} from "./archive-safety.js";

/**
 * JSZip-based backend. JSZip loads the whole archive into memory, which is
 * acceptable here because the extract tool already caps total bytes. For
 * `list` we just need the central directory metadata JSZip exposes via
 * `zip.files`.
 *
 * Unix-mode is stored in the external attributes high bits. We inspect
 * them to detect symlinks; JSZip doesn't expose a high-level "is symlink"
 * property, so we decode the Unix mode field ourselves.
 */
export class ZipBackend implements ArchiveBackend {
  readonly format = "zip" as const;

  async list(data: Buffer): Promise<ArchiveEntry[]> {
    const zip = await JSZip.loadAsync(data);
    const entries: ArchiveEntry[] = [];
    for (const [name, file] of Object.entries(zip.files)) {
      const kind = classifyZipEntry(name, file);
      const entry: ArchiveEntry = {
        path: stripTrailingSlash(name),
        kind,
        mtime: file.date,
      };
      const rawSize = (file as JSZipObjectInternal)._data?.uncompressedSize;
      if (typeof rawSize === "number") entry.size = rawSize;
      const rawCompressed = (file as JSZipObjectInternal)._data?.compressedSize;
      if (typeof rawCompressed === "number") entry.compressedSize = rawCompressed;
      if (kind === "symlink") {
        entry.linkTarget = (await file.async("string")).trim();
      }
      entries.push(entry);
    }
    return entries;
  }

  async readEntry(data: Buffer, path: string): Promise<Buffer> {
    const zip = await JSZip.loadAsync(data);
    const file = zip.file(path);
    if (!file || file.dir) {
      throw new Error(`entry not found or is a directory: ${path}`);
    }
    const nodeBuf = await file.async("nodebuffer");
    return nodeBuf;
  }

  async extract(data: Buffer, options: ExtractOptions): Promise<ExtractReport> {
    const zip = await JSZip.loadAsync(data);
    const budget = new ExtractBudget(options.limits);
    const report: ExtractReport = {
      extractedEntries: 0,
      totalBytesWritten: 0,
      skippedEntries: [],
      warnings: [],
    };

    const includeMatches = (p: string) =>
      !options.include || options.include.length === 0
        ? true
        : options.include.some((prefix) => p === prefix || p.startsWith(prefix + "/"));

    for (const [rawName, file] of Object.entries(zip.files)) {
      const kind = classifyZipEntry(rawName, file);
      const sanitized = sanitizeEntryPath(options.destDir, rawName);
      if (!sanitized.ok) {
        report.skippedEntries.push({
          path: rawName,
          reason: describeSanitizationError(rawName, sanitized.error),
        });
        continue;
      }
      if (!includeMatches(sanitized.value.normalised)) continue;

      if (kind === "directory") {
        await mkdir(sanitized.value.absolute, { recursive: true });
        continue;
      }

      if (kind === "symlink") {
        if (!options.followSymlinks) {
          report.skippedEntries.push({
            path: sanitized.value.normalised,
            reason: "symlink entries require followSymlinks=true",
          });
          continue;
        }
        const target = (await file.async("string")).trim();
        // Re-sanitise the link target relative to the symlink's parent so
        // the symlink cannot point outside destDir either.
        const linkParent = dirname(sanitized.value.normalised);
        const resolvedTarget = sanitizeEntryPath(
          options.destDir,
          linkParent === "." ? target : `${linkParent}/${target}`,
        );
        if (!resolvedTarget.ok) {
          report.skippedEntries.push({
            path: sanitized.value.normalised,
            reason: `symlink target escapes destDir: ${target}`,
          });
          continue;
        }
        await mkdir(dirname(sanitized.value.absolute), { recursive: true });
        try {
          await symlink(target, sanitized.value.absolute);
          report.extractedEntries++;
        } catch (err) {
          report.warnings.push(
            `failed to create symlink ${sanitized.value.normalised}: ${(err as Error).message}`,
          );
        }
        continue;
      }

      const nodeBuf = await file.async("nodebuffer");
      const decision = budget.chargeEntry(nodeBuf.length);
      if (!decision.ok) {
        report.skippedEntries.push({
          path: sanitized.value.normalised,
          reason: decision.reason,
        });
        continue;
      }

      if (!options.overwrite && (await pathExists(sanitized.value.absolute))) {
        report.skippedEntries.push({
          path: sanitized.value.normalised,
          reason: "destination exists and overwrite=false",
        });
        continue;
      }

      await mkdir(dirname(sanitized.value.absolute), { recursive: true });
      await writeFile(sanitized.value.absolute, nodeBuf);
      report.extractedEntries++;
      report.totalBytesWritten += nodeBuf.length;
    }

    return report;
  }
}

function classifyZipEntry(name: string, file: JSZip.JSZipObject): ArchiveEntryKind {
  if (file.dir || name.endsWith("/")) return "directory";
  if (isUnixSymlink(file)) return "symlink";
  return "file";
}

function isUnixSymlink(file: JSZip.JSZipObject): boolean {
  const ext = (file as JSZipObjectInternal).unixPermissions;
  if (typeof ext !== "number") return false;
  // Unix file type field is in the high bits of the mode.
  // S_IFLNK = 0o120000.
  return (ext & 0o170000) === 0o120000;
}

function stripTrailingSlash(p: string): string {
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSZip stores compressed/uncompressed sizes and permission bits on
 * internal fields that aren't part of the public typings. We use a
 * structural cast rather than `any` to keep the rest of the file strict.
 */
interface JSZipObjectInternal {
  _data?: {
    uncompressedSize?: number;
    compressedSize?: number;
  };
  unixPermissions?: number | string | null;
}
