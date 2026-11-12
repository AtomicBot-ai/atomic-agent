/**
 * ATO-606 — the reasoning level of Fusion's workers.
 *
 * The agent reads `llm.runMode.fusion.workerReasoning` (low | medium | high;
 * absent = each provider's own default, src/config/llm-run-mode-config.ts)
 * and sends it as the reasoning effort of every worker completion. The
 * planner is not affected by it.
 *
 * The pure half: what the window may ask for, and the plan that sets or
 * removes the key on a config read under the config lock. The write itself
 * (rewriteWholeConfig: one read, the plan, one compare-and-swap write, ATO-416)
 * is in fusion-reasoning-ipc.ts.
 *
 * Why a whole-file write and not `atag config set <leaf>`: the agent's leaf
 * table has no `llm.*` keys (agent-cli.ts configSet refuses them), and
 * `config unset` of a leaf it does not know fails too. "Default" has to
 * REMOVE the key; a `null` is not a level the agent accepts.
 */

export type WorkerReasoningLevel = "low" | "medium" | "high";

export const WORKER_REASONING_LEVELS: readonly WorkerReasoningLevel[] = ["low", "medium", "high"];

/** What the window sends: a level, or "default" for no key at all. */
export type WorkerReasoningChoice = WorkerReasoningLevel | "default";

export function isWorkerReasoningLevel(v: unknown): v is WorkerReasoningLevel {
  return typeof v === "string" && (WORKER_REASONING_LEVELS as readonly string[]).includes(v);
}

/** The IPC argument as a choice, or null when it is none of them. */
export function parseWorkerReasoningChoice(v: unknown): WorkerReasoningChoice | null {
  if (v === "default") return "default";
  return isWorkerReasoningLevel(v) ? v : null;
}

/** The slice of the config the plan reads and writes. */
export interface WorkerReasoningConfig {
  llm?: { runMode?: { fusion?: Record<string, unknown> } };
}

export interface WorkerReasoningVerdict {
  write: boolean;
  /** The level the file had; null when it had none (or one this build does not know). */
  before: WorkerReasoningLevel | null;
  /** The level after the plan; null = the provider's default. */
  after: WorkerReasoningLevel | null;
  refusal?: string;
}

/**
 * Set or remove the key on `cfg` (mutated, as the run-mode planners do).
 * Nothing moves when the file already says the same: a level equal to the
 * one there, or "default" with no key. A value a newer build wrote (one this
 * build does not know) counts as no level, and picking "default" removes it.
 */
export function planWorkerReasoning(cfg: WorkerReasoningConfig, choice: WorkerReasoningChoice): WorkerReasoningVerdict {
  const fusionNow = cfg.llm?.runMode?.fusion ?? {};
  const raw = fusionNow["workerReasoning"];
  const before = isWorkerReasoningLevel(raw) ? raw : null;
  const after = choice === "default" ? null : choice;
  if (!cfg.llm) return { write: false, before, after: before, refusal: "no provider is configured yet. Add one in Settings › Models" };
  if (choice === "default" ? raw === undefined : raw === choice) return { write: false, before, after };
  const fusion: Record<string, unknown> = { ...fusionNow };
  if (after === null) delete fusion["workerReasoning"];
  else fusion["workerReasoning"] = after;
  const llm = cfg.llm;
  cfg.llm = { ...llm, runMode: { ...llm.runMode, fusion } };
  return { write: true, before, after };
}
