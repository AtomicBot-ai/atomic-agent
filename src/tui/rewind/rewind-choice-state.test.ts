import { describe, expect, it } from "vitest";
import { resolveBackdropDismissal } from "../backdrop-dismissal.js";
import { apply, fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type RewindChoiceFacts, type TuiState } from "../tui-state.js";
import type { RewindPoint } from "../../session/session-rewind.js";
import { rewindChoiceFacts, rewindChoiceNotes, rewindDoneText } from "./rewind-messages.js";

const points: RewindPoint[] = [
  { turnIndex: 6, text: "third", at: 3, ordinal: 3 },
  { turnIndex: 2, text: "second", at: 2, ordinal: 2 },
];
const withFiles: RewindChoiceFacts = { fileCount: 2, notRestorableCount: 0, incomplete: false, uncoveredCount: 0 };
const noFiles: RewindChoiceFacts = { fileCount: 0, notRestorableCount: 0, incomplete: false, uncoveredCount: 0 };

function picked(): TuiState {
  return apply(createInitialTuiState(fakeSession()), [
    { type: "rewind_picker_opened", points },
    { type: "rewind_choice_requested", point: points[1]! },
  ]);
}

describe("rewind choice step (ATO-2467)", () => {
  it("opens on a pick with no choices until the files are checked", () => {
    expect(picked().rewindPicker?.choice).toEqual({ point: points[1], facts: null, options: [], cursor: 0 });
  });

  it("offers chat and files, chat only and files only when files would change", () => {
    const ready = apply(picked(), [{ type: "rewind_choice_ready", turnIndex: 2, facts: withFiles }]);
    expect(ready.rewindPicker?.choice?.options).toEqual(["all", "conversation", "files"]);
    expect(ready.rewindPicker?.choice?.cursor).toBe(0);
  });

  it("hides the file choices when that point has nothing to put back", () => {
    const ready = apply(picked(), [{ type: "rewind_choice_ready", turnIndex: 2, facts: noFiles }]);
    expect(ready.rewindPicker?.choice?.options).toEqual(["conversation"]);
    expect(rewindChoiceNotes(noFiles)[0]).toContain("No files to put back");
  });

  it("ignores an answer for another point and one that lands after Esc", () => {
    const stale = apply(picked(), [{ type: "rewind_choice_ready", turnIndex: 6, facts: withFiles }]);
    expect(stale.rewindPicker?.choice?.facts).toBeNull();
    const closed = apply(picked(), [
      { type: "rewind_picker_closed" },
      { type: "rewind_choice_ready", turnIndex: 2, facts: withFiles },
    ]);
    expect(closed.rewindPicker).toBeNull();
  });

  it("moves the choice highlight, not the list's, keyboard and mouse alike", () => {
    const ready = apply(picked(), [{ type: "rewind_choice_ready", turnIndex: 2, facts: withFiles }]);
    const down = apply(ready, [
      { type: "rewind_picker_cursor_moved", delta: 1 },
      { type: "rewind_picker_cursor_moved", delta: 1 },
      { type: "rewind_picker_cursor_moved", delta: 1 },
    ]);
    expect(down.rewindPicker?.choice?.cursor).toBe(2);
    expect(down.rewindPicker?.cursor).toBe(0);
    expect(apply(ready, [{ type: "rewind_picker_cursor_set", row: 1 }]).rewindPicker?.choice?.cursor).toBe(1);
    expect(apply(ready, [{ type: "rewind_picker_cursor_set", row: -4 }]).rewindPicker?.choice?.cursor).toBe(0);
  });

  it("closes on Esc's action and on a click outside", () => {
    expect(resolveBackdropDismissal(picked())).toEqual({ type: "rewind_picker_closed" });
  });

  it("notes what stays as it is", () => {
    const notes = rewindChoiceNotes({ fileCount: 1, notRestorableCount: 2, incomplete: true, uncoveredCount: 1 });
    expect(notes).toEqual([
      "2 files were changed without a saved copy (too large or not text) and will stay as they are.",
      "Some older file changes are no longer kept and will stay as they are.",
      "Changes made by shell commands, git, archive extraction, subagents or Fusion stay as they are.",
    ]);
  });
});

describe("rewind chat lines (ATO-2467)", () => {
  const outcome = { text: "q", state: null, restored: [] as string[], deleted: [] as string[], failed: [], notRestorable: [], incomplete: false };

  it("counts what a preview would change", () => {
    expect(
      rewindChoiceFacts({
        turnIndex: 0,
        text: "q",
        removed: { questions: 1, replies: 1 },
        files: [{ path: "/w/a", action: "restore" }, { path: "/w/b", action: "delete" }],
        notRestorable: [{ path: "/w/c", reason: "too_large" }],
        incomplete: false,
        uncovered: [{ tool: "os.shell.run", count: 2 }, { tool: "os.git.commit", count: 1 }],
      }),
    ).toEqual({ fileCount: 2, notRestorableCount: 1, incomplete: false, uncoveredCount: 3 });
  });

  it("says what was put back, by scope", () => {
    expect(rewindDoneText("all", { ...outcome, restored: ["/w/a"], deleted: ["/w/b"] })).toBe(
      "Rewound: that message and everything after it were removed from this chat, and 2 files the agent changed were put back. The message is back in the composer to edit and send.",
    );
    expect(rewindDoneText("files", { ...outcome, restored: ["/w/a"] })).toBe(
      "Put back 1 file to how it was before that message. The chat stays as it is.",
    );
    expect(rewindDoneText("conversation", outcome)).toContain("Files the agent changed were not restored.");
  });

  it("names the files it could not put back by name, never by path or error", () => {
    const text = rewindDoneText("all", {
      ...outcome,
      restored: ["/w/ok.txt"],
      failed: [
        { path: "/w/deep/one.txt", error: "EACCES: permission denied" },
        { path: "/w/two.txt", error: "EISDIR" },
      ],
    });
    expect(text).toContain("Couldn't put back 2 files (one.txt, two.txt): they were left as they are.");
    expect(text).not.toContain("EACCES");
    expect(text).not.toContain("/w/");
  });
});
