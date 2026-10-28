import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import type { DelegateTask } from "./delegate-args.js";
import { describeProvide, type DelegateContract } from "./contract.js";
import type {
  ContractCheckOutcome,
  ContractFinding,
} from "./contract-checks.js";
import type { EscalationComplete } from "./escalation.js";
import type { WorkerPricing, WorkerTaskResult } from "./worker-result.js";

/**
 * The trimmed judge (ATO-944): a node is closed by its acceptance list,
 * not by its worker saying "done".
 *
 * Every benchmark run so far reported "verified" over wrong scenes: the
 * contract's checks catch a crash, not wrong behaviour, and the worker's
 * own reply is the least reliable witness there is. So, with
 * `llm.runMode.fusion.judge: "on"`:
 *
 *  1. **Before the work** each task gets an acceptance checklist built
 *     from the contract — its `checks`, its `provides`, its declared
 *     files — plus its deliverable and instructions. The worker reads it
 *     in its brief and cannot change it.
 *  2. **After the work** the list is checked. Facts first: a check that
 *     failed or did not run, a provide that is missing, a declared file
 *     that is absent or empty are red, whatever any model says. Then a
 *     judge in a fresh context — no worker transcript, no worker claims
 *     about files — reads the files themselves and rules on the items no
 *     script can (the deliverable, a provide's shape, the instructions).
 *     The judge can only add red: it never turns a failed fact green.
 *     An item it gives no verdict for is red. An answer that cannot be
 *     read leaves the node unverified, never green.
 *  3. A red list re-runs the task once with the judge's findings; a list
 *     still red after that is reported as failed, item by item.
 */

export type AcceptanceItemKind =
  | "check"
  | "provide"
  | "file"
  | "deliverable"
  | "instructions";

export interface AcceptanceItem {
  id: string;
  kind: AcceptanceItemKind;
  text: string;
  /** `check`: index into `contract.checks`, i.e. into the check outcomes. */
  checkIndex?: number;
  /** `provide`: the provide's name, to find its presence finding. */
  provideName?: string;
  /** `provide` with a shape: the judge also rules on the meaning. */
  judged: boolean;
  /** `file`: the declared path. */
  path?: string;
}

const INSTRUCTIONS_ITEM_CHARS = 300;
/** How much of each file, and of all files, the judge reads. */
export const JUDGE_FILE_CHARS = 6_000;
export const JUDGE_EVIDENCE_CHARS = 24_000;
/** Room for one short verdict per item. */
export const JUDGE_MAX_OUTPUT_TOKENS = 1_200;

export function buildAcceptanceChecklist(
  task: DelegateTask,
  contract: DelegateContract | undefined,
): AcceptanceItem[] {
  const items: AcceptanceItem[] = [];
  const next = (): string => `a${items.length + 1}`;
  (contract?.checks ?? []).forEach((check, index) => {
    if (check.task !== task.id) return;
    const { task: _task, ...spec } = check;
    items.push({
      id: next(),
      kind: "check",
      text: `the check passes: ${JSON.stringify(spec).slice(0, 200)}`,
      checkIndex: index,
      judged: false,
    });
  });
  for (const provide of contract?.provides ?? []) {
    if (provide.task !== task.id) continue;
    items.push({
      id: next(),
      kind: "provide",
      text: `provides ${describeProvide(provide)}`,
      provideName: provide.name,
      judged: provide.shape !== undefined,
    });
  }
  for (const path of task.files ?? []) {
    items.push({
      id: next(),
      kind: "file",
      text: `${path} exists and is not empty`,
      path,
      judged: false,
    });
  }
  if (task.deliverable !== undefined && task.deliverable.trim().length > 0) {
    items.push({
      id: next(),
      kind: "deliverable",
      text: `the deliverable is met: ${task.deliverable.trim()}`,
      judged: true,
    });
  }
  const instructions = task.instructions.replace(/\s+/g, " ").trim();
  items.push({
    id: next(),
    kind: "instructions",
    text: `the task is done as instructed: ${instructions.length > INSTRUCTIONS_ITEM_CHARS ? `${instructions.slice(0, INSTRUCTIONS_ITEM_CHARS)}…` : instructions}`,
    judged: true,
  });
  return items;
}

/** What the worker reads in its brief: the list, read-only. */
export function renderAcceptanceBlock(items: readonly AcceptanceItem[]): string {
  return [
    "ACCEPTANCE CHECKLIST (read-only). After you finish, a separate judge with no access to this conversation checks every item against the files and check results — not against your reply. Your task does not close until every item is green:",
    ...items.map((item) => `- [${item.id}] ${item.text}`),
  ].join("\n");
}

export interface ItemVerdict {
  id: string;
  pass: boolean;
  why: string;
  /**
   * Who decided: a fact (check, presence, file), the judge, or nobody —
   * `skipped` when a fact was already red and the judge was not asked
   * (the list cannot be green either way; asking would only cost).
   */
  by: "fact" | "judge" | "skipped";
}

export interface JudgeVerdict {
  /** Every item green. */
  green: boolean;
  items: ItemVerdict[];
  /** Why no verdict could be reached, when none was; never green then. */
  unverified?: string;
  costUsd: number | null;
}

export interface JudgeFacts {
  /** Outcomes in `contract.checks` order (`runContractChecks`). */
  checkOutcomes: readonly (ContractCheckOutcome | undefined)[];
  findings: readonly ContractFinding[];
}

/** The facts' verdicts; `undefined` for an item only the judge can rule on. */
async function factVerdict(
  item: AcceptanceItem,
  facts: JudgeFacts,
  workingDir: string,
): Promise<ItemVerdict | undefined> {
  if (item.kind === "check") {
    const outcome = facts.checkOutcomes[item.checkIndex ?? -1];
    if (outcome === undefined) {
      return { id: item.id, pass: false, why: "the check did not run", by: "fact" };
    }
    return { id: item.id, pass: outcome.ok, why: outcome.detail, by: "fact" };
  }
  if (item.kind === "provide") {
    const finding = facts.findings.find((f) => f.name === item.provideName);
    if (finding !== undefined && !finding.present) {
      return {
        id: item.id,
        pass: false,
        why: finding.detail ?? `not found in ${finding.where.join(", ")}`,
        by: "fact",
      };
    }
    return item.judged
      ? undefined
      : {
          id: item.id,
          pass: finding !== undefined,
          why: finding === undefined ? "its presence could not be checked" : "present",
          by: "fact",
        };
  }
  if (item.kind === "file") {
    try {
      const info = await stat(absolute(item.path ?? "", workingDir));
      return info.isFile() && info.size > 0
        ? { id: item.id, pass: true, why: `${info.size} bytes`, by: "fact" }
        : { id: item.id, pass: false, why: "empty or not a file", by: "fact" };
    } catch {
      return { id: item.id, pass: false, why: "missing", by: "fact" };
    }
  }
  return undefined;
}

function absolute(path: string, workingDir: string): string {
  return isAbsolute(path) ? path : resolve(workingDir, path);
}

/** The files the judge reads, clipped; the worker's reply only when there are none. */
export async function gatherEvidence(
  task: DelegateTask,
  contract: DelegateContract | undefined,
  reply: string,
  workingDir: string,
): Promise<string> {
  const paths = [
    ...(task.files ?? []),
    ...(contract?.provides ?? [])
      .filter((p) => p.task === task.id && p.in !== undefined)
      .map((p) => p.in!),
  ].filter((p, i, all) => all.indexOf(p) === i);
  if (paths.length === 0) {
    return [
      "This task declared no files, so its reply is the deliverable. Judge what the reply contains, not what it says it did elsewhere.",
      "### reply",
      reply.length > JUDGE_EVIDENCE_CHARS ? `${reply.slice(0, JUDGE_EVIDENCE_CHARS)}\n[… clipped]` : reply,
    ].join("\n");
  }
  const parts: string[] = [];
  let budget = JUDGE_EVIDENCE_CHARS;
  for (const path of paths) {
    if (budget <= 0) {
      parts.push(`### ${path}\n[not shown: evidence budget spent]`);
      continue;
    }
    let body: string;
    try {
      body = await readFile(absolute(path, workingDir), "utf8");
    } catch {
      parts.push(`### ${path}\n[missing]`);
      continue;
    }
    const cap = Math.min(JUDGE_FILE_CHARS, budget);
    const shown = body.length > cap ? `${body.slice(0, cap)}\n[… ${body.length - cap} more chars clipped]` : body;
    budget -= shown.length;
    parts.push(`### ${path}\n${shown}`);
  }
  return parts.join("\n\n");
}

export function renderJudgePrompt(input: {
  task: DelegateTask;
  items: readonly AcceptanceItem[];
  facts: readonly ItemVerdict[];
  evidence: string;
}): string {
  const judged = input.items.filter(
    (item) => !input.facts.some((fact) => fact.id === item.id),
  );
  return [
    "You are a strict acceptance judge. A worker says it finished the task below. Do not trust it: find where the work does NOT meet each item. Rule only from the evidence shown. If the evidence does not show an item is met, it is not met.",
    "",
    "## Task",
    input.task.instructions.slice(0, 4_000),
    "",
    "## Items to rule on",
    ...judged.map((item) => `- ${item.id}: ${item.text}`),
    "",
    "## Already established by scripts (for context; not yours to change)",
    ...(input.facts.length === 0
      ? ["(none)"]
      : input.facts.map((f) => `- ${f.id}: ${f.pass ? "met" : "NOT met"} — ${f.why}`)),
    "",
    "## Evidence",
    input.evidence,
    "",
    'Answer with JSON only: {"items":[{"id":"a1","pass":false,"why":"one line naming what is wrong or what shows it is met"}]} — one entry per item to rule on.',
  ].join("\n");
}

/** Per-item verdicts from the judge's answer; `null` when it cannot be read at all. */
export function parseJudgeAnswer(
  content: string,
): Map<string, { pass: boolean; why: string }> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const out = new Map<string, { pass: boolean; why: string }>();
  for (const entry of items) {
    if (entry === null || typeof entry !== "object") continue;
    const { id, pass, why } = entry as Record<string, unknown>;
    // Only a literal `true` passes: "yes", 1 or a missing field do not.
    if (typeof id !== "string") continue;
    out.set(id, {
      pass: pass === true,
      why: typeof why === "string" && why.trim().length > 0 ? why.trim() : "no reason given",
    });
  }
  return out;
}

export interface JudgeTarget {
  providerId: string;
  model: string | null;
}

/**
 * Rule on one task's list. Never throws; a judge that cannot run or
 * answer leaves the task unverified, which is not green.
 */
export async function judgeTask(input: {
  task: DelegateTask;
  items: readonly AcceptanceItem[];
  facts: JudgeFacts;
  reply: string;
  contract: DelegateContract | undefined;
  workingDir: string;
  target: JudgeTarget;
  pricing: WorkerPricing | undefined;
  complete: EscalationComplete;
  signal: AbortSignal;
}): Promise<JudgeVerdict> {
  const factVerdicts: ItemVerdict[] = [];
  for (const item of input.items) {
    const verdict = await factVerdict(item, input.facts, input.workingDir);
    if (verdict !== undefined) factVerdicts.push(verdict);
  }
  const needsJudge = input.items.filter(
    (item) => !factVerdicts.some((fact) => fact.id === item.id),
  );
  // A red fact makes the list red whatever the judge would say, so the
  // judge is not paid to say it; its items are listed as not judged.
  if (needsJudge.length === 0 || factVerdicts.some((v) => !v.pass)) {
    const skipped = needsJudge.map(
      (item): ItemVerdict => ({
        id: item.id,
        pass: false,
        why: "not judged: a scripted item is already red",
        by: "skipped",
      }),
    );
    return {
      green: factVerdicts.every((v) => v.pass) && skipped.length === 0,
      items: [...factVerdicts, ...skipped].sort(
        (a, b) => itemOrder(a.id) - itemOrder(b.id),
      ),
      costUsd: null,
    };
  }
  const evidence = await gatherEvidence(
    input.task,
    input.contract,
    input.reply,
    input.workingDir,
  );
  let content: string;
  let costUsd: number | null = null;
  try {
    const answer = await input.complete({
      providerId: input.target.providerId,
      prompt: renderJudgePrompt({
        task: input.task,
        items: input.items,
        facts: factVerdicts,
        evidence,
      }),
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      signal: input.signal,
    });
    content = answer.content;
    if (input.pricing !== undefined && answer.usage !== undefined) {
      costUsd = estimateUsageCostUsd(answer.usage, input.pricing);
    }
  } catch (err) {
    return {
      green: false,
      items: factVerdicts,
      unverified: `the judge could not run: ${err instanceof Error ? err.message : String(err)}`,
      costUsd,
    };
  }
  const ruled = parseJudgeAnswer(content);
  if (ruled === null) {
    return {
      green: false,
      items: factVerdicts,
      unverified: "the judge's answer could not be read",
      costUsd,
    };
  }
  const judged = needsJudge.map((item): ItemVerdict => {
    const verdict = ruled.get(item.id);
    return verdict === undefined
      ? { id: item.id, pass: false, why: "the judge gave no verdict", by: "judge" }
      : { id: item.id, ...verdict, by: "judge" };
  });
  const all = [...factVerdicts, ...judged].sort(
    (a, b) => itemOrder(a.id) - itemOrder(b.id),
  );
  return { green: all.every((v) => v.pass), items: all, costUsd };
}

function itemOrder(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

/** The items found not met; a skipped item is not a finding. */
export function redItems(verdict: JudgeVerdict): ItemVerdict[] {
  return verdict.items.filter((v) => !v.pass && v.by !== "skipped");
}

/** The findings a retried worker is briefed with. */
export function renderRetryFindings(
  items: readonly AcceptanceItem[],
  verdict: JudgeVerdict,
): string {
  return [
    "## A judge found these acceptance items NOT met in your previous attempt",
    ...redItems(verdict).map((v) => {
      const item = items.find((i) => i.id === v.id);
      return `- [${v.id}] ${item?.text ?? ""} — ${v.why}`;
    }),
    "Fix exactly these. The files from the previous attempt are on disk; change them rather than starting over.",
  ].join("\n");
}

export interface JudgeSummary {
  green: boolean;
  total: number;
  failed: number;
  retried: boolean;
  unverified?: string;
  costUsd: number | null;
  items: ItemVerdict[];
}

/** Fold a verdict into the task's row: a node closes only on a green list. */
export function applyJudgeVerdict(
  result: WorkerTaskResult,
  verdict: JudgeVerdict,
  retried: boolean,
): WorkerTaskResult {
  const red = redItems(verdict);
  const summary: JudgeSummary = {
    green: verdict.green,
    total: verdict.items.length,
    failed: red.length,
    retried,
    ...(verdict.unverified === undefined ? {} : { unverified: verdict.unverified }),
    costUsd: verdict.costUsd,
    items: verdict.items,
  };
  const after = retried ? " after one retry" : "";
  if (verdict.unverified !== undefined) {
    return {
      ...result,
      status: "needs_orchestrator",
      judge: summary,
      notes: [
        ...(result.notes ?? []),
        `judge: not verified${after} — ${verdict.unverified}; the task stays open`,
      ],
    };
  }
  if (verdict.green) {
    return {
      ...result,
      judge: summary,
      notes: [
        ...(result.notes ?? []),
        `judge: all ${verdict.items.length} acceptance items green${after}`,
      ],
    };
  }
  const detail = red.map((v) => `${v.id} ${v.why}`).join("; ");
  const skipped = verdict.items.length - verdict.items.filter((v) => v.by !== "skipped").length;
  const error = `judge: ${red.length} of ${verdict.items.length} acceptance items not met${after} — ${detail}${skipped > 0 ? ` (${skipped} not judged)` : ""}`;
  return {
    ...result,
    status: "failed",
    judge: summary,
    error: result.error === undefined ? error : `${error}; ${result.error}`,
  };
}
