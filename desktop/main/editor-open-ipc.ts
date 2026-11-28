/**
 * ATO-2445: "Open in editor" from the preview panel.
 *
 *   app:editors()                              → [{ id, name }]
 *   app:openInEditor(path, id, line?, col?)    → { ok: true } | { ok: false, reason }
 *
 * The path goes through the preview's own check (file-preview.ts
 * previewTarget: the same roots, links resolved) and the editor through
 * editor-detect.ts, so the window can open only a file the panel may read,
 * in one of the editors found, never a program it names. The editor is
 * started on its own (detached, no shell), with the arguments as a list,
 * and without this app's Electron and Node variables in its environment.
 * The list is looked up again after 30 s, so an editor installed meanwhile
 * shows up without a restart.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { ipcMain } from "electron";

import { detectEditors, editorArgs, editorEnv, readEditorId, type Editor } from "./editor-detect.js";
import { previewTarget } from "./file-preview.js";

const FRESH_MS = 30_000;

/** Starts `ed` on `args`; resolves once it started or failed to. */
export function launchEditor(ed: Editor, args: string[]): Promise<{ ok: true } | { ok: false; reason: "failed" }> {
  return new Promise((done) => {
    try {
      const child = spawn(ed.command, args, { detached: true, stdio: "ignore", windowsHide: false, env: editorEnv(process.env) });
      child.once("error", () => done({ ok: false, reason: "failed" }));
      child.once("spawn", () => { child.unref(); done({ ok: true }); });
    } catch {
      done({ ok: false, reason: "failed" });
    }
  });
}

export function wireEditorOpenIpc(deps: { previewRoots(): string[] }): void {
  let cache: { at: number; list: Editor[] } | null = null;
  const editors = (): Editor[] => {
    if (!cache || Date.now() - cache.at > FRESH_MS) {
      cache = { at: Date.now(), list: detectEditors({ platform: process.platform, home: homedir(), env: process.env }) };
    }
    return cache.list;
  };
  ipcMain.handle("app:editors", () => editors().map(({ id, name }) => ({ id, name })));
  ipcMain.handle("app:openInEditor", async (_event, p: unknown, rawId: unknown, line: unknown, col: unknown) => {
    const id = readEditorId(rawId);
    const ed = id ? editors().find((e) => e.id === id) : undefined;
    if (!ed) return { ok: false, reason: "no-editor" };
    const t = await previewTarget(p, deps.previewRoots(), homedir(), process.platform);
    if (!t.ok) return { ok: false, reason: t.reason };
    const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1e7 ? v : undefined);
    return launchEditor(ed, editorArgs(ed.id, t.real, n(line), n(col)));
  });
}
