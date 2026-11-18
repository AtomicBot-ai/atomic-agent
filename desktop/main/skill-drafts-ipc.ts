import { ipcMain } from "electron";

import { atagRun, plainCliError } from "./agent-cli.js";
import {
  SKILL_DRAFT_ID_RE,
  parseSkillDraftShow,
  parseSkillDrafts,
  skillDraftActionArgs,
  skillDraftListArgs,
  skillDraftShowArgs,
  type SkillDraftDetail,
  type SkillDraftRow,
} from "./skill-drafts-cli.js";

/**
 * ATO-67: Settings › Skills › "Pending review" (skill-drafts-cli.ts says what
 * the agent prints). Four routes:
 *
 *   cli:skillDrafts        → `{ok, rows}`: the drafts waiting for the person (empty on an older agent)
 *   cli:skillDraftShow     → `{ok, draft}`: one draft's SKILL.md, diff and sources
 *   cli:skillDraftApprove  → `atag skill learned approve <id>`
 *   cli:skillDraftDiscard  → `atag skill learned discard <id>`
 *
 * Drafts live in the agent's state folder on this computer, so while the app
 * runs chats on another computer the list is empty here. Nothing throws at the window.
 */

type Deps = { cwd: () => string | undefined; isRemote: () => boolean };

export async function skillDrafts(cwd?: string): Promise<{ ok: true; rows: SkillDraftRow[] }> {
  const res = await atagRun(skillDraftListArgs(), 45_000, cwd);
  // An older agent: `--json` unknown, or its plain listing. Either way, no drafts and no error.
  return { ok: true, rows: res.ok ? parseSkillDrafts(res.stdout) : [] };
}

export async function skillDraftShow(id: string, cwd?: string): Promise<{ ok: boolean; draft?: SkillDraftDetail; error?: string }> {
  if (!SKILL_DRAFT_ID_RE.test(id)) return { ok: false, error: `not a draft id: ${id}` };
  const res = await atagRun(skillDraftShowArgs(id), 30_000, cwd);
  const draft = parseSkillDraftShow(res.stdout);
  if (draft) return { ok: true, draft };
  return { ok: false, error: plainCliError(res.stderr) || res.error || "The agent did not show this draft." };
}

async function skillDraftAction(action: "approve" | "discard", id: string, cwd?: string): Promise<{ ok: boolean; error?: string }> {
  if (!SKILL_DRAFT_ID_RE.test(id)) return { ok: false, error: `not a draft id: ${id}` };
  const res = await atagRun(skillDraftActionArgs(action, id), 30_000, cwd);
  if (res.ok) return { ok: true };
  return { ok: false, error: plainCliError(res.stderr) || res.stdout.trim() || res.error || `Could not ${action} the draft.` };
}
export const skillDraftApprove = (id: string, cwd?: string) => skillDraftAction("approve", id, cwd);
export const skillDraftDiscard = (id: string, cwd?: string) => skillDraftAction("discard", id, cwd);

const REMOTE = "Learned drafts are reviewed on the computer that runs the agent.";

export function wireSkillDraftsIpc(deps: Deps): void {
  const guard = async <T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> => {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const idOf = (v: unknown): string | null => (typeof v === "string" && SKILL_DRAFT_ID_RE.test(v) ? v : null);

  ipcMain.handle("cli:skillDrafts", () =>
    deps.isRemote() ? { ok: true, rows: [] } : guard(() => skillDrafts(deps.cwd())));
  ipcMain.handle("cli:skillDraftShow", (_event, id: unknown) => {
    const clean = idOf(id);
    if (!clean) return { ok: false, error: "draft id required" };
    return deps.isRemote() ? { ok: false, error: REMOTE } : guard(() => skillDraftShow(clean, deps.cwd()));
  });
  ipcMain.handle("cli:skillDraftApprove", (_event, id: unknown) => {
    const clean = idOf(id);
    if (!clean) return { ok: false, error: "draft id required" };
    return deps.isRemote() ? { ok: false, error: REMOTE } : guard(() => skillDraftApprove(clean, deps.cwd()));
  });
  ipcMain.handle("cli:skillDraftDiscard", (_event, id: unknown) => {
    const clean = idOf(id);
    if (!clean) return { ok: false, error: "draft id required" };
    return deps.isRemote() ? { ok: false, error: REMOTE } : guard(() => skillDraftDiscard(clean, deps.cwd()));
  });
}
