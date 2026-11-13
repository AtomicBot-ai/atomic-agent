/**
 * `/goal` parsing (ATO-451). Pure: the orchestrator acts on the result.
 *
 *   /goal <criteria>        set a goal and start working on it; criteria one
 *                           per line, or split by `;` on a single line; a
 *                           `check: <cmd>` item is a shell check instead
 *   /goal check add <cmd>   add a shell check that must exit 0 after a round
 *   /goal check clear       drop every check
 *   /goal tokens <n>|off    token budget for the goal (ATO-1036)
 *   /goal status            show the acceptance list and where it stands
 *   /goal pause|resume|clear
 */
export type GoalCommand =
  | { kind: "set"; criteria: string[]; checks: string[] }
  | { kind: "check_add"; command: string }
  | { kind: "check_clear" }
  /** `0` removes the cap. */
  | { kind: "tokens"; maxTokens: number }
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "error"; message: string };

export const GOAL_USAGE =
  "usage: /goal <criteria; one per line or split by ;> | /goal check add <cmd> | /goal check clear | /goal tokens <n>|off | /goal status | /goal pause | /goal resume | /goal clear";

const CHECK_PREFIX = /^check\s*:\s*/i;

export function parseGoalCommand(args: string): GoalCommand {
  const raw = args.trim();
  if (raw.length === 0) return { kind: "status" };
  const verb = raw.toLowerCase();
  if (verb === "status" || verb === "pause" || verb === "resume" || verb === "clear") {
    return { kind: verb };
  }
  // Only `tokens` alone or with one budget word: a criterion that starts
  // with the word ("tokens refresh on expiry") is still a criterion.
  if (verb === "tokens") {
    return { kind: "error", message: "usage: /goal tokens <n>|off, e.g. /goal tokens 500k" };
  }
  const tokens = /^tokens\s+(\S+)$/i.exec(raw);
  const budget = tokens ? parseTokenBudget(tokens[1]!) : null;
  if (budget !== null) return { kind: "tokens", maxTokens: budget };
  const check = /^check\s+(add|clear)\b\s*([\s\S]*)$/i.exec(raw);
  if (check) {
    const sub = check[1]!.toLowerCase();
    const rest = check[2]!.trim();
    if (sub === "clear") {
      return rest.length === 0 ? { kind: "check_clear" } : { kind: "error", message: GOAL_USAGE };
    }
    return rest.length === 0
      ? { kind: "error", message: "usage: /goal check add <command>, e.g. /goal check add npm test" }
      : { kind: "check_add", command: rest };
  }
  const items = splitGoalItems(raw);
  const checks = items.filter((item) => CHECK_PREFIX.test(item))
    .map((item) => item.replace(CHECK_PREFIX, "").trim())
    .filter((item) => item.length > 0);
  const criteria = items.filter((item) => !CHECK_PREFIX.test(item));
  if (criteria.length === 0) {
    return { kind: "error", message: "a goal needs at least one criterion besides its checks" };
  }
  return { kind: "set", criteria, checks };
}

/**
 * One item per non-empty line; a single line is split on `;` instead.
 * List markers (`-`, `*`, `1.`) are dropped so a pasted checklist reads
 * the same as a typed one.
 */
export function splitGoalItems(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const items = lines.length > 1 ? lines : text.split(";");
  return items
    .map((item) => item.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((item) => item.length > 0);
}

/**
 * `500000`, `500k`, `2m`, `1_000_000`, or `off` / `0` (no cap). `null`
 * for anything else.
 */
export function parseTokenBudget(text: string): number | null {
  const t = text.toLowerCase().replace(/[_,\s]/g, "");
  if (t === "off" || t === "none" || t === "0") return 0;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}
