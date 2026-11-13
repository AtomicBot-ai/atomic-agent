/**
 * What the model is told after an edit: only the errors the edit added.
 *
 * Errors the file already had before the change were the model's
 * starting point, not its doing; repeating them after every edit buries
 * the one that matters. Positions are deliberately not part of the
 * match: an edit above an old error moves it, and a moved error is
 * still the same old error.
 */

/** The subset of an LSP `Diagnostic` this module reads. */
export interface LspDiagnostic {
  readonly range?: {
    readonly start?: { readonly line?: number; readonly character?: number };
  };
  /** 1 error, 2 warning, 3 information, 4 hint; absent reads as error. */
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export const LSP_SEVERITY_ERROR = 1;

/** Lines shown before "… and N more". */
export const MAX_REPORTED_DIAGNOSTICS = 8;

const MAX_MESSAGE_CHARS = 200;

export function isError(d: LspDiagnostic): boolean {
  return d.severity === undefined || d.severity === LSP_SEVERITY_ERROR;
}

function identity(d: LspDiagnostic): string {
  return `${d.source ?? ""}\u0000${d.code ?? ""}\u0000${d.message.trim()}`;
}

/**
 * Errors in `after` beyond those `before` already had. Counted as a
 * multiset: a second copy of an old error is new.
 */
export function newErrors(
  before: readonly LspDiagnostic[],
  after: readonly LspDiagnostic[],
): LspDiagnostic[] {
  const seen = new Map<string, number>();
  for (const d of before) {
    if (!isError(d)) continue;
    const key = identity(d);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const fresh: LspDiagnostic[] = [];
  for (const d of after) {
    if (!isError(d)) continue;
    const key = identity(d);
    const left = seen.get(key) ?? 0;
    if (left > 0) seen.set(key, left - 1);
    else fresh.push(d);
  }
  return fresh;
}

function describe(d: LspDiagnostic): string {
  const line = (d.range?.start?.line ?? 0) + 1;
  const col = (d.range?.start?.character ?? 0) + 1;
  const firstLine = d.message.trim().split("\n")[0] ?? "";
  const message =
    firstLine.length > MAX_MESSAGE_CHARS
      ? `${firstLine.slice(0, MAX_MESSAGE_CHARS - 1)}…`
      : firstLine;
  const code = d.code === undefined || d.code === "" ? "" : ` [${d.code}]`;
  return `  line ${line}:${col}${code} ${message}`;
}

/**
 * The block for the tool result, or null when the change added no
 * errors. `server` names who said so (`typescript`, `pyright`).
 */
export function formatNewErrors(
  path: string,
  change: "write" | "edit" | "patch",
  server: string,
  fresh: readonly LspDiagnostic[],
): string | null {
  if (fresh.length === 0) return null;
  const sorted = [...fresh].sort(
    (a, b) =>
      (a.range?.start?.line ?? 0) - (b.range?.start?.line ?? 0) ||
      (a.range?.start?.character ?? 0) - (b.range?.start?.character ?? 0),
  );
  const shown = sorted.slice(0, MAX_REPORTED_DIAGNOSTICS).map(describe);
  const more =
    sorted.length > shown.length
      ? [`  … and ${sorted.length - shown.length} more`]
      : [];
  const noun = fresh.length === 1 ? "new error" : "new errors";
  return [
    `⚠ ${path}: ${fresh.length} ${noun} from ${server} after this ${change}:`,
    ...shown,
    ...more,
  ].join("\n");
}

/** Two optional warning blocks as one, in order. */
export function joinWarnings(
  first: string | null,
  second: string | null,
): string | null {
  if (first === null || first.length === 0) return second;
  if (second === null || second.length === 0) return first;
  return `${first}\n${second}`;
}
