import { createHash } from "node:crypto";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { LOOP_VETO_DENIED_REASON } from "./loop-constants.js";
import type { ReadObservation } from "./read-coverage.js";
/** How much of a result's summary the outcome fingerprint reads. */
const OUTCOME_FINGERPRINT_CHARS = 200;

/** The tools whose success means the workspace moved. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.restore",
]);

/** A write, edit or patch that landed — the reset event for the outcome-repeat detector. */
export function isSuccessfulWrite(
  tool: string,
  result: CompressedToolResult,
): boolean {
  return WRITE_TOOLS.has(tool) && result.status === "ok";
}

/**
 * Outcome fingerprint: the tool, the status, and the first
 * `OUTCOME_FINGERPRINT_CHARS` characters of the summary with whitespace
 * runs collapsed. Deliberately NOT the semantic result hash used for the
 * no-progress streak — that one keys on the arguments too, which is
 * exactly what a re-check with "slightly different arguments" evades.
 * The summary head is where a shell result's command line, exit code and
 * first error live, and where a listing names its entries; two results
 * that agree there are the same answer for the model's purposes.
 */
export function fingerprintToolOutcome(
  tool: string,
  result: CompressedToolResult,
): string {
  const head = result.summary
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OUTCOME_FINGERPRINT_CHARS);
  return `${tool}|${result.status}|${head}`;
}

/** True when `result` is a synthetic no-progress loop veto. */
export function isLoopVetoResult(result: CompressedToolResult): boolean {
  return (
    result.status === "error" &&
    result.details.deniedReason === LOOP_VETO_DENIED_REASON
  );
}

/** Stable signature for a `(tool, args)` pair. */
export function hashToolCall(tool: string, args: unknown): string {
  return `${tool}:${hashCanonical(args)}`;
}

/**
 * Semantic result hash. Returns `undefined` for loop-veto results (so the
 * vetoed entry is excluded from the no-progress streak). Errors collapse
 * to a stable `error:<hash>`; `os.shell.run` normalises by exit code +
 * summary; everything else hashes the compressed summary + details.
 */
export function hashToolOutcome(
  tool: string,
  _args: unknown,
  result: CompressedToolResult,
): string | undefined {
  if (isLoopVetoResult(result)) return undefined;
  if (result.status === "error") {
    const errorName =
      typeof result.details.errorName === "string"
        ? result.details.errorName
        : "error";
    return `error:${hashString(`${errorName}:${result.summary}`)}`;
  }
  if (tool === "os.shell.run") {
    const exitCode =
      typeof result.details.exitCode === "number"
        ? result.details.exitCode
        : null;
    return hashString(`shell:${exitCode}:${result.summary}`);
  }
  // Strip volatile fields (per-call timings, sizes, request ids, dates)
  // before hashing so that semantically identical responses collapse to
  // the same hash. Without this, fields like `timeTotalSeconds` /
  // `sizeDownload` change on every call and a repeated dead/identical
  // endpoint (e.g. 21 identical search POSTs) never registers as a
  // no-progress streak. Mirrors OpenClaw's `stripVolatileSendIds`.
  return hashString(
    `${result.summary}:${hashCanonical(stripVolatile(result.details))}`,
  );
}

/**
 * Result-detail keys whose values change on every call even when the
 * response is semantically identical. Dropped before the no-progress hash
 * so identical-but-for-volatile responses match.
 */
const VOLATILE_RESULT_KEYS = new Set<string>([
  "timestamp",
  "ts",
  "date",
  "time",
  "timeTotal",
  "timeTotalSeconds",
  "durationMs",
  "sizeDownload",
  "requestId",
  "request_id",
  "id",
  "traceId",
  "trace_id",
  "sentAt",
  "createdAt",
  "deliveredAt",
]);

/** Recursively drop `VOLATILE_RESULT_KEYS` from an arbitrary value. */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== "object") return value;
  const stripped: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (VOLATILE_RESULT_KEYS.has(key)) continue;
    stripped[key] = stripVolatile(nested);
  }
  return stripped;
}

export function hashBatchCompositeArgs(
  calls: readonly { tool: string; args: unknown }[],
): string {
  return hashCanonical(calls.map((c) => [c.tool, c.args]));
}

export function hashBatchCompositeResults(
  calls: readonly { tool: string; args: unknown }[],
  results: readonly CompressedToolResult[],
): string {
  return hashCanonical(
    calls.map((c, i) => ({
      tool: c.tool,
      summary: results[i]?.summary ?? "",
      status: results[i]?.status ?? "error",
    })),
  );
}

function hashString(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function hashCanonical(value: unknown): string {
  return hashString(canonicalJson(value));
}

/**
 * Deterministic JSON serialisation: object keys sorted, arrays preserved
 * in order, `undefined` omitted.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Is this read looking at the same version of the file, rendered the
 * same way, as the coverage already banked for it? Both halves have to
 * hold: different bytes are different text, and so are the same bytes
 * with `LINE_NUMBER|` prefixes the previous read did not have.
 */
export function sameReadVersion(
  entry: { contentHash: string; numbered: boolean },
  observation: ReadObservation,
): boolean {
  return (
    entry.contentHash === observation.contentHash &&
    entry.numbered === observation.numbered
  );
}
