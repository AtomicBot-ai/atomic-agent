import { useCallback, useRef } from "react";
import { useClipboardReader } from "../clipboard/clipboard-context.js";
import {
  openContextMenu,
  useContextMenuHandle,
} from "../context-menu/context-menu-context.js";
import { useMouseCommands } from "../mouse/mouse-context.js";
import { plainKey } from "../mouse/synthetic-key.js";
import { deleteSelection, insertText, type EditContext } from "./multi-line-editor-edits.js";

/**
 * The editor's clipboard-read side: the paste routine (shared by the
 * Ctrl+V/Cmd+V chord and the right-click menu — one implementation) and
 * the right-press opener for the context menu. Split from
 * `multi-line-editor.tsx` for the size budget, colocated because these
 * are the component's own handlers over its own private state.
 *
 * Everything is read through a deps ref refreshed each render: the menu
 * runs its verbs from a click that arrives frames after it opened, and
 * paste resolves a promise later still — closures frozen at open time
 * would edit a buffer that no longer exists.
 */
export interface EditorClipboardDeps {
  readonly disabled: boolean;
  readonly hasSelection: boolean;
  /** This render's buffer/caret/selection plus the setters. `key` is
   * supplied here (a paste burst carries none), so the component hands
   * over exactly what it has. */
  readonly edit: Omit<EditContext, "key">;
  /** The editor's own copy — the one Ctrl+C uses, notices included. */
  readonly copySelection: () => void;
}

export interface EditorClipboard {
  /** Paste the system clipboard at the caret / over the selection. */
  readonly pasteClipboard: () => void;
  /** Open the context menu at an absolute screen cell. */
  readonly openMenuAt: (cell: { x: number; y: number }) => boolean;
}

export function useEditorClipboard(deps: EditorClipboardDeps): EditorClipboard {
  const reader = useClipboardReader();
  const mouse = useMouseCommands();
  const handle = useContextMenuHandle();
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const liveEdit = (): EditContext => ({
    key: plainKey(),
    ...depsRef.current.edit,
  });

  const pasteClipboard = useCallback(() => {
    void readerRef.current.read().then((text) => {
      if (text.length === 0 || depsRef.current.disabled) return;
      // `insertText` is the same routine typing uses: it sanitises the
      // burst and replaces the selection, so paste-over-selection works
      // exactly like type-over-selection.
      insertText(liveEdit(), text);
    });
  }, []);

  const openMenuAt = useCallback(
    (cell: { x: number; y: number }): boolean => {
      const current = depsRef.current;
      // No mouse layer or no provider (component tests, the setup
      // wizard's separate Ink tree): decline the press rather than
      // open a menu nothing can render.
      if (current.disabled || !mouse || !handle) return false;
      return openContextMenu(handle, mouse, {
        menu: {
          x: cell.x,
          y: cell.y,
          target: { kind: "editor", hasSelection: current.hasSelection },
        },
        actions: {
          copy: () => {
            depsRef.current.copySelection();
            // Match the Ctrl+C chord: a completed copy collapses the
            // selection so the next keystroke types, not replaces.
            depsRef.current.edit.setAnchor(null);
          },
          cut: () => {
            // Copy first, then remove — the same order and the same
            // helpers as the Ctrl+X chord, so cut can never mean
            // something different by mouse than by keyboard.
            depsRef.current.copySelection();
            deleteSelection(liveEdit());
          },
          paste: pasteClipboard,
        },
      });
    },
    [mouse, handle, pasteClipboard],
  );

  return { pasteClipboard, openMenuAt };
}
