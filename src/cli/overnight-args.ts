/**
 * Argument parsing for `atomic-agent overnight` (ATO-1113). Pure: the
 * caller hands in the working directory and a directory probe, so every
 * branch is unit-reachable without touching the disk.
 */
import { resolve } from "node:path";

import { parseUsdFlag } from "./task-budget-flags.js";

export const OVERNIGHT_DEFAULT_HOURS = 8;
/** One day, the same ceiling as the desktop dialog. */
export const OVERNIGHT_MAX_HOURS = 24;
/**
 * The shortest run, one minute. Anything shorter rounds to a duration
 * the task store refuses (0 ms) or spells back to the detached child in
 * exponent notation, which the child's own parse rejects after the
 * parent already reported a start.
 */
export const OVERNIGHT_MIN_HOURS = 1 / 60;
/**
 * Internal: the detached child runs the task id its parent already
 * printed. Not in the help text; a user who passes it just picks the id.
 */
export const OVERNIGHT_TASK_ID_FLAG = "--task-id";

export interface OvernightArgs {
  task: string;
  /** `null` leaves the cap to `agent.task.maxCostUsd`. */
  budgetUsd: number | null;
  durationMs: number;
  /** Absolute path the run works in. */
  dir: string;
  notify: "telegram" | "push" | null;
  detach: boolean;
  noApproval: boolean;
  taskId: string | null;
}

export type OvernightParse =
  | { ok: true; args: OvernightArgs }
  | { ok: false; error: string };

export interface OvernightParseEnv {
  cwd: string;
  isDirectory: (path: string) => boolean;
}

const VALUE_FLAGS = new Set([
  "--budget",
  "--hours",
  "--dir",
  "--notify",
  OVERNIGHT_TASK_ID_FLAG,
]);
const BOOL_FLAGS = new Set(["--detach", "--no-approval"]);

export function parseOvernightArgs(
  argv: readonly string[],
  env: OvernightParseEnv,
): OvernightParse {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    if (VALUE_FLAGS.has(flag)) {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[(i += 1)];
      if (value === undefined || value === "") {
        return { ok: false, error: `${flag} needs a value` };
      }
      values.set(flag, value);
    } else if (BOOL_FLAGS.has(flag)) {
      bools.add(flag);
    } else if (raw.startsWith("--")) {
      return { ok: false, error: `unknown option: ${raw}` };
    } else {
      words.push(raw);
    }
  }

  const task = words.join(" ").trim();
  if (task.length === 0) {
    return { ok: false, error: "missing the task text" };
  }

  let budgetUsd: number | null = null;
  const budgetRaw = values.get("--budget");
  if (budgetRaw !== undefined) {
    budgetUsd = parseUsdFlag(budgetRaw);
    if (budgetUsd === null) {
      return {
        ok: false,
        error: `--budget expects a positive dollar amount, got ${budgetRaw}`,
      };
    }
  }

  const hours = parseHours(values.get("--hours"));
  if (hours === null) {
    return {
      ok: false,
      error: `--hours expects a number from 1 minute (${OVERNIGHT_MIN_HOURS.toFixed(3)}) to ${OVERNIGHT_MAX_HOURS}, got ${values.get("--hours")}`,
    };
  }

  const dir = resolve(env.cwd, values.get("--dir") ?? ".");
  if (!env.isDirectory(dir)) {
    return { ok: false, error: `--dir is not a directory: ${dir}` };
  }

  const notifyRaw = values.get("--notify");
  if (notifyRaw !== undefined && notifyRaw !== "telegram" && notifyRaw !== "push") {
    return {
      ok: false,
      error: `--notify supports only "telegram" or "push", got ${notifyRaw}`,
    };
  }

  return {
    ok: true,
    args: {
      task,
      budgetUsd,
      durationMs: Math.round(hours * 3_600_000),
      dir,
      notify: notifyRaw === "telegram" || notifyRaw === "push" ? notifyRaw : null,
      detach: bools.has("--detach"),
      noApproval: bools.has("--no-approval"),
      taskId: values.get(OVERNIGHT_TASK_ID_FLAG) ?? null,
    },
  };
}

function parseHours(raw: string | undefined): number | null {
  if (raw === undefined) return OVERNIGHT_DEFAULT_HOURS;
  const trimmed = raw.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const hours = Number(trimmed);
  if (
    !Number.isFinite(hours) ||
    Math.round(hours * 3_600_000) < Math.round(OVERNIGHT_MIN_HOURS * 3_600_000) ||
    hours > OVERNIGHT_MAX_HOURS
  ) {
    return null;
  }
  return hours;
}

/**
 * The detached child's arguments: the parsed run spelled out again with
 * the directory made absolute, `--detach` dropped and the task id the
 * parent printed. Rebuilt from the parse rather than filtered from argv
 * so a relative `--dir` cannot resolve twice.
 */
export function detachedChildArgs(args: OvernightArgs, taskId: string): string[] {
  return [
    "overnight",
    args.task,
    ...(args.budgetUsd !== null ? ["--budget", String(args.budgetUsd)] : []),
    "--hours",
    String(args.durationMs / 3_600_000),
    "--dir",
    args.dir,
    ...(args.notify ? ["--notify", args.notify] : []),
    ...(args.noApproval ? ["--no-approval"] : []),
    OVERNIGHT_TASK_ID_FLAG,
    taskId,
  ];
}
