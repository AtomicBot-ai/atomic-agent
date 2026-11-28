/**
 * ATO-2445: which code editors this computer has, for the preview's
 * "Open in editor" (editor-open-ipc.ts runs them).
 *
 * VS Code, Cursor and Zed, found on PATH or where their installers put them:
 *
 *   macOS    each app's own command-line tool inside its bundle in
 *            /Applications or ~/Applications, else `code` / `cursor` / `zed`
 *            on PATH plus /usr/local/bin, /opt/homebrew/bin and ~/.local/bin
 *            (an app started from the Dock gets a short PATH);
 *   Windows  the editor's own .exe under %LOCALAPPDATA%\Programs or
 *            %ProgramFiles%, or the .exe next to the `code.cmd` /
 *            `cursor.cmd` on PATH. A .cmd needs a shell to run, so it is
 *            never run itself; `zed.exe` on PATH is an .exe and runs as is;
 *   Linux    `code` / `cursor` / `zed` / `zeditor` on PATH, /usr/share/code,
 *            /snap/bin, /opt/cursor, ~/.local/bin.
 *
 * The line: VS Code and Cursor take `-g file:line[:col]`, Zed `file:line[:col]`.
 *
 * Pure but for the existence checks, which the caller can replace: no
 * Electron import, so the unit suite loads it from `out/main`.
 */

import { accessSync, constants, statSync } from "node:fs";

import { pathFor, type Platform } from "./platform.js";

export type EditorId = "vscode" | "cursor" | "zed";
export type Editor = { id: EditorId; name: string; command: string };

export const EDITOR_NAMES: Record<EditorId, string> = { vscode: "VS Code", cursor: "Cursor", zed: "Zed" };
const ORDER: EditorId[] = ["vscode", "cursor", "zed"];

export type DetectEnv = {
  platform: Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** The file is there and may be run. */
  runnable?: (p: string) => boolean;
};

function defaultRunnable(platform: Platform): (p: string) => boolean {
  return (p) => {
    try {
      if (!statSync(p).isFile()) return false;
      if (platform !== "win32") accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/** The folders PATH names, plus the usual ones a Dock-started app on macOS misses. */
export function searchDirs(e: DetectEnv): string[] {
  const P = pathFor(e.platform);
  const raw = e.env.PATH ?? e.env.Path ?? "";
  const dirs = raw.split(e.platform === "win32" ? ";" : ":").filter(Boolean);
  if (e.platform === "darwin") dirs.push("/usr/local/bin", "/opt/homebrew/bin", P.join(e.home, ".local", "bin"));
  if (e.platform === "linux") dirs.push("/usr/local/bin", "/usr/bin", "/snap/bin", P.join(e.home, ".local", "bin"));
  return [...new Set(dirs)];
}

/** Every place an editor may be, best first. */
export function editorCandidates(id: EditorId, e: DetectEnv): string[] {
  const P = pathFor(e.platform);
  const onPath = (names: string[]): string[] => searchDirs(e).flatMap((d) => names.map((n) => P.join(d, n)));
  if (e.platform === "darwin") {
    const app = { vscode: "Visual Studio Code.app", cursor: "Cursor.app", zed: "Zed.app" }[id];
    const tool = { vscode: "Contents/Resources/app/bin/code", cursor: "Contents/Resources/app/bin/cursor", zed: "Contents/MacOS/cli" }[id];
    return [
      P.join("/Applications", app, tool), P.join(e.home, "Applications", app, tool),
      ...onPath(id === "vscode" ? ["code"] : id === "cursor" ? ["cursor"] : ["zed"]),
    ];
  }
  if (e.platform === "win32") {
    const local = e.env.LOCALAPPDATA || P.join(e.home, "AppData", "Local");
    const programs = [e.env.ProgramFiles, e.env["ProgramFiles(x86)"]].filter((x): x is string => !!x);
    if (id === "vscode") {
      return [
        P.join(local, "Programs", "Microsoft VS Code", "Code.exe"),
        ...programs.map((p) => P.join(p, "Microsoft VS Code", "Code.exe")),
        // …\Microsoft VS Code\bin\code.cmd on PATH: Code.exe is one folder up.
        ...onPath(["code.cmd"]).map((c) => P.join(P.dirname(P.dirname(c)), "Code.exe")),
      ];
    }
    if (id === "cursor") {
      return [
        P.join(local, "Programs", "cursor", "Cursor.exe"),
        ...programs.map((p) => P.join(p, "Cursor", "Cursor.exe")),
        // …\cursor\resources\app\bin\cursor.cmd on PATH: Cursor.exe is three folders up.
        ...onPath(["cursor.cmd"]).map((c) => P.join(P.dirname(P.dirname(P.dirname(P.dirname(c)))), "Cursor.exe")),
      ];
    }
    return [P.join(local, "Programs", "Zed", "Zed.exe"), ...programs.map((p) => P.join(p, "Zed", "Zed.exe")), ...onPath(["zed.exe"])];
  }
  if (id === "vscode") return [...onPath(["code"]), "/usr/share/code/bin/code", "/snap/bin/code"];
  if (id === "cursor") return [...onPath(["cursor"]), "/opt/cursor/cursor", "/usr/share/cursor/cursor"];
  return [...onPath(["zed", "zeditor"]), P.join(e.home, ".local", "zed.app", "bin", "zed")];
}

/** The editors found, in the order VS Code, Cursor, Zed. */
export function detectEditors(e: DetectEnv): Editor[] {
  const runnable = e.runnable ?? defaultRunnable(e.platform);
  const out: Editor[] = [];
  for (const id of ORDER) {
    const command = editorCandidates(id, e).find((c) => runnable(c));
    if (command) out.push({ id, name: EDITOR_NAMES[id], command });
  }
  return out;
}

/** The arguments that open `file` (an absolute path) at `line`/`col` when given. */
export function editorArgs(id: EditorId, file: string, line?: number, col?: number): string[] {
  const l = Number.isInteger(line) && (line as number) > 0 ? (line as number) : 0;
  const c = l && Number.isInteger(col) && (col as number) > 0 ? (col as number) : 0;
  const at = l ? `${file}:${l}${c ? `:${c}` : ""}` : file;
  if (id === "zed") return [at];
  return l ? ["-g", at] : [file];
}

const DROPPED_ENV = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_ENABLE_LOGGING", "NODE_OPTIONS", "NODE_PATH"];

/** This app's environment without the variables that would make the editor start as a bare Node. */
export function editorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of DROPPED_ENV) delete out[k];
  return out;
}

/** An editor id the window sent, or null. */
export function readEditorId(raw: unknown): EditorId | null {
  return raw === "vscode" || raw === "cursor" || raw === "zed" ? raw : null;
}
