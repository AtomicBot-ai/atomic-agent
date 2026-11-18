import { parseDelegateArgs, type DelegateTask } from "../fusion/delegate-args.js";
import { SUBAGENT_MAX_CHILDREN_PER_CALL } from "./subagent-limits.js";

/**
 * `subagent.run` args (ATO-1670): `{ tasks: [{ id, instructions, title?,
 * profile?, deliverable? }] }`. The tasks go through `parseDelegateArgs`,
 * the parser `fusion.delegate` uses, so a task is held to the same
 * checks (unique ids, brief length); on top of that only the keys this
 * tool teaches are accepted, and at most
 * `SUBAGENT_MAX_CHILDREN_PER_CALL` tasks per call.
 */
const TOP_KEYS: ReadonlySet<string> = new Set(["tasks"]);
const TASK_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "instructions",
  "profile",
  "deliverable",
]);

export type ParsedSubagentArgs =
  | { ok: true; tasks: DelegateTask[] }
  | { ok: false; error: string };

export function parseSubagentArgs(
  raw: Record<string, unknown>,
): ParsedSubagentArgs {
  const problems: string[] = [];
  const extraTop = Object.keys(raw).filter((k) => !TOP_KEYS.has(k));
  if (extraTop.length > 0) {
    problems.push(
      `unknown argument${extraTop.length === 1 ? "" : "s"} ${extraTop.join(", ")}; the only argument is tasks`,
    );
  }
  if (Array.isArray(raw.tasks)) {
    if (raw.tasks.length > SUBAGENT_MAX_CHILDREN_PER_CALL) {
      return overCallCap(raw.tasks.length);
    }
    raw.tasks.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return;
      const extra = Object.keys(entry).filter((k) => !TASK_KEYS.has(k));
      if (extra.length > 0) {
        problems.push(
          `tasks[${i}] has unknown key${extra.length === 1 ? "" : "s"} ${extra.join(", ")}; a task takes id, instructions, title, profile, deliverable`,
        );
      }
    });
  }
  const parsed = parseDelegateArgs({ tasks: raw.tasks });
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        problems.length === 0
          ? parsed.error
          : `${parsed.error}; ${problems.join("; ")}`,
    };
  }
  if (problems.length > 0) {
    return { ok: false, error: `validation: ${problems.join("; ")}` };
  }
  // `tasks` may arrive as a JSON string, which only the parser reads.
  if (parsed.tasks.length > SUBAGENT_MAX_CHILDREN_PER_CALL) {
    return overCallCap(parsed.tasks.length);
  }
  return { ok: true, tasks: parsed.tasks };
}

function overCallCap(count: number): ParsedSubagentArgs {
  return {
    ok: false,
    error: `validation: tasks has ${count} entries; at most ${SUBAGENT_MAX_CHILDREN_PER_CALL} subagents per call. Send fewer, larger tasks, or call again after these report back.`,
  };
}
