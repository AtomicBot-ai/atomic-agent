import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isCuratableSkillName } from "../curator/skill-curator-config.js";
import { newLearnedId, type LearnedAction } from "./learned-journal.js";

/**
 * Learned skills waiting for the owner's yes (ATO-67, decided 18.11): a
 * turn that read outside content (a web page, an MCP answer, an email, an
 * HTTP body) or came from a chat channel or a plain HTTP caller is still
 * reviewed, but what the review wants to save is held here instead of in
 * the live skills folder. `/learn approve <id>` writes it the way an
 * auto-save does, `/learn discard <id>` deletes it.
 *
 * Drafts live in `<stateDir>/skills-pending/<id>/` (a `SKILL.md` and a
 * `draft.json`), next to `skills-history/` and `skills-archive/` and
 * outside the loaded skills tree, so the skill loader never sees them and
 * the model is never offered one. Claude Code holds a project's MCP
 * servers the same way until the user approves them; OpenClaw's skill
 * workshop keeps proposals for review in its "approval" mode.
 */

export const PENDING_DRAFT_LIMIT = 20;

export interface PendingDraft {
  /** Short id the owner types; reused as the learned id once approved. */
  id: string;
  kind: LearnedAction;
  /** Skill folder name: the new skill, or the one a patch rewrites. */
  name: string;
  /** The review's one-line reason. */
  reason: string;
  /** Outside sources the turn read (the approval gate's taint labels). */
  sources: string[];
  /** Where the turn came from (`telegram`, `http`, ...). */
  origin?: string;
  /** Epoch ms. */
  createdAt: number;
  sessionId?: string;
  /** sha256 of the target SKILL.md when the draft was made (patch only). */
  targetHash?: string;
}

export const PENDING_ID_PATTERN = /^[0-9a-f]{4,16}$/;

export function pendingDraftsDir(stateDir: string): string {
  return join(stateDir, "skills-pending");
}

export function hashSkillText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseDraft(raw: string, folder: string): PendingDraft | null {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.id !== folder || typeof obj.id !== "string" || !PENDING_ID_PATTERN.test(obj.id)) return null;
  if (obj.kind !== "create" && obj.kind !== "patch") return null;
  if (typeof obj.name !== "string" || !isCuratableSkillName(obj.name)) return null;
  if (typeof obj.createdAt !== "number") return null;
  if (obj.kind === "patch" && typeof obj.targetHash !== "string") return null;
  return {
    id: obj.id,
    kind: obj.kind,
    name: obj.name,
    reason: typeof obj.reason === "string" ? obj.reason : "",
    sources: Array.isArray(obj.sources) ? obj.sources.filter((s): s is string => typeof s === "string").slice(0, 20) : [],
    createdAt: obj.createdAt,
    ...(typeof obj.origin === "string" ? { origin: obj.origin } : {}),
    ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
    ...(typeof obj.targetHash === "string" ? { targetHash: obj.targetHash } : {}),
  };
}

/** One draft and its SKILL.md text; `null` when absent or unreadable. */
export async function readPendingDraft(stateDir: string, id: string): Promise<{ draft: PendingDraft; content: string } | null> {
  if (!PENDING_ID_PATTERN.test(id)) return null;
  const dir = join(pendingDraftsDir(stateDir), id);
  try {
    const draft = parseDraft(await readFile(join(dir, "draft.json"), "utf8"), id);
    if (draft === null) return null;
    return { draft, content: await readFile(join(dir, "SKILL.md"), "utf8") };
  } catch {
    return null;
  }
}

/** Every readable draft, oldest first. */
export async function listPendingDrafts(stateDir: string): Promise<PendingDraft[]> {
  let names: string[];
  try {
    names = (await readdir(pendingDraftsDir(stateDir), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: PendingDraft[] = [];
  for (const name of names) {
    if (!PENDING_ID_PATTERN.test(name)) continue;
    try {
      const draft = parseDraft(await readFile(join(pendingDraftsDir(stateDir), name, "draft.json"), "utf8"), name);
      if (draft) out.push(draft);
    } catch {
      // half-written or foreign folder: not listed
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Delete one draft; false when there was none with that id. */
export async function removePendingDraft(stateDir: string, id: string): Promise<boolean> {
  if (!PENDING_ID_PATTERN.test(id)) return false;
  if ((await readPendingDraft(stateDir, id)) === null) return false;
  await rm(join(pendingDraftsDir(stateDir), id), { recursive: true, force: true });
  return true;
}

export interface SavePendingDraftInput {
  kind: LearnedAction;
  name: string;
  reason: string;
  content: string;
  sources: readonly string[];
  origin?: string;
  sessionId?: string;
  targetHash?: string;
  /** Ids already in use (the learned journal), so an approved draft keeps its id. */
  usedIds?: ReadonlySet<string>;
  now?: () => number;
  limit?: number;
}

/**
 * Store a draft, then drop the oldest ones past the cap so drafts from a
 * busy channel cannot pile up. The caller has already run the linter and
 * the security scan.
 */
export async function savePendingDraft(stateDir: string, input: SavePendingDraftInput): Promise<PendingDraft> {
  const now = input.now ?? Date.now;
  const root = pendingDraftsDir(stateDir);
  const existing = new Set((await listPendingDrafts(stateDir)).map((d) => d.id));
  let id = newLearnedId();
  while (existing.has(id) || input.usedIds?.has(id)) id = newLearnedId();
  const draft: PendingDraft = {
    id,
    kind: input.kind,
    name: input.name,
    reason: input.reason,
    sources: [...input.sources].slice(0, 20),
    createdAt: now(),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.targetHash !== undefined ? { targetHash: input.targetHash } : {}),
  };
  // Written under a temporary name and renamed, so a listing never sees half a draft.
  const tmp = join(root, `.tmp-${id}-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  await writeFile(join(tmp, "SKILL.md"), input.content, "utf8");
  await writeFile(join(tmp, "draft.json"), `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  await rename(tmp, join(root, id));

  const limit = input.limit ?? PENDING_DRAFT_LIMIT;
  const all = await listPendingDrafts(stateDir);
  for (const old of all.slice(0, Math.max(0, all.length - limit))) {
    await rm(join(root, old.id), { recursive: true, force: true });
  }
  return draft;
}
