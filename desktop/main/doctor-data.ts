/* ATO-577 / ATO-579 — Settings › Diagnostics' Doctor and Data rows.

   Doctor runs `atag doctor --json` (and `--fix --json`) and hands the window
   the findings: {check, status: ok|warn|fail, message, fix?}. A fix that
   changed config.json restarts the agent so it reads it, unless a turn runs.

   Data runs `atag data backup|restore|move|reset`. The folder is shared with
   the terminal agent (~/.atomic-agent), so every step that replaces it asks
   first in a system dialog that says so. Restore, move and reset stop this
   app's agent and its model server, run, and start them again; nothing is
   deleted (the CLI keeps the old folder aside and says where). Not while the
   app runs on another computer's agent: these are that computer's files. */

import type { BrowserWindow, Dialog, IpcMain, MessageBoxOptions } from "electron";
import { join } from "node:path";

import type { CliResult } from "./agent-cli.js";

export interface DoctorFindingWire {
  check: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface DoctorDataDeps {
  ipcMain: Pick<IpcMain, "handle">;
  dialog: Pick<Dialog, "showSaveDialog" | "showOpenDialog" | "showMessageBox">;
  window: () => BrowserWindow | null;
  stateDir: string;
  run: (args: string[], timeoutMs: number) => Promise<CliResult>;
  stopModels: () => Promise<unknown>;
  stopAgent: () => Promise<unknown>;
  startAgent: () => Promise<unknown>;
  turnsInFlight: () => number;
  isRemote: () => boolean;
  today?: () => string;
}

export const SHARED_FOLDER_WARNING =
  "The terminal agent (atag) uses the same folder, so this changes it there too. Close any atag running in a terminal first.";
const REMOTE_REFUSAL = "This app runs on an agent on another computer; its data is on that computer (atag data … there).";
const LONG = 30 * 60_000;

/** The findings `atag doctor --json` printed, or null when stdout is not that. */
export function parseDoctorJson(stdout: string): DoctorFindingWire[] | null {
  try {
    const v = JSON.parse(stdout) as unknown;
    if (!Array.isArray(v)) return null;
    return v.filter((f): f is DoctorFindingWire =>
      !!f && typeof f === "object" && typeof (f as DoctorFindingWire).check === "string"
      && ["ok", "warn", "fail"].includes((f as DoctorFindingWire).status) && typeof (f as DoctorFindingWire).message === "string");
  } catch {
    return null;
  }
}

/** The CLI's own words: its last stdout line, else stderr, else the error. */
function said(res: CliResult): string {
  const lines = (res.stdout || res.stderr || res.error || "").trim().split("\n").filter(Boolean);
  return lines.length ? lines.slice(-2).join(" ") : "it did not say why";
}

export function registerDoctorDataIpc(d: DoctorDataDeps): void {
  const box = async (opts: MessageBoxOptions): Promise<number> => {
    const w = d.window();
    return (w ? await d.dialog.showMessageBox(w, opts) : await d.dialog.showMessageBox(opts)).response;
  };
  const confirm = async (message: string, detail: string, button: string): Promise<boolean> =>
    (await box({ type: "warning", message, detail: `${detail}\n\n${SHARED_FOLDER_WARNING}`, buttons: [button, "Cancel"], defaultId: 1, cancelId: 1 })) === 0;

  /** Stop the agent and its model server, run, start them again: the start happens whatever the run said. */
  const offline = async (args: string[]): Promise<CliResult> => {
    await d.stopAgent();
    await d.stopModels();
    try {
      return await d.run(args, LONG);
    } finally {
      await d.startAgent();
    }
  };

  d.ipcMain.handle("doctor:run", async (_e, fix: unknown) => {
    if (d.isRemote()) return { ok: false, error: REMOTE_REFUSAL };
    const res = await d.run(fix === true ? ["doctor", "--fix", "--json"] : ["doctor", "--json"], 60_000);
    const findings = parseDoctorJson(res.stdout);
    if (!findings) return { ok: false, error: `atag doctor did not answer: ${said(res)}` };
    let restarted = false;
    if (fix === true && /backed up config\.json/.test(res.stderr) && d.turnsInFlight() === 0) {
      await d.stopAgent();
      await d.startAgent();
      restarted = true;
    }
    return { ok: true, findings, restarted };
  });

  d.ipcMain.handle("data:backup", async () => {
    if (d.isRemote()) return { ok: false, error: REMOTE_REFUSAL };
    const w = d.window();
    const opts = { defaultPath: `atomic-agent-backup-${(d.today ?? (() => new Date().toISOString().slice(0, 10)))()}.tar.gz`, filters: [{ name: "Backup", extensions: ["gz"] }] };
    const picked = w ? await d.dialog.showSaveDialog(w, opts) : await d.dialog.showSaveDialog(opts);
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    const res = await d.run(["data", "backup", picked.filePath], LONG);
    return res.ok ? { ok: true, message: said(res), file: picked.filePath } : { ok: false, error: said(res) };
  });

  d.ipcMain.handle("data:restore", async () => {
    if (d.isRemote()) return { ok: false, error: REMOTE_REFUSAL };
    const w = d.window();
    const opts = { properties: ["openFile" as const], filters: [{ name: "Backup", extensions: ["gz", "tgz"] }] };
    const picked = w ? await d.dialog.showOpenDialog(w, opts) : await d.dialog.showOpenDialog(opts);
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return { ok: false, cancelled: true };
    if (!(await confirm("Restore this backup?", `Chats, memory, tasks and settings in ${d.stateDir} are replaced by the backup. The current folder is kept next to it, not deleted. Downloaded models stay.`, "Restore"))) {
      return { ok: false, cancelled: true };
    }
    const res = await offline(["data", "restore", file, "--yes"]);
    return res.ok ? { ok: true, message: said(res) } : { ok: false, error: said(res) };
  });

  d.ipcMain.handle("data:move", async () => {
    if (d.isRemote()) return { ok: false, error: REMOTE_REFUSAL };
    const w = d.window();
    const opts = { title: "Move the data folder into…", properties: ["openDirectory" as const, "createDirectory" as const] };
    const picked = w ? await d.dialog.showOpenDialog(w, opts) : await d.dialog.showOpenDialog(opts);
    const parent = picked.filePaths[0];
    if (picked.canceled || !parent) return { ok: false, cancelled: true };
    const target = join(parent, "atomic-agent");
    if (!(await confirm("Move the data folder?", `Everything in ${d.stateDir} (models included) moves to ${target}. ${d.stateDir} becomes a link to it, so nothing else changes.`, "Move"))) {
      return { ok: false, cancelled: true };
    }
    const res = await offline(["data", "move", target]);
    return res.ok ? { ok: true, message: said(res) } : { ok: false, error: said(res) };
  });

  d.ipcMain.handle("data:reset", async () => {
    if (d.isRemote()) return { ok: false, error: REMOTE_REFUSAL };
    if (!(await confirm("Reset Atomic Agent?", `Chats, memory, tasks, skills and settings (API keys included) start fresh. Downloaded models stay. The old data is moved next to ${d.stateDir}, not deleted.`, "Reset"))) {
      return { ok: false, cancelled: true };
    }
    const res = await offline(["data", "reset", "--keep-models", "--yes"]);
    return res.ok ? { ok: true, message: said(res) } : { ok: false, error: said(res) };
  });
}
