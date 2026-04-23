import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { resolveUserPath } from "../expand-home.js";
import type { ArchiveBackend, ArchiveFormat } from "./archive-types.js";
import { detectArchiveFormat } from "./format-detector.js";
import { ZipBackend } from "./zip-backend.js";
import { TarBackend } from "./tar-backend.js";
import { GzipBackend } from "./gz-backend.js";

export interface ArchiveBackendFactories {
  zip?: () => ArchiveBackend;
  tar?: () => ArchiveBackend;
  "tar.gz"?: () => ArchiveBackend;
  gz?: (filename: string) => ArchiveBackend;
}

export interface ResolvedArchive {
  absolute: string;
  filename: string;
  data: Buffer;
  format: ArchiveFormat;
  backend: ArchiveBackend;
}

/**
 * Load an archive file, detect its format, and instantiate the matching
 * backend. Both extension and magic bytes are consulted — see
 * `detectArchiveFormat` for the rules. `formatOverride` short-circuits
 * detection for cases where the extension lies (e.g. a `.bin` file that is
 * actually a tarball).
 *
 * The factories arg is a test seam so unit tests can swap in mock backends
 * without going through the real pdfjs/tar-stream stack.
 */
export async function resolveArchive(
  path: string,
  workingDir: string,
  formatOverride: ArchiveFormat | undefined,
  factories: ArchiveBackendFactories = {},
): Promise<ResolvedArchive> {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("archive: `path` must be a non-empty string");
  }
  const absolute = resolveUserPath(path, workingDir);
  const info = await stat(absolute);
  if (!info.isFile()) {
    throw new Error(`archive: ${absolute} is not a regular file`);
  }
  const data = await readFile(absolute);
  const filename = basename(absolute);
  // Peek at the first 512 bytes (enough for ustar magic + zip/gz headers)
  // without copying the whole payload again.
  const head = data.subarray(0, Math.min(data.length, 512));
  const format =
    formatOverride ?? detectArchiveFormat(filename, Buffer.from(head));
  if (!format) {
    throw new Error(
      `archive: could not detect format for ${filename} (supported: zip, tar, tar.gz, gz)`,
    );
  }
  const backend = instantiateBackend(format, filename, factories);
  return { absolute, filename, data, format, backend };
}

function instantiateBackend(
  format: ArchiveFormat,
  filename: string,
  factories: ArchiveBackendFactories,
): ArchiveBackend {
  switch (format) {
    case "zip":
      return factories.zip?.() ?? new ZipBackend();
    case "tar":
      return factories.tar?.() ?? new TarBackend("tar");
    case "tar.gz":
      return factories["tar.gz"]?.() ?? new TarBackend("tar.gz");
    case "gz":
      return factories.gz?.(filename) ?? new GzipBackend(filename);
  }
}

export function parseFormatOverride(raw: unknown): ArchiveFormat | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error("archive: `format` must be a string");
  }
  const normalised = raw.toLowerCase();
  if (
    normalised === "zip" ||
    normalised === "tar" ||
    normalised === "tar.gz" ||
    normalised === "gz"
  ) {
    return normalised;
  }
  throw new Error(`archive: unknown format override ${JSON.stringify(raw)}`);
}
