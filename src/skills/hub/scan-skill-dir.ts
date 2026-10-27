import { open, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  isScannable,
  scanSkillFiles,
  type ScannableFile,
  type SkillScanFinding,
  type SkillScanResult,
} from "./skill-security-scanner.js";

/**
 * Read a skill directory from disk and run the heuristic scanner over it.
 * Used by every install path that has the files on disk: ClawHub (after
 * extracting the ZIP) and local-folder installs (CLI, HTTP, sidecar).
 *
 * Large files are NOT skipped. Skipping them was the padded-file trick:
 * pad a README or script past the size cap and the payload after the
 * padding is never read. Instead:
 *  - a scannable file up to {@link SCAN_FULL_BYTES} is scanned whole;
 *  - a bigger one has its first and last {@link SCAN_EDGE_BYTES} scanned
 *    and is marked `truncated`, which the scanner turns into a `caution`
 *    finding, so the operator has to confirm;
 *  - once {@link SCAN_TOTAL_BYTES} have been read for one skill, the rest
 *    is not read and a single `caution` finding says so.
 * Reads are bounded, so a multi-gigabyte file costs two small reads, not
 * a full load into memory.
 */
export const SCAN_FULL_BYTES = 4 * 1024 * 1024;
export const SCAN_EDGE_BYTES = 512 * 1024;
export const SCAN_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ScanLimits {
  fullBytes?: number;
  edgeBytes?: number;
  totalBytes?: number;
}

export interface CollectedSkillFiles {
  files: ScannableFile[];
  /**
   * Files left unread: scannable files past the total budget, unreadable
   * files, and symlinks (never followed).
   */
  unscanned: string[];
}

export async function collectScannableFiles(
  root: string,
  limits: ScanLimits = {},
): Promise<CollectedSkillFiles> {
  const fullBytes = limits.fullBytes ?? SCAN_FULL_BYTES;
  const edgeBytes = limits.edgeBytes ?? SCAN_EDGE_BYTES;
  let budget = limits.totalBytes ?? SCAN_TOTAL_BYTES;
  const files: ScannableFile[] = [];
  const unscanned: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const rel = relative(root, abs).split("\\").join("/");
      if (entry.isSymbolicLink()) {
        // Not followed (it may point outside the skill), so its target is
        // never read. The install copies the link itself: flag it.
        unscanned.push(rel);
        continue;
      }
      if (!entry.isFile() || !isScannable(rel)) continue;
      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      const toRead = size <= fullBytes ? size : edgeBytes * 2;
      if (toRead > budget) {
        unscanned.push(rel);
        continue;
      }
      budget -= toRead;
      try {
        files.push(await readScannable(abs, rel, size, fullBytes, edgeBytes));
      } catch {
        // Unreadable file: report it rather than silently passing it.
        unscanned.push(rel);
      }
    }
  }

  await walk(root);
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
    if (size <= fullBytes) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buf, 0, size, 0);
      const content = buf.subarray(0, bytesRead).toString("utf8");
      return { path: rel, content };
    }
    const head = Buffer.alloc(edgeBytes);
    const tail = Buffer.alloc(edgeBytes);
    const h = await handle.read(head, 0, edgeBytes, 0);
    const t = await handle.read(tail, 0, edgeBytes, size - edgeBytes);
    return {
      path: rel,
      content: [
        head.subarray(0, h.bytesRead).toString("utf8"),
        tail.subarray(0, t.bytesRead).toString("utf8"),
      ].join("\n"),
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}

/** Collect + scan in one call; unread files become `caution` findings. */
export async function scanSkillDir(
  root: string,
  limits: ScanLimits = {},
): Promise<SkillScanResult & CollectedSkillFiles> {
  const collected = await collectScannableFiles(root, limits);
  const result = scanSkillFiles(collected.files);
  if (collected.unscanned.length === 0) return { ...result, ...collected };
  const extra: SkillScanFinding[] = collected.unscanned.map((file) => ({
    severity: "caution",
    rule: "unscanned-file",
    file,
    line: 0,
    excerpt:
      "not scanned: a symlink, unreadable, or past the skill's scan budget",
  }));
  const findings = [...result.findings, ...extra];
  return {
    verdict: result.verdict === "dangerous" ? "dangerous" : "caution",
    findings,
    ...collected,
  };
}
