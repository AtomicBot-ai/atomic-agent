// Task registry. A task is:
//   { id, set: "core" | "stress", title, timeoutSec, maxSteps,
//     turns(ctx) -> string[]            one CLI line per user turn
//     fixture(dir, ctx) -> meta          writes the start folder, returns hidden expectations
//     check(dir, meta, ctx) -> { pass, reason, details? }   deterministic, no LLM
//     solve(dir, meta, ctx)              reference solution, used only by unit tests }
// ctx = { window, trace, run } (trace/run only at check time).
// `meta` is written next to the results, never into the agent's folder.

import core from "./core.mjs";
import hard from "./hard.mjs";
import stress from "./stress.mjs";

export const TASKS = [...core, ...hard, ...stress];

export function getTask(id) {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task '${id}' (known: ${TASKS.map((x) => x.id).join(", ")})`);
  return t;
}

/** "core", "stress", "all", or a comma list of ids/sets. */
export function selectTasks(spec = "all") {
  const out = [];
  for (const part of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part === "all") out.push(...TASKS);
    else if (part === "core" || part === "stress") out.push(...TASKS.filter((t) => t.set === part));
    else out.push(getTask(part));
  }
  return [...new Map(out.map((t) => [t.id, t])).values()];
}
