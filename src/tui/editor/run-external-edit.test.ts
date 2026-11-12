import { describe, expect, it, vi } from "vitest";
import type { TuiAction } from "../tui-action.js";
import type { ExternalEditResult } from "./external-editor.js";
import {
  EDIT_BUSY_NOTICE,
  EDIT_NO_EDITOR_NOTICE,
  EDIT_UNAVAILABLE_NOTICE,
  runExternalEdit,
} from "./run-external-edit.js";

function run(
  inputValue: string,
  result: ExternalEditResult | null,
  options: { text?: string; status?: string } = {},
) {
  const actions: TuiAction[] = [];
  const onExternalEditorRequested = vi.fn<(draft: string) => ExternalEditResult>(
    () => result ?? { kind: "no-editor" },
  );
  runExternalEdit(
    options.text === undefined ? {} : { text: options.text },
    { inputValue, status: options.status ?? "idle" },
    (action) => actions.push(action),
    result === null ? {} : { onExternalEditorRequested },
  );
  return { actions, onExternalEditorRequested };
}

describe("runExternalEdit", () => {
  it("hands the draft over and puts the saved text in the composer", () => {
    const { actions, onExternalEditorRequested } = run("draft", {
      kind: "edited",
      text: "draft, but longer",
      editor: "vim",
    });
    expect(onExternalEditorRequested).toHaveBeenCalledWith("draft");
    expect(actions[0]).toEqual({ type: "input_changed", value: "draft, but longer" });
    expect(actions[1]).toMatchObject({ type: "system_message" });
  });

  it("starts from /edit <text> when given", () => {
    const { onExternalEditorRequested } = run("/edit hello", { kind: "unchanged", editor: "vim" }, { text: "hello" });
    expect(onExternalEditorRequested).toHaveBeenCalledWith("hello");
  });

  it("clears the typed command when nothing was saved", () => {
    const { actions, onExternalEditorRequested } = run("/edit", { kind: "unchanged", editor: "vim" });
    expect(onExternalEditorRequested).toHaveBeenCalledWith("");
    expect(actions).toContainEqual({ type: "input_changed", value: "" });
    expect(actions).toContainEqual({ type: "system_message", text: "closed vim: the prompt is unchanged" });
  });

  it("keeps the draft and warns when no editor is set", () => {
    const { actions } = run("keep me", { kind: "no-editor" });
    expect(actions).toEqual([
      { type: "input_changed", value: "keep me" },
      { type: "system_message", text: EDIT_NO_EDITOR_NOTICE, variant: "warn" },
    ]);
  });

  it("keeps the draft and shows the failure", () => {
    const { actions } = run("keep me", { kind: "failed", message: "editor not found: nvim" });
    expect(actions).toContainEqual({ type: "input_changed", value: "keep me" });
    expect(actions).toContainEqual({ type: "system_message", text: "editor not found: nvim", variant: "warn" });
  });

  it("refuses during a running turn without opening anything", () => {
    const { actions, onExternalEditorRequested } = run("draft", { kind: "unchanged", editor: "vim" }, { status: "running" });
    expect(onExternalEditorRequested).not.toHaveBeenCalled();
    expect(actions).toContainEqual({ type: "system_message", text: EDIT_BUSY_NOTICE });
  });

  it("says so when the host cannot open an editor", () => {
    const { actions } = run("draft", null);
    expect(actions).toContainEqual({ type: "system_message", text: EDIT_UNAVAILABLE_NOTICE });
  });
});
