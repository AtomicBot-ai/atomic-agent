import { open, readdir, readlink, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  scanSkillFiles,
  type ScannableFile,
  type SkillScanFinding,
  type SkillScanResult,
} from "./skill-security-scanner.js";

/**
 * Read a skill directory from disk and run the heuristic scanner over it.
 * Every install path scans the bytes it is about to install: GitHub taps
 * (after download), ClawHub (after extracting the ZIP) and local folders
 * (after copying into a private staging dir, so the scanned copy is the
 * installed copy).
 *
 * Every regular file is read, whatever its name, because a script can
 * source or exec any other file in the skill. Nothing is skipped silently:
 *  - text is decoded as UTF-8, or UTF-16 LE/BE (BOM, or the zero-byte
 *    pattern of UTF-16 without one); anything else with NUL bytes is
 *    `binary` and gets an `unscanned-binary` finding;
 *  - a file up to {@link SCAN_FULL_BYTES} is scanned whole; a bigger one
 *    has its first and last {@link SCAN_EDGE_BYTES} scanned and is marked
 *    `truncated` (an `oversized-file` finding);
 *  - files past the {@link SCAN_TOTAL_BYTES} budget, unreadable files and
 *    symlinks pointing outside the skill are `dangerous` `unscanned-file`
 *    findings. A symlink inside the skill adds nothing: its target is
 *    scanned as its own file.
 * For unread content in docs/data versus scripts see `unreadSeverity`.
 * Reads are bounded: a multi-gigabyte file costs a few small reads.
 */
export const SCAN_FULL_BYTES = 4 * 1024 * 1024;
export const SCAN_EDGE_BYTES = 512 * 1024;
export const SCAN_TOTAL_BYTES = 64 * 1024 * 1024;
/** Bytes sniffed to tell text from binary and pick the encoding. */
const SNIFF_BYTES = 8 * 1024;

export interface ScanLimits {
  fullBytes?: number;
  edgeBytes?: number;
  totalBytes?: number;
}

export type UnscannedReason = "over-budget" | "unreadable" | "symlink-outside";

export interface UnscannedFile {
  path: string;
  reason: UnscannedReason;
}

export interface CollectedSkillFiles {
  files: ScannableFile[];
  /** Files whose bytes the rules never saw, with why. */
  unscanned: UnscannedFile[];
}

type TextEncodingKind = "utf8" | "utf16le" | "utf16be" | "binary";

interface SniffResult {
  encoding: TextEncodingKind;
  /** Bytes of BOM to skip at the start of the file. */
  bomBytes: number;
}

/** Pick the encoding from the first bytes of a file. Exported for tests. */
export function sniffEncoding(head: Buffer): SniffResult {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { encoding: "utf8", bomBytes: 3 };
  }
  if (head[0] === 0xff && head[1] === 0xfe) {
    return { encoding: "utf16le", bomBytes: 2 };
  }
  if (head[0] === 0xfe && head[1] === 0xff) {
    return { encoding: "utf16be", bomBytes: 2 };
  }
  if (!head.includes(0)) return { encoding: "utf8", bomBytes: 0 };
  // No BOM but NUL bytes: UTF-16 text has its zero bytes almost all on
  // one side (ASCII as `x\0` in LE, `\0x` in BE). Anything else is binary.
  const pairs = Math.floor(head.length / 2);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i + 1 < head.length; i += 2) {
    if (head[i] === 0) evenZeros++;
    if (head[i + 1] === 0) oddZeros++;
  }
  if (pairs > 0 && oddZeros >= pairs * 0.4 && evenZeros <= pairs * 0.05) {
    return { encoding: "utf16le", bomBytes: 0 };
  }
  if (pairs > 0 && evenZeros >= pairs * 0.4 && oddZeros <= pairs * 0.05) {
    return { encoding: "utf16be", bomBytes: 0 };
  }
  return { encoding: "binary", bomBytes: 0 };
}

function decode(buf: Buffer, encoding: TextEncodingKind): string {
  if (encoding === "utf16le") return buf.toString("utf16le");
  if (encoding === "utf16be") {
    const swapped = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8");
}

export async function collectScannableFiles(
  root: string,
  limits: ScanLimits = {},
): Promise<CollectedSkillFiles> {
  const fullBytes = limits.fullBytes ?? SCAN_FULL_BYTES;
  const edgeBytes = limits.edgeBytes ?? SCAN_EDGE_BYTES;
  let budget = limits.totalBytes ?? SCAN_TOTAL_BYTES;
  const absRoot = resolve(root);
  const files: ScannableFile[] = [];
  const unscanned: UnscannedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(absRoot, abs).split("\\").join("/");
      if (entry.isSymbolicLink()) {
        // Never followed. A link inside the skill is harmless here (its
        // target is walked on its own); one leaving it points at bytes
        // nobody scanned, and the install copies the link itself.
        const target = await readlink(abs).catch(() => null);
        const resolved = target === null ? null : resolve(dirname(abs), target);
        const inside =
          resolved !== null &&
          (resolved === absRoot || resolved.startsWith(absRoot + sep));
        if (!inside) unscanned.push({ path: rel, reason: "symlink-outside" });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        unscanned.push({ path: rel, reason: "unreadable" });
        continue;
      }
      const toRead = size <= fullBytes ? size : edgeBytes * 2;
      if (toRead > budget) {
        unscanned.push({ path: rel, reason: "over-budget" });
        continue;
      }
      budget -= toRead;
      try {
        files.push(
          await readScannable(abs, rel, size, fullBytes, edgeBytes),
        );
      } catch {
        unscanned.push({ path: rel, reason: "unreadable" });
      }
    }
  }

  await walk(absRoot);
  return { files, unscanned };
}

async function readScannable(
  abs: string,
  rel: string,
  size: number,
  fullBytes: number,
  edgeBytes: number,
): Promise<ScannableFile> {
  const handle = await open(abs, "r");
  try {
    const read = async (length: number, position: number) => {
      const buf = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      return buf.subarray(0, bytesRead);
    };
    const sniffed = sniffEncoding(await read(Math.min(size, SNIFF_BYTES), 0));
    if (sniffed.encoding === "binary") {
      const head = await read(Math.min(size, 2), 0);
      return { path: rel, content: head.toString("latin1"), binary: true };
    }
    const start = sniffed.bomBytes;
    if (size <= fullBytes) {
      return {
        path: rel,
        content: decode(await read(size - start, start), sniffed.encoding),
      };
    }
    let tailStart = size - edgeBytes;
    // UTF-16 code units start on even offsets (the BOM is 2 bytes).
    if (sniffed.encoding !== "utf8" && (tailStart - start) % 2 !== 0) {
      tailStart += 1;
    }
    const head = decode(await read(edgeBytes, start), sniffed.encoding);
    const tail = decode(
      await read(size - tailStart, tailStart),
      sniffed.encoding,
    );
    return { path: rel, content: `${head}\n${tail}`, truncated: true };
  } finally {
    await handle.close();
  }
}

const UNSCANNED_EXCERPT: Record<UnscannedReason, string> = {
  "over-budget": "not scanned: the skill is larger than the scan budget",
  unreadable: "not scanned: the file could not be read",
  "symlink-outside":
    "symlink pointing outside the skill: its target was not scanned",
};

/**
 * Collect + scan in one call. Unread files are `dangerous`: an attacker
 * controls which file falls past the budget or where a link points.
 */
export async function scanSkillDir(
  root: string,
  limits: ScanLimits = {},
): Promise<SkillScanResult & CollectedSkillFiles> {
  const collected = await collectScannableFiles(root, limits);
  const result = scanSkillFiles(collected.files);
  if (collected.unscanned.length === 0) return { ...result, ...collected };
  const extra: SkillScanFinding[] = collected.unscanned.map((u) => ({
    severity: "dangerous",
    rule: "unscanned-file",
    file: u.path,
    line: 0,
    excerpt: UNSCANNED_EXCERPT[u.reason],
  }));
  return {
    verdict: "dangerous",
    findings: [...result.findings, ...extra],
    ...collected,
  };
}
