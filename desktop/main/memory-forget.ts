/* ATO-321 — Settings › Memory › "Clear old memory".

   Test runs (E2E sessions, QA passes) leave notes and lessons in the shared
   memory that later chats recall ("The user is Alex"). The agent clears
   them by date: `atomic-agent memory forget --before <YYYY-MM-DD> [--yes]`
   (#1478, src/cli/memory-forget.ts) deletes the notes created before the
   date and deprecates the lessons created before it; profile facts are not
   touched. Without `--yes` it only counts. The desktop runs the same
   command: a check first, then the clear after the person confirms.

   IPC `cli:memoryForget` `{before, apply}` → `{ok, applied, notes, lessons, error?}`. */

import type { IpcMain } from "electron";

import type { CliResult } from "./agent-cli.js";

export interface MemoryForgetAnswer {
  ok: boolean;
  applied?: boolean;
  notes?: number;
  lessons?: number;
  error?: string;
}

/** A real calendar date as `YYYY-MM-DD`, the only shape the command takes. */
export function forgetDateOk(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/** The command's one line, as counts: "would delete N notes and deprecate M lessons …" or "deleted N notes, deprecated M lessons …". */
export function parseForgetOutput(stdout: string): { applied: boolean; notes: number; lessons: number } | null {
  const done = /deleted (\d+) notes, deprecated (\d+) lessons/.exec(stdout);
  if (done) return { applied: true, notes: Number(done[1]), lessons: Number(done[2]) };
  const dry = /would delete (\d+) notes and deprecate (\d+) lessons/.exec(stdout);
  if (dry) return { applied: false, notes: Number(dry[1]), lessons: Number(dry[2]) };
  return null;
}

export async function memoryForget(
  run: (args: string[], timeout: number) => Promise<CliResult>,
  remote: boolean,
  payload: unknown,
): Promise<MemoryForgetAnswer> {
  const { before, apply } = (payload ?? {}) as { before?: unknown; apply?: unknown };
  if (!forgetDateOk(before)) return { ok: false, error: "Pick a date." };
  if (remote) return { ok: false, error: "This app is connected to an agent on another computer: clear its memory there (atag memory forget)." };
  const res = await run(["memory", "forget", "--before", before, ...(apply === true ? ["--yes"] : [])], 120_000);
  const counts = parseForgetOutput(res.stdout || "");
  if (res.ok && counts) return { ok: true, ...counts };
  // An agent from before #1478 has no `forget`: it answers "unknown subcommand: forget".
  if (/unknown subcommand: forget/.test(res.stderr || "")) {
    return { ok: false, error: "This agent version cannot clear memory by date yet. Update the agent, then try again." };
  }
  const why = (res.stderr || "").trim().split("\n").pop() || res.error || "no reason given";
  return { ok: false, error: "Could not clear memory: " + why };
}

export function registerMemoryForgetIpc(deps: {
  ipcMain: IpcMain;
  run: (args: string[], timeout: number) => Promise<CliResult>;
  remote: () => boolean;
}): void {
  deps.ipcMain.handle("cli:memoryForget", (_event, payload: unknown) => memoryForget(deps.run, deps.remote(), payload));
}
