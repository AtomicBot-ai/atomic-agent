import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { saveShowOnceDraft, showOnceDraftJson } from "./show-once-draft.js";
import { isShowOnceAction, type ShowOnceStep } from "./show-once-log.js";
import { compileShowOnceSkill, showOnceApps, showOnceStepLines } from "./show-once-skill.js";
import type { ShowOnceSnapshots } from "./show-once-snapshots.js";
import { SHOW_ONCE_TIDY_LIMITS, SHOW_ONCE_TIDY_SYSTEM, parseShowOnceTidy, showOnceTidyPrompt } from "./show-once-tidy.js";
import type { AgentCompleteAnswer } from "./studio-improve-prompt.js";

/**
 * ATO-2401 / ATO-2499 "Show once": what Stop does with a recording, kept
 * out of show-once-ipc.ts (the routes, the listener, the menu bar item).
 *
 *   saveRecording → the draft as recorded, at once, into the agent's
 *                   `skills-pending/<id>/` (show-once-draft.ts), with the
 *                   step pictures when they were on (show-once-snapshots.ts)
 *   tidyDraft     → then, when the switch is on, one pass of the chat model
 *                   (show-once-tidy.ts) rewrites that draft's title,
 *                   description, summary and what to ask for. On any
 *                   failure the draft stays as recorded and the card says so.
 *
 * A draft approved or discarded while the model thinks is left alone: the
 * rewrite only replaces files in a folder that is still there.
 */

export type CompleteFn = (body: { prompt: string; system: string; max_tokens: number }) => Promise<AgentCompleteAnswer>;

export type RecordingSaved =
  | { kind: "empty" }
  | { kind: "saved"; id: string; dir: string; name: string; steps: number; pictures: number };

export async function saveRecording(
  stateDir: string,
  steps: readonly ShowOnceStep[],
  recordedAt: Date,
  shots: ShowOnceSnapshots | null,
): Promise<RecordingSaved> {
  const skill = compileShowOnceSkill(steps, recordedAt);
  if (!skill) {
    await shots?.discard();
    return { kind: "empty" };
  }
  let saved;
  try {
    saved = await saveShowOnceDraft(stateDir, { name: skill.name, reason: skill.description, content: skill.content });
  } catch (err) {
    await shots?.discard();
    throw err;
  }
  const pictures = shots ? await shots.moveInto(saved.dir, steps.length) : 0;
  return { kind: "saved", id: saved.id, dir: saved.dir, name: skill.name, steps: steps.filter(isShowOnceAction).length, pictures };
}

export const TIDY_UNSUPPORTED = "This version of the agent cannot tidy drafts, so the draft is saved as recorded.";
export const TIDY_FAILED = "The chat model could not tidy the draft, so it is saved as recorded.";

async function replace(file: string, text: string): Promise<void> {
  const tmp = `${file}.tidy-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/** One tidy pass over a saved draft. `{ok:false, error}` is a line for the card, never a throw. */
export async function tidyDraft(
  complete: CompleteFn,
  saved: { id: string; dir: string },
  steps: readonly ShowOnceStep[],
  recordedAt: Date,
  log: (line: string) => void,
): Promise<{ ok: true } | { ok: false; error: string; gone?: boolean }> {
  const prompt = showOnceTidyPrompt(showOnceApps(steps), showOnceStepLines(steps));
  let answer: AgentCompleteAnswer;
  try {
    answer = await complete({ prompt, system: SHOW_ONCE_TIDY_SYSTEM, max_tokens: SHOW_ONCE_TIDY_LIMITS.maxTokens });
  } catch {
    answer = { supported: false };
  }
  if (!answer.supported) return { ok: false, error: TIDY_UNSUPPORTED };
  if (!answer.ok) {
    log(`[desktop] show once: tidy failed: ${answer.status} ${answer.error}`);
    return { ok: false, error: TIDY_FAILED };
  }
  const tidy = parseShowOnceTidy(answer.text);
  const skill = tidy ? compileShowOnceSkill(steps, recordedAt, tidy) : null;
  if (!tidy || !skill) {
    log("[desktop] show once: tidy answer was not the JSON asked for");
    return { ok: false, error: TIDY_FAILED };
  }
  const draftFile = join(saved.dir, "draft.json");
  try {
    await stat(draftFile);
  } catch {
    return { ok: false, error: "", gone: true }; // approved or discarded meanwhile
  }
  try {
    const before = JSON.parse(await readFile(draftFile, "utf8")) as { createdAt?: unknown };
    const createdAt = typeof before.createdAt === "number" ? before.createdAt : Date.now();
    await replace(join(saved.dir, "SKILL.md"), skill.content);
    await replace(draftFile, showOnceDraftJson(saved.id, skill.name, skill.description, createdAt));
    return { ok: true };
  } catch (err) {
    log(`[desktop] show once: could not write the tidied draft: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: TIDY_FAILED };
  }
}
