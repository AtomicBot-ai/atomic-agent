import { createHash } from "node:crypto";

/**
 * Wire shape shared by `os.fs.read` and the agent-side read-coverage
 * detector (issue #114).
 *
 * The detector needs three things the raw arguments cannot give it: WHICH
 * file the read actually landed on (a symlink and its target are the same
 * file), WHICH version of that file was read, and WHICH lines came back.
 * Requested `offset`/`limit` answer none of them — they are clamped,
 * negative offsets count from the end, and a byte-mode read carries no
 * range at all. So the tool reports the resolved facts here and the
 * detector consumes them instead of re-deriving anything.
 *
 * This module is a leaf on purpose: the tool and the agent both import it,
 * and it pulls in nothing but `node:crypto`.
 */

/** `details` key under which `os.fs.read` publishes `ReadCoverageDetail`. */
export const READ_COVERAGE_DETAIL_KEY = "readCoverage";

export interface ReadCoverageDetail {
  /**
   * Canonical (symlink-resolved) absolute path. Two reads through
   * different links to one file share this identity; `details.path` keeps
   * the path the caller asked for.
   */
  path: string;
  /**
   * Digest of the bytes the read actually looked at — never the file's
   * size or mtime, so a same-size in-place replacement is caught and a
   * touched-but-unchanged file is not.
   *
   * `os.fs.read` always reads the prefix `[0, min(size, maxBytes))`, in
   * both byte and line mode, so this digest covers exactly the region any
   * range of this call can return. Content beyond the byte cap is
   * unobservable through this call and deliberately not fingerprinted: a
   * change out there cannot alter what a repeated read returns. A caller
   * that raises `maxBytes` reads a longer prefix and therefore gets a
   * different digest, which the detector reads as a new version and
   * resets coverage for — a missed repeat, never a false one.
   */
  contentHash: string;
  /**
   * 1-based inclusive line range actually returned. `0`/`0` when the read
   * returned no lines at all (empty file, or an offset past the end).
   */
  startLine: number;
  endLine: number;
  /**
   * Lines visible in the read window (the byte-capped prefix), i.e. the
   * largest `endLine` any range of this call could have returned.
   */
  totalLines: number;
  /**
   * Whether the returned text carried `LINE_NUMBER|` prefixes.
   *
   * Coverage is per rendering as well as per version, because the same
   * lines rendered differently are not the same text: a model that read
   * a file plainly and then re-reads a range with `lineNumbers: true` —
   * the ordinary preparation for a precise edit — genuinely learns
   * something it did not have. Treating that as a repeat would be a
   * false positive, and the notice's "re-reading a covered range returns
   * the same text" would be untrue.
   *
   * Absent on results produced before this field existed (a replayed
   * trace, an older session); `parseReadCoverage` reads a missing value
   * as `false`, which matches the tool's own default.
   */
  numbered: boolean;
  /**
   * Whether the file is larger than this read's byte budget, i.e. there
   * is content past `totalLines` that NO range of this call could reach.
   *
   * The detector still flags repeated reads of an unreachable range —
   * they return nothing and are pure waste — but the remediation it
   * offers has to be different: "read a range you have not covered" is
   * useless advice when the range the model wants is behind the byte
   * cap. See `formatReadRepeatNotice`.
   */
  truncated: boolean;
}

/** Digest of the bytes a read looked at. Short — this is an identity, not a checksum. */
export function hashReadContent(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex").slice(0, 16);
}

/**
 * Split read text into lines the way `os.fs.read` numbers them: a
 * trailing newline produces an empty final element, which is dropped so
 * line numbers line up with typical editor line counts.
 */
export function splitReadLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Read the coverage detail back out of a compressed tool result.
 *
 * Defensive by design: the detector must degrade to "no observation"
 * (and therefore stay silent) rather than throw or invent a range when a
 * result predates this field, comes from a replayed trace, or is
 * malformed. A range is only accepted when it is coherent — a
 * `startLine > endLine`, a negative line, or a non-integer would produce
 * bogus coverage, so all of them are rejected outright.
 */
export function parseReadCoverage(
  details: Record<string, unknown>,
): ReadCoverageDetail | null {
  const raw = details[READ_COVERAGE_DETAIL_KEY];
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const path = record.path;
  const contentHash = record.contentHash;
  if (typeof path !== "string" || path.length === 0) return null;
  if (typeof contentHash !== "string" || contentHash.length === 0) return null;
  const startLine = asLineNumber(record.startLine);
  const endLine = asLineNumber(record.endLine);
  const totalLines = asLineNumber(record.totalLines);
  if (startLine === null || endLine === null || totalLines === null) return null;
  // An empty return is reported as 0/0; anything else must be a real,
  // non-inverted range. A half-zero pair (0/5, 3/0) is incoherent.
  const empty = startLine === 0 && endLine === 0;
  if (!empty && (startLine < 1 || startLine > endLine)) return null;
  // `numbered` and `truncated` are booleans with a meaningful default:
  // an older result that predates them is a plain, un-capped read as far
  // as anything downstream is concerned. Reading them leniently (rather
  // than rejecting the whole detail) keeps the detector working against
  // replayed traces instead of silently switching itself off.
  return {
    path,
    contentHash,
    startLine,
    endLine,
    totalLines,
    numbered: record.numbered === true,
    truncated: record.truncated === true,
  };
}

function asLineNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}
