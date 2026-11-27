import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * ATO-2401 "Show once": a recorded routine is saved as a learned-skill
 * draft, the same kind the agent holds for review (ATO-67), so it shows in
 * Settings › Skills › Pending review with Show / Approve / Discard and is
 * never loaded until the person approves it.
 *
 * The folder is the agent's own (src/skills/learning/pending-drafts.ts):
 * `<stateDir>/skills-pending/<id>/SKILL.md` and `draft.json`. The desktop
 * and the terminal share `~/.atomic-agent`, so `atag skill list --json`
 * lists it and `atag skill learned approve|discard <id>` acts on it with the
 * agent's linter and security scan, unchanged. Written under a temporary
 * name and renamed, as the agent does, so a listing never sees half a draft.
 *
 * The id is 8 hex characters: the agent's pattern (4 to 16) takes it, and
 * the agent's own ids are 6, so an approved draft never reuses a learned id.
 */

export const SHOW_ONCE_ORIGIN = "show-once";
export const SHOW_ONCE_SOURCE = "show-once recording";
const ID_RE = /^[0-9a-f]{8}$/;

export function pendingDraftsRoot(stateDir: string): string {
  return join(stateDir, "skills-pending");
}

export interface ShowOnceDraftInput {
  name: string;
  reason: string;
  content: string;
  now?: () => number;
  newId?: () => string;
}

export interface ShowOnceDraftSaved {
  id: string;
  dir: string;
}

/** The draft.json the agent reads (parseDraft in pending-drafts.ts). */
export function showOnceDraftJson(id: string, name: string, reason: string, createdAt: number): string {
  const draft = { id, kind: "create", name, reason, sources: [SHOW_ONCE_SOURCE], origin: SHOW_ONCE_ORIGIN, createdAt };
  return `${JSON.stringify(draft, null, 2)}\n`;
}

export async function saveShowOnceDraft(stateDir: string, input: ShowOnceDraftInput): Promise<ShowOnceDraftSaved> {
  const now = input.now ?? Date.now;
  const newId = input.newId ?? (() => randomBytes(4).toString("hex"));
  const root = pendingDraftsRoot(stateDir);
  await mkdir(root, { recursive: true });
  let taken: Set<string>;
  try {
    taken = new Set(await readdir(root));
  } catch {
    taken = new Set();
  }
  let id = newId();
  for (let tries = 0; !ID_RE.test(id) || taken.has(id); tries++) {
    if (tries > 20) throw new Error("could not pick a draft id");
    id = newId();
  }
  const tmp = join(root, `.tmp-${id}-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  await writeFile(join(tmp, "SKILL.md"), input.content, "utf8");
  await writeFile(join(tmp, "draft.json"), showOnceDraftJson(id, input.name, input.reason, now()), "utf8");
  const dir = join(root, id);
  await rename(tmp, dir);
  return { id, dir };
}
