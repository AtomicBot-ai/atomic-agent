import type { DelegateContract } from "./contract.js";
import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";

/**
 * The order a contract puts on a fan-out (F45).
 *
 * A `requires` names something a sibling `provides`; a worker sent at
 * the same time as its provider waits for a file that does not exist
 * yet. Live, an orchestrator declared a pipeline — `analyze` provides a
 * manifest, `organize` requires it, `index` requires what `organize`
 * produces — and sent all three at once: two workers spent their whole
 * step budget re-checking for the missing input and nothing was done.
 *
 * So the fan-out runs in waves: a task that requires X depends on every
 * task that provides X; wave 1 is every task with no unmet dependency,
 * and each later wave is the tasks whose dependencies have all finished
 * — with any status. A provider that ended `failed`, `cancelled`,
 * `no_changes` or `needs_orchestrator` did not deliver, but its
 * dependent still runs: the orchestrator gets every report either way,
 * and the dependent's CONTRACT block carries a warning naming what did
 * not arrive (`dependencyWarnings`, through the F44 warning slot).
 *
 * A cycle in the requires is one wave, in the order given, with a
 * warning. A contract without `requires`, or whose requires name
 * nothing any task provides, orders nothing: one wave, exactly the
 * fan-out that ran before waves existed.
 */
export interface WavePlan {
  /** Task ids, wave by wave; each wave in the caller's task order. */
  waves: string[][];
  /**
   * Task id → the provider tasks it waits for, in the contract's order
   * with duplicates dropped. Empty when the contract orders nothing.
   */
  dependencies: ReadonlyMap<string, readonly string[]>;
  /** The warning when the requires form a cycle; the plan is then one wave. */
  cycle?: string;
}

/** A task that requires X depends on every OTHER task that provides X. */
export function dependenciesOf(
  taskIds: readonly string[],
  contract: DelegateContract | undefined,
): Map<string, string[]> {
  const known = new Set(taskIds);
  const dependencies = new Map<string, string[]>();
  for (const require of contract?.requires ?? []) {
    if (!known.has(require.task)) continue;
    for (const provide of contract?.provides ?? []) {
      if (provide.name !== require.name) continue;
      if (provide.task === require.task || !known.has(provide.task)) continue;
      const own = dependencies.get(require.task) ?? [];
      if (!own.includes(provide.task)) own.push(provide.task);
      dependencies.set(require.task, own);
    }
  }
  return dependencies;
}

/**
 * Follow unmet dependencies from the first stuck task until one
 * repeats: `a → b → a` reads "a requires b requires a". Every stuck
 * task has an unmet dependency among the stuck ones (that is what
 * stuck means), so the walk closes within their number.
 */
function describeCycle(
  stuck: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string {
  const among = new Set(stuck);
  const path: string[] = [];
  let node = stuck[0]!;
  while (!path.includes(node)) {
    path.push(node);
    node = (dependencies.get(node) ?? []).find((d) => among.has(d)) ?? node;
  }
  return [...path.slice(path.indexOf(node)), node].join(" → ");
}

/** `requires form a cycle (a → b → a), so the tasks run in one wave in the order given` */
export function describeCycleWarning(cycle: string): string {
  return `requires form a cycle (${cycle}), so the tasks run in one wave in the order given`;
}

export function planWaves(
  taskIds: readonly string[],
  contract: DelegateContract | undefined,
): WavePlan {
  const dependencies = dependenciesOf(taskIds, contract);
  const waves: string[][] = [];
  const done = new Set<string>();
  let remaining = [...taskIds];
  while (remaining.length > 0) {
    const wave = remaining.filter((id) =>
      (dependencies.get(id) ?? []).every((d) => done.has(d)),
    );
    if (wave.length === 0) {
      return {
        waves: [[...taskIds]],
        dependencies,
        cycle: describeCycleWarning(describeCycle(remaining, dependencies)),
      };
    }
    waves.push(wave);
    for (const id of wave) done.add(id);
    remaining = remaining.filter((id) => !done.has(id));
  }
  return { waves, dependencies };
}

/** A provider that ended one of these did not deliver what its dependents rely on. */
export const UNDELIVERED_STATUSES: ReadonlySet<WorkerTaskStatus> = new Set([
  "failed",
  "cancelled",
  "no_changes",
  "needs_orchestrator",
]);

/**
 * One warning per (dependent, undelivered provider) pair in `wave`,
 * from the results so far: `task organize depends on analyze, which
 * ended no_changes`. Goes into the wave's CONTRACT block (the worker
 * learns not to wait for it) and onto the result's `contract:` line.
 */
export function dependencyWarnings(
  wave: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
  finished: ReadonlyMap<string, WorkerTaskResult>,
): string[] {
  const warnings: string[] = [];
  for (const id of wave) {
    for (const provider of dependencies.get(id) ?? []) {
      const result = finished.get(provider);
      if (result === undefined || !UNDELIVERED_STATUSES.has(result.status)) {
        continue;
      }
      warnings.push(
        `task ${id} depends on ${provider}, which ended ${result.status}`,
      );
    }
  }
  return warnings;
}

/** Outcome notes carried into a later wave, and how much of each. */
const MAX_OUTCOME_NOTES = 8;
const OUTCOME_DETAIL_CHARS = 120;

/**
 * What the waves that already ran actually did, for the workers that
 * have not started yet.
 *
 * `dependencyWarnings` says only that a task someone *declared* a
 * dependency on ended badly. That leaves the common case untold: a
 * worker in wave 2 rebuilding a file wave 1 already wrote, or writing
 * against an interface the task that was meant to provide it never
 * produced. A real run ended with one worker rewriting `index.html`
 * five times while three of its siblings had already finished —
 * nothing had told it what was there.
 *
 * So every later worker is handed the state of the world: what
 * succeeded and what it produced, what failed and in whose words.
 * Bounded, because this goes into every brief and a fan-out of eight
 * would otherwise carry eight paragraphs of history no worker reads.
 */
export function completedWaveNotes(
  finished: ReadonlyMap<string, WorkerTaskResult>,
): string[] {
  if (finished.size === 0) return [];
  const notes: string[] = [];
  for (const result of finished.values()) {
    if (notes.length >= MAX_OUTCOME_NOTES) break;
    const head = `already done — [${result.id}] ${result.status} (${result.title})`;
    // A failure's own words; a success's own summary. Both are what a
    // worker needs to decide whether its task still means what the
    // orchestrator thought it meant when it wrote the brief.
    const detail = UNDELIVERED_STATUSES.has(result.status)
      ? (result.error ?? "no reason given")
      : result.reply;
    notes.push(
      detail.length === 0
        ? head
        : `${head}: ${oneLine(detail, OUTCOME_DETAIL_CHARS)}`,
    );
  }
  return notes;
}

function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/**
 * The contract a wave's workers read: the parsed one, plus the warnings
 * the earlier waves produced. The very object when there is nothing to
 * add, so a fan-out the contract does not order briefs byte-identically.
 */
export function contractForWave(
  contract: DelegateContract | undefined,
  extra: readonly string[],
): DelegateContract | undefined {
  if (contract === undefined || extra.length === 0) return contract;
  return { ...contract, warnings: [...(contract.warnings ?? []), ...extra] };
}
