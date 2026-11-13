/**
 * Terminal table for `skill eval` (ATO-1100, epic ATO-996): the same task
 * set run without and with a skill, side by side, with the difference in
 * accuracy, wall time and tokens, and a one-line verdict.
 *
 * Pure: no I/O, no clock, no environment reads. The caller turns its own
 * run results into {@link SkillEvalDiffInput} and prints the string.
 * Plain text by default, like `trace show`; colour is opt-in through
 * `color` (see {@link shouldUseColor} for the NO_COLOR rule) and never
 * carries meaning alone, since the sign and the verdict word say it too.
 */

/** One side (without or with the skill) of one task. */
export interface SkillEvalRunStats {
  /** Attempts whose check passed. */
  passed: number;
  /** Attempts run (one per task, or more when a task is repeated). */
  total: number;
  /** Wall time of all attempts together, in milliseconds. */
  wallMs: number;
  /** Prompt tokens of all attempts together. */
  tokensIn: number;
  /** Completion tokens of all attempts together. */
  tokensOut: number;
}

export interface SkillEvalTaskDiff {
  /** Task id or short name from the task set. */
  id: string;
  /** Run without the skill; `null` when it did not run (crash, skipped). */
  without: SkillEvalRunStats | null;
  /** Run with the skill; `null` when it did not run. */
  with: SkillEvalRunStats | null;
}

export interface SkillEvalDiffInput {
  /** Skill name, shown in the heading. */
  skill: string;
  tasks: readonly SkillEvalTaskDiff[];
}

export interface FormatSkillEvalDiffOptions {
  /** Wrap deltas and the verdict in ANSI colour. Default false. */
  color?: boolean;
}

export type SkillEvalVerdictKind =
  | "helped"
  | "hurt"
  | "no_clear_difference"
  | "no_data";

export interface SkillEvalVerdict {
  kind: SkillEvalVerdictKind;
  /** One line, no trailing newline, e.g. `Verdict: skill helped (accuracy +20 pp)`. */
  line: string;
}

/**
 * Verdict thresholds. Accuracy decides first; time and tokens only
 * decide when accuracy moved less than the accuracy threshold.
 *
 * - accuracy (pooled pass rate) up by >= 10 percentage points: helped;
 *   down by >= 10 points: hurt.
 * - otherwise, time or total tokens (in + out) down by >= 20% while
 *   neither went up by >= 20%: helped (same accuracy, cheaper); the
 *   mirror case: hurt; anything else: no clear difference.
 * - no task ran on both sides, or a side has zero attempts: no data.
 */
export const SKILL_EVAL_VERDICT_THRESHOLDS = {
  accuracyPoints: 10,
  costPercent: 20,
} as const;

/**
 * Colour rule shared with the TUI: a non-empty `NO_COLOR` turns colour
 * off, `FORCE_COLOR=0` too, any other non-empty `FORCE_COLOR` turns it
 * on, otherwise only a TTY gets colour.
 */
export function shouldUseColor(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return true;
  return isTTY;
}

export interface SkillEvalTotals {
  without: SkillEvalRunStats;
  with: SkillEvalRunStats;
  /** Tasks that ran on both sides and so count toward the totals. */
  paired: number;
  /** Tasks missing one side, left out of the totals. */
  unpaired: number;
}

/**
 * Sum only tasks that ran on both sides: a task that crashed on one side
 * would otherwise make that side look cheaper and less accurate at once.
 */
export function skillEvalTotals(input: SkillEvalDiffInput): SkillEvalTotals {
  const without = emptyStats();
  const withSkill = emptyStats();
  let paired = 0;
  let unpaired = 0;
  for (const task of input.tasks) {
    if (task.without === null || task.with === null) {
      unpaired += 1;
      continue;
    }
    paired += 1;
    addInto(without, task.without);
    addInto(withSkill, task.with);
  }
  return { without, with: withSkill, paired, unpaired };
}

export function skillEvalVerdict(input: SkillEvalDiffInput): SkillEvalVerdict {
  const totals = skillEvalTotals(input);
  if (
    totals.paired === 0 ||
    totals.without.total === 0 ||
    totals.with.total === 0
  ) {
    return {
      kind: "no_data",
      line: "Verdict: no data to compare (no task ran both without and with the skill)",
    };
  }
  const acc = accuracyDeltaPoints(totals.without, totals.with);
  const { accuracyPoints, costPercent } = SKILL_EVAL_VERDICT_THRESHOLDS;
  if (acc !== null && acc >= accuracyPoints) {
    return {
      kind: "helped",
      line: `Verdict: skill helped (accuracy ${signed(acc)} pp)`,
    };
  }
  if (acc !== null && acc <= -accuracyPoints) {
    return {
      kind: "hurt",
      line: `Verdict: skill hurt (accuracy ${signed(acc)} pp)`,
    };
  }
  const time = relativePercent(totals.without.wallMs, totals.with.wallMs);
  const tokens = relativePercent(
    totals.without.tokensIn + totals.without.tokensOut,
    totals.with.tokensIn + totals.with.tokensOut,
  );
  const moves: { name: string; pct: number }[] = [];
  if (time !== null) moves.push({ name: "time", pct: time });
  if (tokens !== null) moves.push({ name: "tokens", pct: tokens });
  const cheaper = moves.filter((m) => m.pct <= -costPercent);
  const costlier = moves.filter((m) => m.pct >= costPercent);
  const describe = (list: typeof moves): string =>
    list.map((m) => `${m.name} ${signed(m.pct)}%`).join(", ");
  if (cheaper.length > 0 && costlier.length === 0) {
    return {
      kind: "helped",
      line: `Verdict: skill helped (same accuracy, ${describe(cheaper)})`,
    };
  }
  if (costlier.length > 0 && cheaper.length === 0) {
    return {
      kind: "hurt",
      line: `Verdict: skill hurt (same accuracy, ${describe(costlier)})`,
    };
  }
  return {
    kind: "no_clear_difference",
    line: `Verdict: no clear difference (accuracy, time and tokens within ${accuracyPoints} pp / ${costPercent}%, or mixed)`,
  };
}

const HEADERS = [
  "task",
  "accuracy",
  "delta",
  "time",
  "delta",
  "tokens in",
  "delta",
  "tokens out",
  "delta",
] as const;

/** Columns after the first are right-aligned so numbers line up. */
const GAP = "  ";

type Direction = "higher_is_better" | "lower_is_better";

interface Cell {
  text: string;
  /** Colour hint for delta cells: positive = good, negative = bad. */
  tone?: "good" | "bad";
}

/**
 * Render the table, a totals row, an optional note about tasks left out
 * of the totals, and the verdict line. Returns text without a trailing
 * newline.
 *
 * ```
 * Skill eval: pdf-tools (2 tasks, without -> with)
 *
 * task               accuracy    delta          time  delta  ...
 * extract          0/1 -> 1/1  +100 pp  4.0s -> 3.0s   -25%  ...
 * merge-two-files  1/1 -> 1/1     0 pp  3.0s -> 2.0s   -33%  ...
 * total            1/2 -> 2/2   +50 pp  7.0s -> 5.0s   -29%  ...
 *
 * Verdict: skill helped (accuracy +50 pp)
 * ```
 */
export function formatSkillEvalDiff(
  input: SkillEvalDiffInput,
  options: FormatSkillEvalDiffOptions = {},
): string {
  const color = options.color === true;
  const count = input.tasks.length;
  const heading = `Skill eval: ${input.skill} (${count} task${count === 1 ? "" : "s"}, without -> with)`;
  const verdict = skillEvalVerdict(input);
  if (count === 0) {
    return [heading, "", "No tasks.", "", paint(verdict, color)].join("\n");
  }

  const rows: Cell[][] = input.tasks.map((task) =>
    rowCells(task.id, task.without, task.with),
  );
  const totals = skillEvalTotals(input);
  const totalRow =
    totals.paired > 0 ? rowCells("total", totals.without, totals.with) : null;

  const all: Cell[][] = [HEADERS.map((h) => ({ text: h })), ...rows];
  if (totalRow !== null) all.push(totalRow);
  const widths = HEADERS.map((_, col) =>
    Math.max(...all.map((row) => row[col]!.text.length)),
  );

  const render = (row: Cell[]): string =>
    row
      .map((cell, col) => {
        // Pad outside the colour codes so they never count toward width.
        const pad = " ".repeat(widths[col]! - cell.text.length);
        const text =
          color && cell.tone !== undefined
            ? wrap(cell.text, cell.tone === "good" ? GREEN : RED)
            : cell.text;
        return col === 0 ? text + pad : pad + text;
      })
      .join(GAP)
      .trimEnd();

  const lines = [heading, ""];
  for (const row of all) lines.push(render(row));
  if (totals.unpaired > 0) {
    lines.push(
      "",
      `${totals.unpaired} task${totals.unpaired === 1 ? "" : "s"} did not run on both sides and ${totals.unpaired === 1 ? "is" : "are"} left out of the total.`,
    );
  }
  lines.push("", paint(verdict, color));
  return lines.join("\n");
}

function rowCells(
  id: string,
  without: SkillEvalRunStats | null,
  withSkill: SkillEvalRunStats | null,
): Cell[] {
  const pair = (f: (s: SkillEvalRunStats) => string): string =>
    `${without === null ? "-" : f(without)} -> ${withSkill === null ? "-" : f(withSkill)}`;
  const both = without !== null && withSkill !== null;
  return [
    { text: id },
    { text: pair((s) => `${s.passed}/${s.total}`) },
    both
      ? pointsCell(accuracyDeltaPoints(without, withSkill))
      : { text: "n/a" },
    { text: pair((s) => formatDuration(s.wallMs)) },
    both
      ? percentCell(
          relativePercent(without.wallMs, withSkill.wallMs),
          "lower_is_better",
        )
      : { text: "n/a" },
    { text: pair((s) => formatTokens(s.tokensIn)) },
    both
      ? percentCell(
          relativePercent(without.tokensIn, withSkill.tokensIn),
          "lower_is_better",
        )
      : { text: "n/a" },
    { text: pair((s) => formatTokens(s.tokensOut)) },
    both
      ? percentCell(
          relativePercent(without.tokensOut, withSkill.tokensOut),
          "lower_is_better",
        )
      : { text: "n/a" },
  ];
}

function pointsCell(points: number | null): Cell {
  if (points === null) return { text: "n/a" };
  return { text: `${signed(points)} pp`, tone: toneOf(points, "higher_is_better") };
}

function percentCell(pct: number | null, direction: Direction): Cell {
  if (pct === null) return { text: "n/a" };
  return { text: `${signed(pct)}%`, tone: toneOf(pct, direction) };
}

function toneOf(value: number, direction: Direction): Cell["tone"] {
  if (Math.round(value) === 0) return undefined;
  const up = value > 0;
  return up === (direction === "higher_is_better") ? "good" : "bad";
}

/** Pass-rate change in percentage points; `null` when a side ran nothing. */
function accuracyDeltaPoints(
  without: SkillEvalRunStats,
  withSkill: SkillEvalRunStats,
): number | null {
  if (without.total <= 0 || withSkill.total <= 0) return null;
  return (
    (withSkill.passed / withSkill.total - without.passed / without.total) * 100
  );
}

/**
 * Relative change from `before` to `after` in percent. Both zero is 0%;
 * a zero baseline with a non-zero result has no meaningful percentage
 * and returns `null` (printed as `n/a`).
 */
function relativePercent(before: number, after: number): number | null {
  if (before === 0) return after === 0 ? 0 : null;
  return ((after - before) / before) * 100;
}

/** Rounded to a whole number with an explicit sign; `0` has none. */
function signed(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded}` : `-${Math.abs(rounded)}`;
}

/** `850ms`, `4.2s`, `2m 05s`. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  // 59.96s would round to "60.0s"; from there it reads as minutes.
  if (safe < 59_950) return `${(safe / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** `850`, `12.3k`, `1.2M`. */
export function formatTokens(count: number): string {
  const safe = Math.max(0, Math.round(count));
  if (safe < 1000) return String(safe);
  if (safe < 1_000_000) return `${(safe / 1000).toFixed(1)}k`;
  return `${(safe / 1_000_000).toFixed(1)}M`;
}

function emptyStats(): SkillEvalRunStats {
  return { passed: 0, total: 0, wallMs: 0, tokensIn: 0, tokensOut: 0 };
}

function addInto(target: SkillEvalRunStats, add: SkillEvalRunStats): void {
  target.passed += add.passed;
  target.total += add.total;
  target.wallMs += add.wallMs;
  target.tokensIn += add.tokensIn;
  target.tokensOut += add.tokensOut;
}

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const RESET = "\u001b[39m";

function wrap(text: string, code: string): string {
  return `${code}${text}${RESET}`;
}

function paint(verdict: SkillEvalVerdict, color: boolean): string {
  if (!color) return verdict.line;
  if (verdict.kind === "helped") return wrap(verdict.line, GREEN);
  if (verdict.kind === "hurt") return wrap(verdict.line, RED);
  return verdict.line;
}
