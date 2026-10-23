import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  retainToolOutput,
  type CompressedToolResult,
} from "../compressor/result-compressor.js";

/**
 * Full output of a clipped tool result, kept in a file (ATO-663).
 *
 * On a local model the compressor cuts a long log down to its last lines
 * and the rest is gone: the model can only run the command again. Cloud
 * mode already promotes the complete output (`fullToolResult`); local
 * mode keeps the short summary, and now also writes the complete output
 * to a file of the session and leads the summary with its path, so the
 * model can read just the slice it needs with `os.fs.read` and an
 * `offset` / `limit`.
 *
 * What is written is exactly the result's `fullOutput`: the text the
 * summary was cut from, after the tool's own scrubbing (git push and
 * friends remove tokens before the compressor ever sees the text), so
 * the file never carries anything the summary's source did not. On top
 * of that only an allowlist of tools spills (`SPILL_TOOLS`): commands,
 * listings, searches and diffs. Tools that read the clipboard, mail,
 * HTTP responses or memory never write a file, and neither do file
 * readers, whose source already is a file.
 *
 * Where: `<tmp>/atomic-agent-tool-outputs/<session>/`. The temp folder is
 * already in every session's read scope, and the session's own folder is
 * added to a worker's (`read-scope.ts`), so the model can open the path
 * it is given. Folders are created owner-only. Bounded per file and per
 * session; removed when the session is deleted, and folders untouched
 * for `STALE_SPILL_MS` are swept at start (fusion workers are never
 * stored, so this is what clears theirs).
 *
 * Any failure to write is silence: the result goes back unchanged.
 */

/** The tools whose clipped output is worth a file, and that carry no private stores. */
export const SPILL_TOOLS: ReadonlySet<string> = new Set([
  "os.shell.run",
  "skill.run_script",
  "os.git.diff",
  "os.git.log",
  "os.git.show",
  "os.git.blame",
  "os.git.status",
  "os.fs.grep",
  "os.fs.glob",
  "os.fs.list",
  "os.fs.diff",
  "os.fs.archive.list",
  "os.proc.list",
]);

/** Largest file one result writes; longer output keeps its head and says so. */
export const SPILL_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Total a session may spill; past it results stay as they are. */
export const SPILL_MAX_SESSION_BYTES = 50 * 1024 * 1024;

/** A session folder untouched this long is swept at start. */
export const STALE_SPILL_MS = 7 * 24 * 60 * 60 * 1000;

/** `details` key carrying the saved file's absolute path. */
export const FULL_OUTPUT_PATH_DETAIL = "fullOutputPath";

const BASE_NAME = "atomic-agent-tool-outputs";

/** Base folder for every session's spill folders. Read per call so `TMPDIR` is honoured. */
export function toolOutputBaseDir(): string {
  return join(tmpdir(), BASE_NAME);
}

/** The folder one session's outputs go to. */
export function toolOutputDir(
  sessionId: string,
  baseDir: string = toolOutputBaseDir(),
): string {
  return join(baseDir, safeSegment(sessionId));
}

export interface ToolOutputSpillOptions {
  /** Defaults to `toolOutputBaseDir()`. */
  baseDir?: string;
  maxFileBytes?: number;
  maxSessionBytes?: number;
}

export class ToolOutputSpill {
  private readonly baseDir: string | undefined;
  private readonly maxFileBytes: number;
  private readonly maxSessionBytes: number;
  private readonly used = new Map<string, number>();
  private readonly counters = new Map<string, number>();

  constructor(options: ToolOutputSpillOptions = {}) {
    this.baseDir = options.baseDir;
    this.maxFileBytes = options.maxFileBytes ?? SPILL_MAX_FILE_BYTES;
    this.maxSessionBytes = options.maxSessionBytes ?? SPILL_MAX_SESSION_BYTES;
  }

  /** The folder `sessionId` spills into. */
  dirFor(sessionId: string): string {
    return toolOutputDir(sessionId, this.baseDir ?? toolOutputBaseDir());
  }

  /**
   * `result` with its full output saved and the path leading the
   * summary, or `result` itself when it was not clipped, the tool is not
   * on the allowlist, the session's budget is spent or the write failed.
   */
  async spill(
    tool: string,
    sessionId: string,
    result: CompressedToolResult,
  ): Promise<CompressedToolResult> {
    const full = result.fullOutput;
    if (!SPILL_TOOLS.has(tool) || !result.truncated || full === undefined) {
      return result;
    }
    if (full.length <= result.summary.length) return result;
    const bytes = Buffer.byteLength(full, "utf8");
    const kept = Math.min(bytes, this.maxFileBytes);
    const used = this.used.get(sessionId) ?? 0;
    if (used + kept > this.maxSessionBytes) return result;
    try {
      const dir = this.ensureDir(sessionId);
      const index = (this.counters.get(sessionId) ?? 0) + 1;
      this.counters.set(sessionId, index);
      // The random part keeps names unique when a session resumes after
      // a restart and the counter starts again from 1.
      const path = join(
        dir,
        `${String(index).padStart(4, "0")}-${randomBytes(3).toString("hex")}-${fileStem(tool)}.txt`,
      );
      const body =
        bytes > this.maxFileBytes
          ? `${Buffer.from(full, "utf8").subarray(0, this.maxFileBytes).toString("utf8")}\n[output cut at ${this.maxFileBytes} bytes of ${bytes}]\n`
          : full;
      await writeFile(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      this.used.set(sessionId, used + kept);
      const note = spillNote(path, countLines(full), bytes > this.maxFileBytes);
      return retainToolOutput(
        result,
        {
          ...result,
          summary: `${note}\n${result.summary}`,
          details: { ...result.details, [FULL_OUTPUT_PATH_DETAIL]: path },
        },
        { prefix: `${note}\n` },
      );
    } catch {
      return result;
    }
  }

  /** Remove one session's folder. Best effort. */
  removeSession(sessionId: string): void {
    this.used.delete(sessionId);
    this.counters.delete(sessionId);
    removeInside(this.baseDir ?? toolOutputBaseDir(), this.dirFor(sessionId));
  }

  /** Remove session folders not touched for `maxAgeMs`. Best effort; returns how many went. */
  sweepStale(maxAgeMs: number = STALE_SPILL_MS, now: number = Date.now()): number {
    const base = this.baseDir ?? toolOutputBaseDir();
    let removed = 0;
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      return 0;
    }
    for (const name of names) {
      const dir = join(base, name);
      try {
        if (now - statSync(dir).mtimeMs < maxAgeMs) continue;
      } catch {
        continue;
      }
      if (removeInside(base, dir)) removed += 1;
    }
    return removed;
  }

  /**
   * Create the session folder owner-only, and refuse one that is a
   * symlink or belongs to someone else: on a shared `/tmp` another user
   * could have made it first.
   */
  private ensureDir(sessionId: string): string {
    const base = this.baseDir ?? toolOutputBaseDir();
    const dir = this.dirFor(sessionId);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const path of [base, dir]) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("tool output folder is not a plain directory");
      }
      const uid = process.getuid?.();
      if (uid !== undefined && info.uid !== uid) {
        throw new Error("tool output folder belongs to another user");
      }
    }
    return dir;
  }
}

/** First line of a spilled result's summary. */
export function spillNote(path: string, lines: number, cut: boolean): string {
  const size = `${lines} line${lines === 1 ? "" : "s"}`;
  return cut
    ? `[output clipped; the first part of it (${size} in all) is saved in ${path}. Read the part you need with os.fs.read and offset/limit instead of running this again.]`
    : `[output clipped; all ${size} are saved in ${path}. Read the part you need with os.fs.read and offset/limit instead of running this again.]`;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function fileStem(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
}

/** A session id as one safe path segment. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 120);
  return cleaned.length > 0 ? cleaned : "_";
}

function removeInside(base: string, dir: string): boolean {
  if (!resolve(dir).startsWith(`${resolve(base)}${sep}`)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
