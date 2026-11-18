/**
 * ATO-67: skills the agent learned from a turn that read outside content
 * (a web page, a file, a tool's output) are not saved straight away. The
 * agent keeps them as drafts until the person looks at them; Settings ›
 * Skills shows them under "Pending review" with Show / Approve / Discard.
 *
 * This file is pure: the id check, the argv and the output parsing.
 * skill-drafts-ipc.ts runs the commands.
 *
 * The agent's side (src/cli/skill.ts, src/skills/learning/pending-drafts.ts):
 *  - `atag skill list --json` → an array of rows; a draft is a row with
 *    `status: "pending"`, `draftId`, `draftKind` ("create" | "patch"), its
 *    `name`, and `description` = the model's reason for the skill;
 *  - `atag skill learned show <id> --json` → the draft: its SKILL.md, the
 *    current SKILL.md and a diff for a patch, the sources it came from;
 *  - `atag skill learned approve <id>` / `discard <id>` → exit 0 when done.
 * An agent older than that answers `skill list --json` with its plain
 * tab-separated listing (or an error): no drafts, and no error on screen.
 */

/** Draft ids are short hex today (PENDING_ID_PATTERN); this is a little wider, and never a leading `-` (argv flag). */
export const SKILL_DRAFT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface SkillDraftRow {
  id: string;
  name: string;
  kind: "create" | "patch";
  /** The model's reason for the skill, as it wrote it. Plain text: the window escapes it. */
  reason: string;
}

export interface SkillDraftDetail {
  id: string;
  kind: "create" | "patch";
  skill: string;
  path: string;
  origin: string;
  sources: string[];
  reason: string;
  createdAt: number | string | null;
  skillMd: string;
  currentSkillMd: string | null;
  diff: string | null;
}

export function skillDraftListArgs(): string[] {
  return ["skill", "list", "--json"];
}
export function skillDraftShowArgs(id: string): string[] {
  return ["skill", "learned", "show", id, "--json"];
}
export function skillDraftActionArgs(action: "approve" | "discard", id: string): string[] {
  return ["skill", "learned", action, id];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The pending rows of `skill list --json`. Anything that is not a JSON array
 * (an older agent's tab-separated listing, an empty answer) is no drafts.
 */
export function parseSkillDrafts(stdout: string): SkillDraftRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SkillDraftRow[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.status !== "pending") continue;
    const id = str(r.draftId);
    if (!SKILL_DRAFT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: str(r.name) || id, kind: r.draftKind === "patch" ? "patch" : "create", reason: str(r.description) });
  }
  return out;
}

/** `skill learned show <id> --json`, or null when it is not the document. */
export function parseSkillDraftShow(stdout: string): SkillDraftDetail | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;
  const id = str(d.id);
  const skillMd = d.skillMd;
  if (!SKILL_DRAFT_ID_RE.test(id) || typeof skillMd !== "string") return null;
  return {
    id,
    kind: d.kind === "patch" ? "patch" : "create",
    skill: str(d.skill),
    path: str(d.path),
    origin: str(d.origin),
    sources: Array.isArray(d.sources) ? d.sources.filter((s): s is string => typeof s === "string") : [],
    reason: str(d.reason),
    createdAt: typeof d.createdAt === "number" || typeof d.createdAt === "string" ? d.createdAt : null,
    skillMd,
    currentSkillMd: typeof d.currentSkillMd === "string" ? d.currentSkillMd : null,
    diff: typeof d.diff === "string" ? d.diff : null,
  };
}
