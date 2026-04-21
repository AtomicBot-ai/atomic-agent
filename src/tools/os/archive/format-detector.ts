import type { ArchiveFormat } from "./archive-types.js";

/**
 * Detect archive format via extension first (fast-path), then by magic
 * bytes (authoritative). Returns `null` when the format is unsupported or
 * cannot be determined with confidence.
 *
 * Magic bytes reference:
 *  - zip:    PK\x03\x04 (or empty PK\x05\x06 / spanned PK\x07\x08)
 *  - gz:     1F 8B
 *  - tar:    "ustar" at offset 257 (POSIX tar header)
 *
 * The `.tar.gz` / `.tgz` case is a gz-compressed tar: magic bytes look like
 * a plain gzip stream; we can only distinguish after decompression. We
 * key off the filename and fall back to "gz" (single-file gunzip) for
 * ambiguous names.
 */
export function detectArchiveFormat(
  filename: string,
  head: Buffer,
): ArchiveFormat | null {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".zip")) {
    return isZipMagic(head) ? "zip" : null;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return isGzipMagic(head) ? "tar.gz" : null;
  }
  if (lower.endsWith(".tar")) {
    return isTarMagic(head) ? "tar" : null;
  }
  if (lower.endsWith(".gz")) {
    return isGzipMagic(head) ? "gz" : null;
  }

  // Unknown extension: try magic bytes only, conservatively.
  if (isZipMagic(head)) return "zip";
  if (isTarMagic(head)) return "tar";
  if (isGzipMagic(head)) return "gz";
  return null;
}

export function isZipMagic(head: Buffer): boolean {
  if (head.length < 4) return false;
  const b0 = head[0];
  const b1 = head[1];
  const b2 = head[2];
  const b3 = head[3];
  if (b0 !== 0x50 || b1 !== 0x4b) return false; // "PK"
  // Local file header, central dir, or spanned marker.
  if (b2 === 0x03 && b3 === 0x04) return true;
  if (b2 === 0x05 && b3 === 0x06) return true;
  if (b2 === 0x07 && b3 === 0x08) return true;
  return false;
}

export function isGzipMagic(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

export function isTarMagic(head: Buffer): boolean {
  // POSIX tar stores "ustar" at offset 257; GNU tar variants also use this.
  if (head.length < 265) return false;
  const ustar = head.subarray(257, 263).toString("ascii");
  return ustar === "ustar\0" || ustar.startsWith("ustar ");
}
