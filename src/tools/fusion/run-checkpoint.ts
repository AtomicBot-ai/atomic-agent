import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  currentTurnOwnerProbe,
  isTurnOwnerGone,
  serializeTurnOwner,
  turnOwnerFor,
  type TurnOwnerProbe,
} from "../../session/turn-owner.js";
import type { DelegateTask } from "./delegate-args.js";
import type {
  WorkerTaskResult,
  WorkerTaskStatus,
  WorkerToolStats,
} from "./worker-result.js";

/**
 * Checkpoints of a fusion run (ATO-617): a long fan-out survives a crash,
 * a quit or an update instead of vanishing with its ephemeral workers.
 *
 * One JSON file per run under `<stateDir>/fusion-runs/`, written after
 * every finished task and every finished wave, deleted when the run ends
 * normally. A file left behind is a run that did not end: the process
 * died, or the turn was stopped. `run-resume.ts` turns it into a resume.
 *
 * Files rather than a table in `sessions.sqlite`: the session store's
 * schema and its turn marks are pinned invariants, a checkpoint is
 * written from inside a running tool (where a second writer on that
 * database would contend with the turn's own saves), and a run that
 * cannot be checkpointed must never fail the fan-out. Every write here
 * is best-effort, atomic (temp file + rename) and never throws.
 */

export const FUSION_RUNS_DIR_NAME = "fusion-runs";

/** How long an unfinished run is offered before it is dropped. */
export const FUSION_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A worker's reply kept in the checkpoint, at most this many chars. */
export const CHECKPOINT_REPLY_CHARS = 4_000;

const CHECKPOINT_VERSION = 1;

/** Run ids name files: nothing that could leave the directory. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Tools whose repeat cannot change anything outside the worker's
 * approved directories: reads, lookups and the turn's own terminals.
 * File tools (`os.fs.*`) count too: they act inside the fan-out's write
 * scope, behind the input guard and the restore point, which is the
 * same ground a re-run covers. Anything else — a shell command, git
 * that commits or pushes, an HTTP request, an email, an MCP tool, a paid
 * generation — may already have happened once, so the task is not run
 * again without the person's yes.
 */
const REPEAT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "finish",
  "tool.view",
  "skill.view",
  "os.web.search",
  "os.web.fetch",
  "os.git.status",
  "os.git.log",
  "os.git.diff",
  "os.git.show",
  "os.git.blame",
  "os.proc.list",
  "os.window.list",
  "os.clipboard.read",
  "memory.notes.recall",
  "memory.lessons.recall",
  "memory.procedures.recall",
  "memory.profile.list",
  "memory.profile.history",
  "tasks.list",
  "tasks.show",
  "vision.describe",
  "verify.syntax",
  "mcp.resource.list",
  "mcp.prompt.list",
  "browser.read_aria",
  "browser.screenshot",
]);

/** Whether one call of `tool` may have changed something a re-run would change again. */
export function toolHasSideEffects(tool: string): boolean {
  if (tool.startsWith("os.fs.")) return false;
  return !REPEAT_SAFE_TOOLS.has(tool);
}

/** What a finished task left in the checkpoint. */
export interface CheckpointTaskResult {
  status: WorkerTaskStatus;
  reply: string;
  stepCount: number;
  durationMs: number;
  tools: WorkerToolStats;
  error?: string;
  notes?: string[];
  /** The worker leg's priced spend for this task, `0` when unpriced. */
  costUsd: number;
}

export interface CheckpointTask {
  id: string;
  title: string;
  /**
   * The worker called a tool with effects outside its files
   * (`toolHasSideEffects`). Recorded as the calls start, so a worker
   * killed mid-task is still known to have run a command.
   */
  sideEffects: boolean;
  /** The side-effecting tools it called, for the person's question. */
  sideEffectTools: string[];
  /** Absent while the task has not finished. */
  result?: CheckpointTaskResult;
}

export type FusionRunState = "running" | "interrupted";

export interface FusionRunCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  runId: string;
  /** The orchestrator's session the fan-out ran on. */
  sessionId: string;
  workingDir: string;
  /** The person's request behind the turn, when the runtime knew it. */
  originalRequest?: string;
  /**
   * The call's own arguments (`tasks`, `maxWorkers`, `contract`), replayed
   * through `parseDelegateArgs` on resume so a resumed run is the same
   * run, not a re-plan.
   */
  args: Record<string, unknown>;
  /** `running` while a process works on it; `interrupted` once its turn was stopped. */
  state: FusionRunState;
  /** The process working on it (`serializeTurnOwner`), to tell live from dead. */
  owner: string;
  waveCount: number;
  wavesDone: number;
  tasks: CheckpointTask[];
  /** Priced spend so far (workers, escalations, judge), carried into a resume's cap. */
  spentUsd: number;
  startedAt: number;
  updatedAt: number;
  /** How many times the run was resumed. */
  resumes: number;
}

export interface FusionRunStartInput {
  /** Continue this run's file (a resume); absent mints a new id. */
  runId?: string;
  sessionId: string;
  workingDir: string;
  originalRequest?: string;
  args: Record<string, unknown>;
  tasks: readonly Pick<DelegateTask, "id" | "title">[];
  waveCount: number;
  /** The checkpoint a resume continues: its finished tasks and spend stand. */
  resumedFrom?: FusionRunCheckpoint;
}

export interface FusionRunStoreOptions {
  /** `<stateDir>/fusion-runs`. */
  dir: string;
  now?: () => number;
  probe?: TurnOwnerProbe;
  retentionMs?: number;
}

/**
 * The run files of one state dir. One instance per runtime; it knows
 * which runs this process is working on right now, so a fan-out in
 * flight is never offered for resuming.
 */
export class FusionRunStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly probe: TurnOwnerProbe;
  private readonly retentionMs: number;
  private readonly active = new Set<string>();

  constructor(options: FusionRunStoreOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? currentTurnOwnerProbe();
    this.retentionMs = options.retentionMs ?? FUSION_RUN_RETENTION_MS;
  }

  static isValidRunId(runId: string): boolean {
    return RUN_ID_PATTERN.test(runId);
  }

  /** Begin (or, with `runId`, continue) checkpointing a run. */
  start(input: FusionRunStartInput): FusionRunRecorder {
    const runId =
      input.runId !== undefined && FusionRunStore.isValidRunId(input.runId)
        ? input.runId
        : `fr-${randomUUID()}`;
    const at = this.now();
    const before = new Map(
      (input.resumedFrom?.tasks ?? []).map((t) => [t.id, t]),
    );
    const checkpoint: FusionRunCheckpoint = {
      version: CHECKPOINT_VERSION,
      runId,
      sessionId: input.sessionId,
      workingDir: input.workingDir,
      ...(input.originalRequest === undefined
        ? {}
        : { originalRequest: input.originalRequest }),
      args: input.args,
      state: "running",
      owner: serializeTurnOwner(turnOwnerFor(this.probe, at)),
      waveCount: input.waveCount,
      wavesDone: 0,
      tasks: input.tasks.map((t) => {
        const prior = before.get(t.id);
        // A finished task stands; an unfinished one keeps what is known
        // about its side effects, so a second resume still asks.
        return prior === undefined
          ? { id: t.id, title: t.title, sideEffects: false, sideEffectTools: [] }
          : { ...prior, title: t.title };
      }),
      spentUsd: input.resumedFrom?.spentUsd ?? 0,
      startedAt: input.resumedFrom?.startedAt ?? at,
      updatedAt: at,
      resumes: (input.resumedFrom?.resumes ?? -1) + 1,
    };
    this.active.add(runId);
    const recorder = new FusionRunRecorder(this, checkpoint);
    recorder.flush();
    return recorder;
  }

  /** The run's checkpoint, or `null` when there is none (or it is unreadable). */
  load(runId: string): FusionRunCheckpoint | null {
    if (!FusionRunStore.isValidRunId(runId)) return null;
    return readCheckpoint(this.path(runId));
  }

  /** A process — this one, or another alive — is working on the run now. */
  isLive(checkpoint: FusionRunCheckpoint): boolean {
    if (this.active.has(checkpoint.runId)) return true;
    if (checkpoint.state === "interrupted") return false;
    return !isTurnOwnerGone(checkpoint.owner, this.probe);
  }

  /**
   * Runs that did not end and nobody is working on, newest first;
   * `sessionId` narrows to one session. Runs past the retention are
   * deleted on the way.
   */
  listResumable(sessionId?: string): FusionRunCheckpoint[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: FusionRunCheckpoint[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const runId = name.slice(0, -".json".length);
      if (!FusionRunStore.isValidRunId(runId)) continue;
      const checkpoint = readCheckpoint(join(this.dir, name));
      if (checkpoint === null) continue;
      if (this.now() - checkpoint.updatedAt > this.retentionMs) {
        if (!this.active.has(runId)) this.remove(runId);
        continue;
      }
      if (sessionId !== undefined && checkpoint.sessionId !== sessionId) continue;
      if (this.isLive(checkpoint)) continue;
      out.push(checkpoint);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Drop a run that is not live. `false` when there was none to drop. */
  discard(runId: string): boolean {
    const checkpoint = this.load(runId);
    if (checkpoint === null || this.isLive(checkpoint)) return false;
    return this.remove(runId);
  }

  /** @internal — the recorder's write. */
  write(checkpoint: FusionRunCheckpoint): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.path(checkpoint.runId);
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(checkpoint), "utf8");
      renameSync(tmp, file);
    } catch {
      // Best-effort: a read-only state dir or a full disk costs the run
      // its resumability, never the fan-out.
    }
  }

  /** @internal — the recorder's end. */
  release(runId: string, keep: boolean): void {
    this.active.delete(runId);
    if (!keep) this.remove(runId);
  }

  /** @internal */
  stamp(): number {
    return this.now();
  }

  private remove(runId: string): boolean {
    try {
      unlinkSync(this.path(runId));
      return true;
    } catch {
      return false;
    }
  }

  private path(runId: string): string {
    return join(this.dir, `${runId}.json`);
  }
}

/** One run's checkpoint as the fan-out writes it. */
export class FusionRunRecorder {
  private ended = false;

  constructor(
    private readonly store: FusionRunStore,
    private readonly checkpoint: FusionRunCheckpoint,
  ) {}

  get runId(): string {
    return this.checkpoint.runId;
  }

  /** A copy of what is recorded so far. */
  snapshot(): FusionRunCheckpoint {
    return structuredClone(this.checkpoint);
  }

  /**
   * A worker started `tool`. Written only when it is the task's first
   * side-effecting call: a worker killed right after it is still known
   * not to be safe to repeat.
   */
  noteTool(taskId: string, tool: string): void {
    if (this.ended || !toolHasSideEffects(tool)) return;
    const task = this.checkpoint.tasks.find((t) => t.id === taskId);
    if (task === undefined || task.sideEffectTools.includes(tool)) return;
    const first = !task.sideEffects;
    task.sideEffects = true;
    task.sideEffectTools.push(tool);
    if (first) this.flush();
  }

  /** A task finished: its row and its spend are written at once. */
  recordTask(result: WorkerTaskResult, costUsd = 0): void {
    if (this.ended) return;
    const task = this.checkpoint.tasks.find((t) => t.id === result.id);
    if (task === undefined) return;
    // The finished row's own tool counts also decide, for a worker whose
    // tool events were not seen (a test harness, an embedder).
    for (const tool of Object.keys(result.tools.byTool)) {
      if (toolHasSideEffects(tool) && !task.sideEffectTools.includes(tool)) {
        task.sideEffects = true;
        task.sideEffectTools.push(tool);
      }
    }
    const spend = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
    task.result = {
      status: result.status,
      reply: result.reply.slice(0, CHECKPOINT_REPLY_CHARS),
      stepCount: result.stepCount,
      durationMs: result.durationMs,
      tools: result.tools,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.notes === undefined ? {} : { notes: result.notes }),
      costUsd: spend,
    };
    this.checkpoint.spentUsd += spend;
    this.flush();
  }

  /** Spend not on a finished row (an escalation, the judge, a split's parent). */
  addSpend(usd: number): void {
    if (this.ended || !Number.isFinite(usd) || usd <= 0) return;
    this.checkpoint.spentUsd += usd;
    this.flush();
  }

  /** `done` waves have finished. */
  recordWave(done: number): void {
    if (this.ended) return;
    this.checkpoint.wavesDone = Math.max(this.checkpoint.wavesDone, done);
    this.flush();
  }

  /**
   * The run ended. `complete` deletes the file: nothing is left to
   * resume. `interrupted` (the turn was stopped) keeps it, marked so it
   * is offered at once rather than after its process is gone.
   */
  finish(outcome: "complete" | "interrupted"): void {
    if (this.ended) return;
    if (outcome === "interrupted") {
      this.checkpoint.state = "interrupted";
      this.flush();
    }
    this.ended = true;
    this.store.release(this.checkpoint.runId, outcome === "interrupted");
  }

  /** @internal */
  flush(): void {
    this.checkpoint.updatedAt = this.store.stamp();
    this.store.write(this.checkpoint);
  }
}

function readCheckpoint(file: string): FusionRunCheckpoint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<FusionRunCheckpoint>;
  if (
    c.version !== CHECKPOINT_VERSION ||
    typeof c.runId !== "string" ||
    typeof c.sessionId !== "string" ||
    typeof c.workingDir !== "string" ||
    typeof c.args !== "object" ||
    c.args === null ||
    !Array.isArray(c.tasks) ||
    typeof c.updatedAt !== "number" ||
    typeof c.owner !== "string"
  ) {
    return null;
  }
  return c as FusionRunCheckpoint;
}
