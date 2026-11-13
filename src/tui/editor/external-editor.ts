/**
 * Open the composer draft in the operator's own editor (ATO-655).
 *
 * Long prompts are easier to write in vim, nano or VS Code than in a
 * terminal text box, so `/edit` (and `ctrl+g E`) writes the draft to a
 * temp file, hands the terminal to `$VISUAL` / `$EDITOR`, and reads the
 * file back once the editor exits.
 *
 * The editor is run synchronously with the terminal inherited. While it
 * runs, Node's event loop is blocked, so nothing (Ink included) reads
 * stdin or paints over the editor; `terminal` is what releases raw mode,
 * mouse reporting and the alt screen around the call and restores them.
 *
 * Everything with a side effect comes in through {@link ExternalEditorDeps}
 * so the round trip can be tested with a fake editor.
 */
import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Which editor to run, as the operator spelled it. */
export interface EditorChoice {
  /** The command line from the variable, e.g. `code --wait`. */
  readonly command: string;
  readonly source: "VISUAL" | "EDITOR" | "fallback";
}

/** How to start the editor on one file. */
export interface EditorInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export type ExternalEditResult =
  | { readonly kind: "edited"; readonly text: string; readonly editor: string }
  | { readonly kind: "unchanged"; readonly editor: string }
  | { readonly kind: "no-editor" }
  | { readonly kind: "failed"; readonly message: string };

/** Pauses the TUI's hold on the terminal while the editor owns it. */
export interface TerminalHandover {
  suspend(): void;
  resume(): void;
}

export type SpawnEditor = (
  file: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => Pick<SpawnSyncReturns<Buffer>, "status" | "signal" | "error">;

export interface ExternalEditorDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Parent directory for the temp file, normally `os.tmpdir()`. */
  readonly tmpDir: string;
  readonly spawn: SpawnEditor;
  readonly terminal: TerminalHandover;
}

/**
 * `$VISUAL` first, then `$EDITOR`, the order git and most CLIs use.
 * Windows always has Notepad, so it is the fallback there; elsewhere
 * there is no editor every system is sure to have, and the caller says
 * how to set one.
 */
export function resolveEditor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): EditorChoice | null {
  const visual = env.VISUAL?.trim();
  if (visual) return { command: visual, source: "VISUAL" };
  const editor = env.EDITOR?.trim();
  if (editor) return { command: editor, source: "EDITOR" };
  if (platform === "win32") return { command: "notepad", source: "fallback" };
  return null;
}

/**
 * The variable can carry arguments (`code --wait`, `emacs -nw`), so it
 * goes through a shell, as git does with `$EDITOR`. On POSIX the path is
 * passed as `$1`, never spliced into the command text, so no quoting of
 * the path is needed. On Windows `cmd` has no such channel, but the path
 * is ours (under the temp dir, no quotes in it), so plain quoting holds.
 */
export function buildEditorInvocation(
  editor: EditorChoice,
  path: string,
  platform: NodeJS.Platform,
): EditorInvocation {
  if (platform === "win32") {
    return { file: `${editor.command} "${path}"`, args: [], shell: true };
  }
  return {
    file: "/bin/sh",
    args: ["-c", `${editor.command} "$@"`, "sh", path],
    shell: false,
  };
}

/**
 * What an editor saved, as a composer draft. Editors add a final newline
 * on save and Notepad writes CRLF and sometimes a BOM; none of that is
 * part of the prompt.
 */
export function normalizeEditedText(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "");
}

/** `sh` exits 127 and `cmd` 9009 when the command itself is not found. */
function isCommandNotFound(status: number | null): boolean {
  return status === 127 || status === 9009;
}

function describeExit(
  editor: string,
  outcome: Pick<SpawnSyncReturns<Buffer>, "status" | "signal" | "error">,
): string | null {
  if (outcome.error) {
    return `could not start the editor (${editor}): ${outcome.error.message}`;
  }
  if (isCommandNotFound(outcome.status)) {
    return `editor not found: ${editor}. Set VISUAL or EDITOR to an installed editor`;
  }
  if (outcome.signal) {
    return `the editor (${editor}) was stopped by ${outcome.signal}; the prompt is unchanged`;
  }
  if (outcome.status !== 0) {
    return `the editor (${editor}) exited with code ${String(outcome.status)}; the prompt is unchanged`;
  }
  return null;
}

/** Run `fn` with the terminal handed over, taking it back even on a throw. */
function whileSuspended<T>(terminal: TerminalHandover, fn: () => T): T {
  terminal.suspend();
  try {
    return fn();
  } finally {
    terminal.resume();
  }
}

/**
 * Round-trip `draft` through the operator's editor. Never throws: every
 * failure becomes a result the caller can show.
 */
export function editInExternalEditor(
  draft: string,
  deps: ExternalEditorDeps,
): ExternalEditResult {
  const editor = resolveEditor(deps.env, deps.platform);
  if (!editor) return { kind: "no-editor" };
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(deps.tmpDir, "atomic-agent-edit-"));
    // `.md` so editors pick a prose mode with soft wrap and highlighting.
    const path = join(dir, "prompt.md");
    writeFileSync(path, draft, { encoding: "utf8", mode: 0o600 });
    const invocation = buildEditorInvocation(editor, path, deps.platform);
    const outcome = whileSuspended(deps.terminal, () =>
      deps.spawn(invocation.file, invocation.args, {
        stdio: "inherit",
        shell: invocation.shell,
        env: deps.env,
      }),
    );
    const failure = describeExit(editor.command, outcome);
    if (failure) return { kind: "failed", message: failure };
    const edited = normalizeEditedText(readFileSync(path, "utf8"));
    if (edited === normalizeEditedText(draft)) {
      return { kind: "unchanged", editor: editor.command };
    }
    return { kind: "edited", text: edited, editor: editor.command };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "failed", message: `external editor failed: ${msg}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** The real process, file system and temp dir, around `terminal`. */
export function defaultExternalEditorDeps(
  terminal: TerminalHandover,
): ExternalEditorDeps {
  return {
    env: process.env,
    platform: process.platform,
    tmpDir: tmpdir(),
    spawn: (file, args, options) => spawnSync(file, [...args], options),
    terminal,
  };
}
