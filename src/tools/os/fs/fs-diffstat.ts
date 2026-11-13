/**
 * Lines added and removed by one file change, for a host's "Changed
 * files" card (ATO-1187). It rides on the result's `details.diffstat`
 * and the `tool_result` SSE frame only: `details` never reaches the
 * model's prompt, so the model-facing summary stays as it was.
 *
 * The count is a line diff of the file before and after: the common
 * leading and trailing lines are dropped, and the middle is diffed by
 * longest common subsequence when it is small enough. A middle too big
 * for that (`LCS_MAX_CELLS`) is counted as all of it removed and all of
 * it added, an upper bound a host can still show.
 */
export interface DiffStat {
  added: number;
  removed: number;
}

/** Largest before×after middle the exact count runs on (~4M cells, a few ms). */
const LCS_MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  // A trailing newline ends the last line rather than opening a new one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function computeDiffStat(before: string, after: string): DiffStat {
  if (before === after) return { added: 0, removed: 0 };
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { added: m, removed: n };
  if (n * m > LCS_MAX_CELLS) return { added: m, removed: n };
  const common = lcsLength(a, start, endA, b, start, endB);
  return { added: m - common, removed: n - common };
}

/** Length of the longest common subsequence of a[aFrom..aTo) and b[bFrom..bTo), two rows of memory. */
function lcsLength(
  a: readonly string[],
  aFrom: number,
  aTo: number,
  b: readonly string[],
  bFrom: number,
  bTo: number,
): number {
  const m = bTo - bFrom;
  let prev = new Uint32Array(m + 1);
  let row = new Uint32Array(m + 1);
  for (let i = aFrom; i < aTo; i++) {
    const line = a[i];
    for (let j = 1; j <= m; j++) {
      row[j] =
        line === b[bFrom + j - 1]
          ? prev[j - 1]! + 1
          : Math.max(prev[j]!, row[j - 1]!);
    }
    const swap = prev;
    prev = row;
    row = swap;
    row.fill(0);
  }
  return prev[m]!;
}

/**
 * The `diffstat` for an `os.fs.write`: an append adds its own lines; a
 * new file adds all of its lines; a replace is diffed against what was
 * there. A prior file too large to have been read gives no count
 * (`null`), so a host shows the file without +/- instead of a wrong one.
 */
export function writeDiffStat(input: {
  mode: "append" | "replace";
  existed: boolean;
  priorText: string | null;
  content: string;
}): DiffStat | null {
  if (input.mode === "append") {
    return { added: splitLines(input.content).length, removed: 0 };
  }
  if (!input.existed) return { added: splitLines(input.content).length, removed: 0 };
  if (input.priorText === null) return null;
  return computeDiffStat(input.priorText, input.content);
}
