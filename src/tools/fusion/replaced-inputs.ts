import {
  formatBytes,
  formatNumber,
  type ReplacedFileDetails,
} from "../os/fs-replace-guard.js";

/**
 * A pre-existing file a worker's write / edit / patch replaced or
 * shrank — F36's replace guard, seen through the worker's tool results
 * and carried onto its status-table row.
 *
 * Live, fusion, Gemma worker (2026-09-15): the worker overwrote the
 * user's 2,401-row `sales.csv` with a 9-row sample. The guard saved the
 * original and warned in the write result — and that warning reached
 * the orchestrator only inside the worker's prose block of the delegate
 * summary, where it read as the worker's own words and was not acted
 * on. The head line and the task's row are what a capped read sees
 * first, so that is where a replaced input goes (F43): `1 replaced
 * input` up top, `replaced the user's file sales.csv (2,401 → 9 lines)`
 * first on the row, and `details.tasks[].replacedInputs` for a reader
 * of the structure. The task keeps its status — the write did land and
 * the reply may be right — but the fact is no longer optional reading.
 */
export interface ReplacedInput {
  /** The path as the worker spelled it — what `os.fs.restore` takes verbatim. */
  path: string;
  /** The tool whose call replaced it (`os.fs.write`) or shrank it (edit, patch). */
  tool: string;
  bytesBefore: number;
  /** Null when the file was over the guard's size cap and never read. */
  linesBefore: number | null;
  linesAfter: number;
  headerChanged: boolean;
  /** Whether the previous content is in the restore store. */
  saved: ReplacedFileDetails["saved"];
}

/**
 * The guard's `details.replaced` — one object for a write or an edit, a
 * patch's array — as `ReplacedInput`s. Anything else is nothing: a
 * result that carries no guard hit, or a shape a future guard changes,
 * adds no row fact rather than a wrong one.
 */
export function replacedInputsOf(
  tool: string,
  details: Record<string, unknown>,
): ReplacedInput[] {
  const raw = details.replaced;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.filter(isReplacedFileDetails).map((r) => ({
    path: r.display,
    tool,
    bytesBefore: r.bytesBefore,
    linesBefore: r.linesBefore,
    linesAfter: r.linesAfter,
    headerChanged: r.headerChanged,
    saved: r.saved,
  }));
}

function isReplacedFileDetails(value: unknown): value is ReplacedFileDetails {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<ReplacedFileDetails>;
  return (
    typeof r.display === "string" &&
    typeof r.bytesBefore === "number" &&
    (typeof r.linesBefore === "number" || r.linesBefore === null) &&
    typeof r.linesAfter === "number" &&
    typeof r.headerChanged === "boolean" &&
    (r.saved === "saved" || r.saved === "too_large" || r.saved === "failed")
  );
}

/**
 * `replaced the user's file sales.csv (2,401 → 9 lines)`;
 * `… (2,401 → 9 lines, header changed)`; `shrank the user's file …` for
 * an edit or a patch; `(5.0 MB → 1 line); not saved (too large)` for a
 * file the guard could only announce.
 */
export function describeReplacedInput(input: ReplacedInput): string {
  const verb = input.tool === "os.fs.write" ? "replaced" : "shrank";
  const before =
    input.linesBefore === null
      ? formatBytes(input.bytesBefore)
      : formatNumber(input.linesBefore);
  const unit = input.linesAfter === 1 ? "line" : "lines";
  const header = input.headerChanged ? ", header changed" : "";
  const saved =
    input.saved === "saved"
      ? ""
      : input.saved === "too_large"
        ? "; not saved (too large)"
        : "; not saved";
  return `${verb} the user's file ${input.path} (${before} → ${formatNumber(input.linesAfter)} ${unit}${header})${saved}`;
}

/** `1 replaced input` / `3 replaced inputs` for the head line, or null when there were none. */
export function countReplacedInputs(
  results: readonly { replacedInputs?: readonly ReplacedInput[] }[],
): string | null {
  const n = results.reduce((sum, r) => sum + (r.replacedInputs?.length ?? 0), 0);
  return n === 0 ? null : `${n} replaced input${n === 1 ? "" : "s"}`;
}
