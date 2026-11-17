/**
 * ATO-606 — the route behind Settings › Models' "Worker reasoning" and
 * `/runmode reasoning <level>` (renderer/fusion-reasoning.js).
 *
 *   cli:fusionWorkerReasoning  "low" | "medium" | "high" | "default"
 *
 * One hold of the config lock: read, plan (fusion-reasoning.ts), write with
 * `--expect-sha256`; a write that lost to the terminal or another window is
 * read and planned again (agent-cli.ts withConfigRetries, ATO-416). The agent
 * reads the level from its cached config, so the window says it applies
 * after Restart Agent Runtime; nothing restarts from here.
 */

import { ipcMain } from "electron";

import { CONFIG_CHANGED_ELSEWHERE, rewriteWholeConfig } from "./agent-cli.js";
import { parseWorkerReasoningChoice, planWorkerReasoning, type WorkerReasoningLevel } from "./fusion-reasoning.js";

export type WorkerReasoningAnswer =
  | { ok: true; changed: boolean; level: WorkerReasoningLevel | null }
  | { ok: false; error: string; refusal?: string };

export async function setFusionWorkerReasoning(choice: unknown): Promise<WorkerReasoningAnswer> {
  const parsed = parseWorkerReasoningChoice(choice);
  if (parsed === null) return { ok: false, error: "the level must be low, medium, high or default" };
  const res = await rewriteWholeConfig((cfg) => planWorkerReasoning(cfg, parsed));
  const v = res.verdict;
  if (v?.refusal) return { ok: false, error: v.refusal, refusal: v.refusal };
  if (!res.ok) return { ok: false, error: res.error ?? CONFIG_CHANGED_ELSEWHERE };
  return { ok: true, changed: res.changed, level: v ? v.after : null };
}

export function wireFusionReasoningIpc(): void {
  ipcMain.handle("cli:fusionWorkerReasoning", (_event, choice: unknown) => setFusionWorkerReasoning(choice));
}
