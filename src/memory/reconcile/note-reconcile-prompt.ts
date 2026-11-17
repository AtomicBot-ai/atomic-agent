/**
 * ATO-672. Micro-prompt for the note-reconcile sub-call: one new note,
 * a few older notes that share words with it, and the question the
 * mem0 update step asks (ADD / UPDATE / DELETE / NOOP), folded into what
 * an append-only note store can do:
 *
 *   - ADD    → NONE: every note stays.
 *   - UPDATE / DELETE → SUPERSEDE <id>: the older note is outdated (the
 *     user changed job, city, preference). Note content is never
 *     rewritten, so an update is "the new note replaces the old one".
 *   - NOOP   → DUPLICATE <id>: the new note adds nothing to <id>.
 */
export interface NoteReconcilePromptInput {
  newNote: string;
  candidates: ReadonlyArray<{ id: number; body: string }>;
}

const NOTE_CHARS = 400;
const CANDIDATE_CHARS = 240;

export function buildNoteReconcilePrompt(input: NoteReconcilePromptInput): string {
  const candidateBlock = input.candidates
    .map((c) => `[${c.id}] ${clip(c.body, CANDIDATE_CHARS)}`)
    .join("\n");
  return [
    "A new memory note about the user was just saved. Compare it with the older notes below.",
    "For each older note that the new note makes outdated (it says the opposite, or gives",
    "newer information about the same thing: a new job, city, tool or preference), output:",
    "  SUPERSEDE <id>",
    "If the new note only repeats one older note and adds nothing, output:",
    "  DUPLICATE <id>",
    "If the notes are about different things, or can all be true at once, output NONE.",
    "When unsure, output NONE. Use only the ids shown in [brackets].",
    "",
    "new-note:",
    clip(input.newNote, NOTE_CHARS),
    "",
    "older-notes:",
    candidateBlock.length > 0 ? candidateBlock : "(none)",
    "",
    "decision:",
  ].join("\n");
}

function clip(raw: string, max: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
