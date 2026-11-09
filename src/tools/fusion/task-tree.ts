import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import type { DelegateContract } from "./contract.js";
import {
  completedWaveNotes,
  contractForWave,
  dependencyWarnings,
  planWaves,
} from "./contract-waves.js";
import {
  MAX_DELEGATE_TASKS,
  parseDelegateArgs,
  type DelegateTask,
} from "./delegate-args.js";
import {
  applyDeclaredFileReport,
  applyNoChangesRule,
  inspectDeclaredFiles,
} from "./declared-files.js";
import {
  deliveredNothing,
  type WorkerTaskResult,
  type WorkerTaskStatus,
} from "./worker-result.js";

/**
 * The fusion task tree (ATO-940).
 *
 * The fan-out used to be flat: a worker whose task turned out too big
 * either ran out of steps or was handed back at half its budget, and
 * the orchestrator had to notice, re-split and re-send. With
 * `llm.runMode.fusion.taskTree.enabled` a worker may instead END its
 * turn with a `split_proposal` block in its reply. It never delegates
 * by itself — `fusion.delegate` stays hidden from workers and refused
 * from inside one — it only proposes. The parent (`fusion.delegate`, in
 * the orchestrator's turn) validates the proposal with the same parser
 * as its own args, records the node under its parent, runs the subtasks
 * as a new wave through the same runner, checks their contract and the
 * parent's declared files, and closes the parent row on what they
 * delivered.
 *
 * Bounded three ways: the depth (the orchestrator's tasks are depth 1;
 * `maxDepth`, at most `FUSION_TASK_TREE_MAX_DEPTH` = 3), the total node
 * count of one fan-out (`maxNodes`), and the turn's own caps, which
 * every child worker passes through like any other (ATO-947). A child
 * never gets a bigger step or time budget than the task it came from.
 */

/** The fence tag a worker wraps its proposal in. */
export const SPLIT_PROPOSAL_TAG = "split_proposal";

/** A split into one part is not a split. */
export const MIN_SPLIT_TASKS = 2;

/** How much of a node's brief the tree keeps as its goal. */
const GOAL_CHARS = 200;
/** How much of each child's reply the parent's reply carries. */
const CHILD_REPLY_CHARS = 600;

export interface TaskTreeLimits {
  /** Deepest level a node may sit at; the orchestrator's tasks are 1. */
  maxDepth: number;
  /** Every node of one fan-out, the orchestrator's tasks included. */
  maxNodes: number;
}

/** One node of the tree, for `details.taskTree` (TUI, trace). */
export interface TaskTreeNode {
  id: string;
  title: string;
  /** The start of the node's brief. */
  goal: string;
  depth: number;
  parentId?: string;
  model: string;
  status: WorkerTaskStatus;
  budget: { maxSteps?: number; timeoutMs?: number };
  /** What the node's contract binds it to, when it has one. */
  contract?: { owns: string[]; provides: string[]; requires: string[] };
  /** Why the worker split it, when it did. */
  splitReason?: string;
  /** Why a proposal it made was refused, when one was. */
  splitRejected?: string;
  children: TaskTreeNode[];
}

export interface TaskTreeReport {
  maxDepth: number;
  maxNodes: number;
  nodes: number;
  /** Proposals accepted and run, refused. */
  splits: number;
  rejected: number;
  roots: TaskTreeNode[];
}

/** The tree of one fan-out, built as its waves run. */
export class TaskTreeState {
  private count = 0;
  private splits = 0;
  private rejected = 0;
  private readonly roots: TaskTreeNode[] = [];
  private readonly byId = new Map<string, TaskTreeNode>();

  constructor(
    readonly limits: TaskTreeLimits,
    private readonly model: string,
  ) {}

  get nodes(): number {
    return this.count;
  }

  /** Room left for new nodes. */
  get nodesLeft(): number {
    return Math.max(0, this.limits.maxNodes - this.count);
  }

  depthOf(taskId: string): number {
    return this.byId.get(taskId)?.depth ?? 1;
  }

  parentOf(taskId: string): string | undefined {
    return this.byId.get(taskId)?.parentId;
  }

  /** Whether a node at `depth` may still propose a split. */
  canSplitAt(depth: number): boolean {
    return depth < this.limits.maxDepth && this.nodesLeft >= MIN_SPLIT_TASKS;
  }

  /** The orchestrator's own tasks: depth 1, counted against the cap. */
  addRoots(
    tasks: readonly DelegateTask[],
    contract: DelegateContract | undefined,
  ): void {
    for (const task of tasks) {
      const node = this.makeNode(task, 1, undefined, contract);
      this.roots.push(node);
    }
  }

  /** A proposal's children, under `parentId`. */
  addChildren(
    parentId: string,
    tasks: readonly DelegateTask[],
    contract: DelegateContract | undefined,
    reason: string | undefined,
  ): void {
    const parent = this.byId.get(parentId);
    const depth = (parent?.depth ?? 1) + 1;
    this.splits += 1;
    if (parent !== undefined && reason !== undefined) {
      parent.splitReason = reason;
    }
    for (const task of tasks) {
      const node = this.makeNode(task, depth, parentId, contract);
      parent?.children.push(node);
    }
  }

  noteRejected(taskId: string, why: string): void {
    this.rejected += 1;
    const node = this.byId.get(taskId);
    if (node !== undefined) node.splitRejected = why;
  }

  setStatus(taskId: string, status: WorkerTaskStatus): void {
    const node = this.byId.get(taskId);
    if (node !== undefined) node.status = status;
  }

  report(): TaskTreeReport {
    return {
      maxDepth: this.limits.maxDepth,
      maxNodes: this.limits.maxNodes,
      nodes: this.count,
      splits: this.splits,
      rejected: this.rejected,
      roots: this.roots,
    };
  }

  private makeNode(
    task: DelegateTask,
    depth: number,
    parentId: string | undefined,
    contract: DelegateContract | undefined,
  ): TaskTreeNode {
    this.count += 1;
    const node: TaskTreeNode = {
      id: task.id,
      title: task.title,
      goal: oneLine(task.instructions, GOAL_CHARS),
      depth,
      ...(parentId === undefined ? {} : { parentId }),
      model: this.model,
      status: "cancelled",
      budget: {
        ...(task.maxSteps === undefined ? {} : { maxSteps: task.maxSteps }),
        ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
      },
      ...describeNodeContract(task.id, contract),
      children: [],
    };
    this.byId.set(task.id, node);
    return node;
  }
}

function describeNodeContract(
  taskId: string,
  contract: DelegateContract | undefined,
): Pick<TaskTreeNode, "contract"> {
  if (contract === undefined) return {};
  const owns = Object.entries(contract.owners ?? {})
    .filter(([, owner]) => owner === taskId)
    .map(([path]) => path);
  const provides = (contract.provides ?? [])
    .filter((p) => p.task === taskId)
    .map((p) => `${p.kind} ${p.name}`);
  const requires = (contract.requires ?? [])
    .filter((r) => r.task === taskId)
    .map((r) => r.name);
  if (owns.length + provides.length + requires.length === 0) return {};
  return { contract: { owns, provides, requires } };
}

/**
 * What a worker that may split is told, appended to its brief. Short:
 * every brief pays for it, and most tasks never need it.
 */
export function renderSplitInstructions(maxSubtasks: number): string {
  const most = Math.max(MIN_SPLIT_TASKS, Math.min(MAX_DELEGATE_TASKS, maxSubtasks));
  return [
    `## If this task is too big`,
    `If you find this task is too big to finish in your budget (half your steps gone with nothing written, or your answers keep getting cut off), do not keep going and do not give up: end your turn with a reply that carries one block in this exact form, and nothing else you have not done:`,
    "```" + SPLIT_PROPOSAL_TAG,
    `{"reason": "why it is too big, one line", "tasks": [{"id": "part-a", "title": "short label", "instructions": "a complete brief for a worker who has not seen this task", "files": ["only paths from your own task's files"]}], "contract": {"provides": [], "requires": []}}`,
    "```",
    `Between ${MIN_SPLIT_TASKS} and ${most} subtasks; \`contract\` is optional and has the same shape as the delegate's, naming these subtask ids. Each subtask runs as its own worker after you, and your task closes on what they deliver. Do not propose a split for a task you can finish.`,
  ].join("\n");
}

/** The steer a worker gets at the moment it may propose a split. */
export function splitSteer(cause: "half-budget" | "answer-cut"): string {
  const why =
    cause === "half-budget"
      ? "You have used half your budget and written nothing yet."
      : "Your last answer was cut off at the length limit.";
  return `${why} If this task is too big for you, reply now with a \`${SPLIT_PROPOSAL_TAG}\` block as your brief describes. Otherwise write the files now, in smaller pieces.`;
}

/** Whether a reply carries a proposal block at all (well-formed or not). */
export function hasSplitProposal(reply: string): boolean {
  return PROPOSAL_FENCE.test(reply);
}

const PROPOSAL_FENCE = new RegExp(
  "```" + SPLIT_PROPOSAL_TAG + "[ \\t]*\\r?\\n([\\s\\S]*?)```",
);

export type ExtractedProposal =
  | { found: false }
  | { found: true; raw: unknown }
  | { found: true; error: string };

/** The proposal block's JSON, or why it could not be read. */
export function extractSplitProposal(reply: string): ExtractedProposal {
  const match = PROPOSAL_FENCE.exec(reply);
  if (match === null) return { found: false };
  const body = (match[1] ?? "").trim();
  if (body.length === 0) {
    return { found: true, error: "the split_proposal block is empty" };
  }
  try {
    return { found: true, raw: JSON.parse(body) as unknown };
  } catch (err) {
    return {
      found: true,
      error: `the split_proposal block is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

export interface SplitLimits {
  /** The depth of the node that proposed. */
  depth: number;
  maxDepth: number;
  /** Nodes already in the tree. */
  nodes: number;
  maxNodes: number;
  /** The proposing task's own step budget, which no child may exceed. */
  stepBudget: number;
  /** The proposing task's own time budget, which no child may exceed. */
  timeBudgetMs: number;
}

export type ValidatedSplit =
  | {
      ok: true;
      /** The subtasks, ids prefixed with the parent's (`parent/child`). */
      tasks: DelegateTask[];
      contract?: DelegateContract;
      reason?: string;
    }
  | { ok: false; error: string };

const PROPOSAL_KEYS: ReadonlySet<string> = new Set([
  "reason",
  "tasks",
  "contract",
]);

/**
 * Validate a proposal against the parent it splits and the tree's caps.
 *
 * The subtasks and their contract go through `parseDelegateArgs`, the
 * same parser as the orchestrator's own call, so a proposal is held to
 * every cap a delegation is (task count, brief length, file count,
 * contract owners/provides/requires/checks). On top of that: at least
 * two subtasks, the depth and node caps, and — when the parent declared
 * files — no subtask may declare a file the parent did not, so a split
 * never widens what the operator approved for the fan-out.
 *
 * Ids are namespaced under the parent (`parent/child`) and the contract
 * is rewritten to match, so two parents that both propose `part-a`
 * never collide.
 */
export function validateSplitProposal(
  raw: unknown,
  parent: DelegateTask,
  limits: SplitLimits,
): ValidatedSplit {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("the proposal must be an object { reason?, tasks, contract? }");
  }
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !PROPOSAL_KEYS.has(k));
  if (unknown.length > 0) {
    return refuse(`unknown key${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`);
  }
  if (limits.depth >= limits.maxDepth) {
    return refuse(
      `the task tree is already ${limits.depth} deep, its limit (llm.runMode.fusion.taskTree.maxDepth ${limits.maxDepth})`,
    );
  }
  const parsed = parseDelegateArgs({
    tasks: obj.tasks,
    ...(obj.contract === undefined ? {} : { contract: obj.contract }),
  });
  if (!parsed.ok) return refuse(parsed.error);
  const problems: string[] = [];
  if (parsed.tasks.length < MIN_SPLIT_TASKS) {
    problems.push(`a split needs at least ${MIN_SPLIT_TASKS} subtasks`);
  }
  if (limits.nodes + parsed.tasks.length > limits.maxNodes) {
    problems.push(
      `${parsed.tasks.length} subtasks would make ${limits.nodes + parsed.tasks.length} nodes; the tree's limit is ${limits.maxNodes} (llm.runMode.fusion.taskTree.maxNodes)`,
    );
  }
  const allowed = new Set((parent.files ?? []).map(normalisePath));
  if (allowed.size > 0) {
    for (const task of parsed.tasks) {
      for (const file of task.files ?? []) {
        if (!allowed.has(normalisePath(file))) {
          problems.push(
            `subtask ${task.id} declares ${file}, which is not one of the parent task's files`,
          );
        }
      }
    }
  }
  if (problems.length > 0) return refuse(problems.join("; "));

  const rename = (id: string): string => `${parent.id}/${id}`;
  const tasks = parsed.tasks.map((task) => {
    const maxSteps = Math.min(task.maxSteps ?? limits.stepBudget, limits.stepBudget);
    const timeoutMs = Math.min(
      task.timeoutMs ?? limits.timeBudgetMs,
      limits.timeBudgetMs,
    );
    return { ...task, id: rename(task.id), maxSteps, timeoutMs };
  });
  const reason =
    typeof obj.reason === "string" && obj.reason.trim().length > 0
      ? oneLine(obj.reason, 300)
      : undefined;
  return {
    ok: true,
    tasks,
    ...(parsed.contract === undefined
      ? {}
      : { contract: renameContract(parsed.contract, rename) }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function refuse(error: string): ValidatedSplit {
  return { ok: false, error: `split proposal refused: ${error}` };
}

function normalisePath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The contract with every task id it names moved under the parent. */
export function renameContract(
  contract: DelegateContract,
  rename: (id: string) => string,
): DelegateContract {
  return {
    ...contract,
    ...(contract.owners === undefined
      ? {}
      : {
          owners: Object.fromEntries(
            Object.entries(contract.owners).map(([path, id]) => [path, rename(id)]),
          ),
        }),
    ...(contract.provides === undefined
      ? {}
      : { provides: contract.provides.map((p) => ({ ...p, task: rename(p.task) })) }),
    ...(contract.requires === undefined
      ? {}
      : { requires: contract.requires.map((r) => ({ ...r, task: rename(r.task) })) }),
    ...(contract.checks === undefined
      ? {}
      : {
          checks: contract.checks.map((c) =>
            typeof c.task === "string" ? { ...c, task: rename(c.task) } : c,
          ),
        }),
  };
}

/** The statuses whose reply is read for a proposal. */
const PROPOSING_STATUSES: ReadonlySet<WorkerTaskStatus> = new Set([
  "ok",
  "no_changes",
  "needs_orchestrator",
  "max_steps",
]);

export interface ExpandSplitsDeps {
  tree: TaskTreeState;
  workingDir: string;
  /** The fan-out's own contract; its `inputs` stay protected for every child. */
  parentContract?: DelegateContract;
  /** The configured per-worker defaults a task without its own budget gets. */
  workerMaxSteps: number;
  workerTimeoutMs: number;
  /**
   * Run one wave of child tasks through the fan-out's runner (same
   * width, same turn caps, same approval scope).
   */
  runChildren: (
    tasks: readonly DelegateTask[],
    contract: DelegateContract | undefined,
    briefSuffix: (taskId: string) => string | undefined,
  ) => Promise<WorkerTaskResult[]>;
  /**
   * The children's own contract verdict (provides on disk, checks),
   * folded into their rows; `failedChecks` are the failed checks that
   * name no subtask, which fail the parent. Absent: the rows stand as
   * they came back.
   */
  evaluateChildren?: (
    rows: WorkerTaskResult[],
    tasks: readonly DelegateTask[],
    contract: DelegateContract,
  ) => Promise<{ rows: WorkerTaskResult[]; failedChecks?: string[] }>;
  /** False once the turn is cancelled or its cap reached: no new split runs. */
  mayStart?: () => boolean;
}

/**
 * Read every row of one wave for a proposal and run the accepted ones.
 * Returns the wave's rows with each split parent replaced by its closed
 * row; children are in the tree (`details.taskTree`) and summarised in
 * the parent's reply, not separate rows, so the contract, the judge and
 * the replan keep reading the orchestrator's own task ids.
 */
export async function expandSplits(
  tasks: readonly DelegateTask[],
  rows: readonly WorkerTaskResult[],
  deps: ExpandSplitsDeps,
): Promise<WorkerTaskResult[]> {
  const out: WorkerTaskResult[] = [];
  for (const row of rows) {
    const task = tasks.find((t) => t.id === row.id);
    out.push(task === undefined ? row : await expandOne(task, row, deps));
  }
  return out;
}

async function expandOne(
  task: DelegateTask,
  row: WorkerTaskResult,
  deps: ExpandSplitsDeps,
): Promise<WorkerTaskResult> {
  const { tree } = deps;
  const startedAt = Date.now() - row.durationMs;
  if (!PROPOSING_STATUSES.has(row.status)) {
    tree.setStatus(task.id, row.status);
    return row;
  }
  const extracted = extractSplitProposal(row.reply);
  if (!extracted.found) {
    tree.setStatus(task.id, row.status);
    return row;
  }
  const depth = tree.depthOf(task.id);
  const validated: ValidatedSplit =
    "error" in extracted
      ? { ok: false, error: `split proposal refused: ${extracted.error}` }
      : deps.mayStart?.() === false
        ? { ok: false, error: "split proposal not run: the turn was stopped" }
        : validateSplitProposal(extracted.raw, task, {
            depth,
            maxDepth: tree.limits.maxDepth,
            nodes: tree.nodes,
            maxNodes: tree.limits.maxNodes,
            stepBudget: task.maxSteps ?? deps.workerMaxSteps,
            timeBudgetMs: task.timeoutMs ?? deps.workerTimeoutMs,
          });
  if (!validated.ok) {
    tree.noteRejected(task.id, validated.error);
    // The worker stopped to propose and did not do the work: it is a
    // task for the orchestrator, as a hand-back is today.
    const status: WorkerTaskStatus =
      row.status === "ok" || row.status === "no_changes"
        ? "needs_orchestrator"
        : row.status;
    tree.setStatus(task.id, status);
    return {
      ...row,
      status,
      error: row.error === undefined ? validated.error : `${validated.error}; ${row.error}`,
      notes: [
        ...(row.notes ?? []),
        "re-brief the task yourself or split it in your next fusion.delegate",
      ],
    };
  }

  const childContract = inheritInputs(validated.contract, deps.parentContract);
  tree.addChildren(task.id, validated.tasks, childContract, validated.reason);
  const { rows: childRows, failedChecks } = await runChildTasks(
    task,
    validated.tasks,
    childContract,
    validated.reason,
    depth + 1,
    deps,
  );
  const closed = await closeParent(
    task,
    row,
    childRows,
    failedChecks ?? [],
    validated.reason,
    startedAt,
    deps,
  );
  tree.setStatus(task.id, closed.status);
  return closed;
}

/** The fan-out's protected inputs stay protected for the children. */
function inheritInputs(
  contract: DelegateContract | undefined,
  parent: DelegateContract | undefined,
): DelegateContract | undefined {
  const inherited = parent?.inputs ?? [];
  if (inherited.length === 0) return contract;
  const inputs = [...new Set([...inherited, ...(contract?.inputs ?? [])])];
  return { ...(contract ?? {}), inputs };
}

async function runChildTasks(
  parent: DelegateTask,
  children: readonly DelegateTask[],
  contract: DelegateContract | undefined,
  reason: string | undefined,
  depth: number,
  deps: ExpandSplitsDeps,
): Promise<{ rows: WorkerTaskResult[]; failedChecks?: string[] }> {
  const { tree } = deps;
  const context = [
    `## Part of a larger task`,
    `This is one part of [${parent.id}] ${parent.title}, which the worker that had it split into ${children.length} parts${reason === undefined ? "" : ` (${reason})`}. Do only your part; the other parts run as their own workers.`,
  ].join("\n");
  const suffix = (_taskId: string): string =>
    tree.canSplitAt(depth)
      ? `${context}\n\n${renderSplitInstructions(tree.nodesLeft)}`
      : context;
  const plan = planWaves(
    children.map((t) => t.id),
    contract,
  );
  const finished = new Map<string, WorkerTaskResult>();
  const warnings: string[] = plan.cycle === undefined ? [] : [plan.cycle];
  for (const wave of plan.waves) {
    warnings.push(...dependencyWarnings(wave, plan.dependencies, finished));
    const waveTasks = children.filter((t) => wave.includes(t.id));
    const waveContract = contractForWave(contract, [
      ...warnings,
      ...completedWaveNotes(finished),
    ]);
    const ran = await deps.runChildren(waveTasks, waveContract, suffix);
    // A child that proposed a split of its own is expanded the same way,
    // one level down, before its dependents run.
    const expanded = await expandSplits(waveTasks, ran, deps);
    for (const r of expanded) finished.set(r.id, r);
  }
  let rows = children.flatMap((t) => {
    const r = finished.get(t.id);
    return r === undefined ? [] : [r];
  });
  let failedChecks: string[] | undefined;
  if (contract !== undefined && deps.evaluateChildren !== undefined) {
    const evaluated = await deps.evaluateChildren(rows, children, contract);
    rows = evaluated.rows;
    failedChecks = evaluated.failedChecks;
  }
  for (const r of rows) tree.setStatus(r.id, r.status);
  return { rows, ...(failedChecks === undefined ? {} : { failedChecks }) };
}

/** Notes the declared-file check wrote, re-decided once the children ran. */
const FILE_CHECK_NOTE =
  /(^declared file .* does not exist after the task)|( unchanged by this task$)|(^no write, edit or patch call succeeded)/;

/**
 * The parent row once its children ran: `ok` when every child is, the
 * parent's declared files permitting; `failed` when none delivered
 * anything; otherwise `needs_orchestrator`, naming the children that
 * did not close. Tokens, tool calls and steps are the parent's plus its
 * children's, so the fan-out's bill counts every node.
 */
async function closeParent(
  task: DelegateTask,
  row: WorkerTaskResult,
  children: readonly WorkerTaskResult[],
  failedChecks: readonly string[],
  reason: string | undefined,
  startedAt: number,
  deps: ExpandSplitsDeps,
): Promise<WorkerTaskResult> {
  const open = children.filter((c) => c.status !== "ok");
  const status: WorkerTaskStatus =
    children.length > 0 && children.every(deliveredNothing)
      ? "failed"
      : failedChecks.length > 0
        ? "failed"
        : open.length === 0
          ? "ok"
          : "needs_orchestrator";
  const summary = children.map(
    (c) =>
      `[${c.id}] ${c.status} — ${c.title}: ${oneLine(c.error ?? c.reply, CHILD_REPLY_CHARS)}`,
  );
  const tools = sumTools(row, children);
  const usage = sumUsage([row, ...children]);
  const { error: _parentError, ...parentRow } = row;
  let closed: WorkerTaskResult = {
    ...parentRow,
    status,
    reply: [
      `Split by the worker into ${children.length} subtasks${reason === undefined ? "" : ` (${reason})`}:`,
      ...summary,
    ].join("\n"),
    stepCount: row.stepCount + children.reduce((n, c) => n + c.stepCount, 0),
    durationMs: Math.max(row.durationMs, Date.now() - startedAt),
    tools,
    ...(usage === undefined ? {} : { usage }),
    notes: [
      ...(row.notes ?? []).filter((n) => !FILE_CHECK_NOTE.test(n)),
      `split into ${children.length} subtasks: ${children.map((c) => `${c.id} ${c.status}`).join(", ")}`,
    ],
  };
  const errors = [
    ...(failedChecks.length === 0
      ? []
      : [`checks: ${failedChecks.join("; ")}`]),
    ...(open.length === 0
      ? []
      : [
          `subtasks not closed: ${open
            .map((c) => `${c.id} (${c.status}${c.error === undefined ? "" : `: ${oneLine(c.error, 160)}`})`)
            .join("; ")}`,
        ]),
  ];
  if (errors.length > 0) closed = { ...closed, error: errors.join("; ") };
  // The parent's own declared files, now that its children wrote them.
  if ((task.files?.length ?? 0) > 0) {
    const report = await inspectDeclaredFiles(task.files!, deps.workingDir, startedAt);
    closed = applyNoChangesRule(applyDeclaredFileReport(closed, report), report);
  }
  return closed;
}

function sumTools(
  row: WorkerTaskResult,
  children: readonly WorkerTaskResult[],
): WorkerTaskResult["tools"] {
  const byTool: Record<string, number> = { ...row.tools.byTool };
  let calls = row.tools.calls;
  let errors = row.tools.errors;
  let writes = row.tools.writes;
  for (const c of children) {
    calls += c.tools.calls;
    errors += c.tools.errors;
    writes += c.tools.writes;
    for (const [tool, n] of Object.entries(c.tools.byTool)) {
      byTool[tool] = (byTool[tool] ?? 0) + n;
    }
  }
  return { calls, errors, writes, byTool };
}

function sumUsage(rows: readonly WorkerTaskResult[]): CompletionUsage | undefined {
  let usage: CompletionUsage | undefined;
  for (const r of rows) {
    if (r.usage === undefined) continue;
    usage =
      usage === undefined
        ? { ...r.usage }
        : {
            promptTokens: usage.promptTokens + r.usage.promptTokens,
            completionTokens: usage.completionTokens + r.usage.completionTokens,
            totalTokens: usage.totalTokens + r.usage.totalTokens,
            ...(usage.cachedTokens === undefined && r.usage.cachedTokens === undefined
              ? {}
              : {
                  cachedTokens:
                    (usage.cachedTokens ?? 0) + (r.usage.cachedTokens ?? 0),
                }),
          };
  }
  return usage;
}

function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}
