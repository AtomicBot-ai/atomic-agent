import { replacementText, type SourceApp } from "./replace-selection.js";

/**
 * ATO-2738: what the mini chat shows before "Replace in …" pastes
 * anything: the selected text as it was, and the answer exactly as the
 * paste will send it (replacementText: line ends, the model's lead-in,
 * fence and quotes taken off). Microsoft Copilot's rewrite and Apple's
 * Writing Tools show the same before / after before a replace.
 * Pure, for the node tests.
 */

export type ReplacePreview =
  | { ok: true; before: string; after: string; same: boolean }
  | { ok: false; error: string };

export function replacePreview(selection: string | null, source: SourceApp | null, raw: unknown): ReplacePreview {
  if (source && source.blocked) return { ok: false, error: source.blocked };
  const after = replacementText(raw, selection);
  if (!after) return { ok: false, error: "There is no answer to put back." };
  const before = typeof selection === "string" ? selection.replace(/\r\n/g, "\n").trim() : "";
  return { ok: true, before, after, same: before === after };
}
