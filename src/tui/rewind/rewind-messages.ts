import { basename } from "node:path";
import type { RewindOutcome, RewindPreview, RewindScope } from "../../runtime/session-rewind-service.js";
import type { RewindChoiceFacts } from "../tui-state.js";

/**
 * The chat lines of the terminal's `/rewind` (ATO-1057, ATO-2467):
 * plain words, file names rather than paths, never an error message.
 */

/** What the choice box needs to know about a preview. */
export function rewindChoiceFacts(preview: RewindPreview): RewindChoiceFacts {
  return {
    fileCount: preview.files.length,
    notRestorableCount: preview.notRestorable.length,
    incomplete: preview.incomplete,
    uncoveredCount: preview.uncovered.reduce((sum, call) => sum + call.count, 0),
  };
}

/** The lines under the choices: why there is no file choice, and what stays. */
export function rewindChoiceNotes(facts: RewindChoiceFacts): string[] {
  const notes: string[] = [];
  if (facts.fileCount === 0) notes.push("No files to put back from this point, so only the chat can be rewound.");
  if (facts.notRestorableCount > 0) {
    const n = facts.notRestorableCount;
    notes.push(`${n === 1 ? "1 file was" : `${n} files were`} changed without a saved copy (too large or not text) and will stay as ${n === 1 ? "it is" : "they are"}.`);
  }
  if (facts.incomplete) notes.push("Some older file changes are no longer kept and will stay as they are.");
  if (facts.uncoveredCount > 0) {
    notes.push("Changes made by shell commands, git, archive extraction, subagents or Fusion stay as they are.");
  }
  return notes;
}

/** The line after a rewind that ran. */
export function rewindDoneText(scope: RewindScope, outcome: RewindOutcome): string {
  const putBack = outcome.restored.length + outcome.deleted.length;
  const failed = outcome.failed.length > 0;
  const lines: string[] = [];
  switch (scope) {
    case "all": {
      const filesPart =
        putBack > 0
          ? `, and ${files(putBack)} the agent changed ${putBack === 1 ? "was" : "were"} put back`
          : failed ? "" : ", and no files needed putting back";
      lines.push(
        `Rewound: that message and everything after it were removed from this chat${filesPart}. The message is back in the composer to edit and send.`,
      );
      break;
    }
    case "conversation":
      lines.push(
        "Rewound: that message and everything after it were removed from this chat. It is back in the composer to edit and send. Files the agent changed were not restored.",
      );
      break;
    case "files":
      if (putBack > 0) {
        lines.push(`Put back ${files(putBack)} to how ${putBack === 1 ? "it was" : "they were"} before that message. The chat stays as it is.`);
      } else {
        lines.push(failed ? "The chat stays as it is." : "No files needed putting back. The chat stays as it is.");
      }
      break;
  }
  if (outcome.failed.length > 0) {
    const n = outcome.failed.length;
    lines.push(
      `Couldn't put back ${files(n)} (${names(outcome.failed.map((f) => f.path))}): ${
        n === 1 ? "it was" : "they were"
      } left as ${n === 1 ? "it is" : "they are"}. Check that ${n === 1 ? "it isn't" : "they aren't"} open or read-only, then try /rewind again.`,
    );
  }
  if (outcome.notRestorable.length > 0) {
    const n = outcome.notRestorable.length;
    lines.push(`${files(n)} changed without a saved copy stayed as ${n === 1 ? "it is" : "they are"}.`);
  }
  return lines.join(" ");
}

/** The line when the rewind threw part way. */
export const REWIND_FAILED_TEXT =
  "Something went wrong during the rewind, so it may not have finished. Check the chat and your files, then try /rewind again.";

/** The line when the files could not be checked before offering the choices. */
export const REWIND_CHECK_FAILED_TEXT =
  "Couldn't check which files would change, so nothing was rewound. Try /rewind again.";

function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

function names(paths: readonly string[], max = 3): string {
  const shown = paths.slice(0, max).map((path) => basename(path));
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}
