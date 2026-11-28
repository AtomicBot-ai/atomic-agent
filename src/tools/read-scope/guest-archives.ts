import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

import {
  isGzipMagic,
  isTarMagic,
  isZipMagic,
} from "../os/archive/format-detector.js";

/**
 * Archives a channel guest never gets as raw bytes (ATO-2805).
 *
 * `os.fs.archive.read_entry` and `list` judge each entry name for a
 * guest, but an archive also reaches a guest whole: as a `reply`
 * attachment (the guest unpacks it at home), through `os.fs.read` of an
 * uncompressed tar or stored zip (the entries are plain text in the
 * bytes), or as a nested archive read through `read_entry`. None of
 * those see the names inside. So, fail closed and without unpacking
 * anything: a guest's call is refused when the file it names is an
 * archive by its name or by its first and last bytes, except for the
 * two archive tools (which judge entries themselves) and the document
 * extractor on an office file (it returns the text, never the bytes).
 *
 * Detection is bounded: 512 bytes from the start and 64 KiB + 22 from
 * the end (a zip's end-of-central-directory record, which also finds a
 * zip with a prefix such as a self-extractor). A file that cannot be
 * opened is left to the tool, which fails on it the same way.
 *
 * Precedent: Claude Code and Codex never hand a sandboxed reader a file
 * they cannot see into; mail filters (Gmail, Microsoft Defender) block
 * archives they cannot scan rather than pass them.
 */

/** Archive and compressed-file extensions (lowercase, no dot). */
const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  "zip", "zipx", "jar", "war", "ear", "apk", "aar", "whl", "nupkg", "xpi", "crx", "ipa",
  "tar", "tgz", "tbz", "tbz2", "txz", "tzst", "tlz", "taz",
  "gz", "gzip", "bz2", "bzip2", "xz", "lzma", "lz", "lz4", "zst", "zstd", "z", "sz", "br",
  "7z", "rar", "cab", "cpio", "ar", "deb", "rpm", "iso", "dmg", "pkg", "xar", "arj", "lzh", "lha", "ace", "wim",
]);

/**
 * Zip containers that are documents: the extractor reads their text, so
 * a guest may pass them to it; any other tool would hand over the bytes.
 */
export const OFFICE_ZIP_EXTENSIONS: ReadonlySet<string> = new Set([
  "docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "odt", "ods", "odp", "epub",
]);

function extensionsOf(name: string): string[] {
  const parts = basename(name).toLowerCase().split(".");
  return parts.length < 2 ? [] : parts.slice(1);
}

/** True when the name's last extension is an archive's (`backup.tar.gz`, `app.jar`). */
export function hasArchiveName(name: string): boolean {
  const exts = extensionsOf(name);
  const last = exts[exts.length - 1];
  return last !== undefined && (ARCHIVE_EXTENSIONS.has(last) || OFFICE_ZIP_EXTENSIONS.has(last));
}

/** True when the name ends in an office document extension. */
export function hasOfficeZipName(name: string): boolean {
  const exts = extensionsOf(name);
  const last = exts[exts.length - 1];
  return last !== undefined && OFFICE_ZIP_EXTENSIONS.has(last);
}

function startsWith(head: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

/** An old (v7) tar header: no `ustar` magic, but its checksum adds up. */
function isV7TarHeader(head: Buffer): boolean {
  if (head.length < 512 || head[0] === 0) return false;
  const field = head.subarray(148, 156).toString("ascii").replace(/[\0 ]+$/g, "").trim();
  if (!/^[0-7]{1,7}$/.test(field)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : head[i]!;
  return sum === parseInt(field, 8);
}

/** True when `head` (the first bytes) starts like an archive or a compressed stream. */
export function hasArchiveHead(head: Buffer): boolean {
  return (
    isZipMagic(head) ||
    isGzipMagic(head) ||
    isTarMagic(head) ||
    isV7TarHeader(head) ||
    startsWith(head, [0x42, 0x5a, 0x68]) || // bzip2 "BZh"
    startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) || // xz
    startsWith(head, [0x5d, 0x00, 0x00]) || // lzma alone
    startsWith(head, [0x28, 0xb5, 0x2f, 0xfd]) || // zstd
    startsWith(head, [0x04, 0x22, 0x4d, 0x18]) || // lz4 frame
    startsWith(head, [0x4c, 0x5a, 0x49, 0x50]) || // lzip "LZIP"
    startsWith(head, [0x1f, 0x9d]) || // compress (.Z)
    startsWith(head, [0x1f, 0xa0]) || // compress (LZH)
    startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || // 7z
    startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) || // rar "Rar!"
    startsWith(head, [0x4d, 0x53, 0x43, 0x46]) || // cab "MSCF"
    startsWith(head, [0x78, 0x61, 0x72, 0x21]) || // xar "xar!"
    startsWith(head, [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]) || // ar "!<arch>\n"
    startsWith(head, [0x30, 0x37, 0x30, 0x37, 0x30]) || // cpio ASCII "07070"
    startsWith(head, [0xc7, 0x71]) || startsWith(head, [0x71, 0xc7]) // cpio binary
  );
}

/** True when `tail` (the last bytes) holds a zip end-of-central-directory record. */
export function hasZipTail(tail: Buffer): boolean {
  return tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
}

const HEAD_BYTES = 512;
const TAIL_BYTES = 65_536 + 22;

/** True when the bytes (a whole entry body) look like an archive. */
export function isArchiveBytes(data: Buffer): boolean {
  return (
    hasArchiveHead(data.subarray(0, HEAD_BYTES)) ||
    hasZipTail(data.subarray(Math.max(0, data.length - TAIL_BYTES)))
  );
}

/**
 * True when the regular file at `absolute` is an archive by its bytes.
 * A folder, a missing or unreadable file is `false`: the name check and
 * the tool itself cover those.
 */
export function isArchiveFileContent(absolute: string): boolean {
  let fd: number;
  try {
    fd = openSync(absolute, "r");
  } catch {
    return false;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    readSync(fd, head, 0, head.length, 0);
    if (hasArchiveHead(head)) return true;
    const tailLength = Math.min(TAIL_BYTES, stat.size);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, stat.size - tailLength);
    return hasZipTail(tail);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

function isDirectory(absolute: string): boolean {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/** Tools that judge each entry of an archive themselves (`os/archive`). */
const ENTRY_AWARE_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.archive.list",
  "os.fs.archive.read_entry",
]);

/** Tools that return a file's name, size or hash, never its bytes. */
const NAME_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.list",
  "os.fs.watch",
  "os.fs.hash",
  "os.fs.glob",
]);

/** Document formats the extractor reads out of a zip container. */
const OFFICE_FORMATS: ReadonlySet<string> = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"]);

/**
 * Why a guest's `tool` may not take the file at `absolute`, or `null`.
 * See the module note for what passes.
 */
export function guestArchiveDenial(
  tool: string,
  args: Record<string, unknown>,
  absolute: string,
): string | null {
  if (ENTRY_AWARE_TOOLS.has(tool) || NAME_ONLY_TOOLS.has(tool)) return null;
  // A folder named `x.zip` is walked file by file, not handed over whole.
  if (isDirectory(absolute)) return null;
  if (tool === "os.fs.read_document" && hasOfficeZipName(absolute)) {
    // The extractor of the named format returns text only; `plain` or any
    // other override would read the container as text.
    const format = args.format;
    if (format === undefined || format === null || (typeof format === "string" && OFFICE_FORMATS.has(format))) {
      return null;
    }
  }
  if (hasArchiveName(absolute) || isArchiveFileContent(absolute)) {
    return `${absolute} is an archive, and a guest gets only the entries os.fs.archive.read_entry checks`;
  }
  return null;
}
