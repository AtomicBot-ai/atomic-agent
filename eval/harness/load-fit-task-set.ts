import { readFileSync } from "node:fs";

import type { EvalCase, EvalCategory, JudgeExpectation } from "./case-schema.js";

/**
 * Read a task set written by `atomic-agent models tasks collect`
 * (`src/fit-test/fit-task.ts`, ATO-1089) as eval cases, so the user's own
 * tasks run through `runCase` like the built-in corpus. The harness keeps
 * its own copy of the file contract instead of importing from `src/`
 * (see `parse-trace-metrics.ts` for why); the shape is small and only
 * ever gains fields.
 */
interface FitTaskJson {
  id: string;
  name?: string;
  category?: string;
  prompt: string;
  maxSteps?: number;
  expectations?: Array<{ kind: string; rubric?: string; threshold?: number }>;
}

const CATEGORIES: ReadonlySet<string> = new Set(["os", "coding"]);

export function loadFitTaskSet(path: string): EvalCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { kind?: string; version?: number; tasks?: FitTaskJson[] };
  if (raw.kind !== "atomic-agent.fit-task-set" || raw.version !== 1 || !Array.isArray(raw.tasks)) {
    throw new Error(`${path} is not a version 1 fit-test task set`);
  }
  return raw.tasks.map((task): EvalCase => {
    const expectations: JudgeExpectation[] = (task.expectations ?? [])
      .filter((e) => e.kind === "judge" && typeof e.rubric === "string")
      .map((e) => ({ kind: "judge", rubric: e.rubric as string, ...(e.threshold !== undefined ? { threshold: e.threshold } : {}) }));
    return {
      id: task.id,
      name: task.name ?? task.id,
      category: (CATEGORIES.has(task.category ?? "") ? task.category : "os") as EvalCategory,
      prompt: task.prompt,
      ...(task.maxSteps !== undefined ? { maxSteps: task.maxSteps } : {}),
      expectations,
    };
  });
}
