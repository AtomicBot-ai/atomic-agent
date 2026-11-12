import { existsSync } from "node:fs";
import { app, ipcMain } from "electron";

import { atagRun, plainCliError, skillShow } from "./agent-cli.js";
import {
  SKILL_EVAL_NAME_RE,
  parseSkillEvalOutput,
  skillEvalArgs,
  skillEvalSupported,
  skillEvalTasksFile,
} from "./skill-eval-cli.js";

/**
 * ATO-1102: the "Test skill" button on a skill card (skill-eval-cli.ts says
 * what it runs and when it shows). Three routes:
 *
 *   cli:skillEvalProbe  → may this skill be tested here? `{ok, available, tasksFile?}`
 *   cli:skillEvalRun    → `atag skill eval <name> --tasks <file> --json`, one run at a time
 *   cli:skillEvalCancel → stops the run in flight (the run answers `{ok:false, cancelled:true}`)
 *
 * The task file is found here again on every run: the window only names the skill.
 * Nothing throws at the window.
 */

const HELP_TTL_MS = 5 * 60_000;
/** A task set runs every task twice through the agent; a long one takes a while. */
const RUN_TIMEOUT_MS = 60 * 60_000;

let help: { at: number; supported: boolean } | null = null;
let running: { name: string; controller: AbortController } | null = null;

async function evalSupported(): Promise<boolean> {
  if (help && Date.now() - help.at < HELP_TTL_MS) return help.supported;
  const res = await atagRun(["skill", "--help"], 30_000);
  if (!res.ok) return false; // not cached: the agent may simply be busy starting
  help = { at: Date.now(), supported: skillEvalSupported(`${res.stdout}\n${res.stderr}`) };
  return help.supported;
}

type Probe = { ok: true; available: false; reason: "agent" | "tasks" } | { ok: true; available: true; tasksFile: string };

async function probe(name: string, cwd: string | undefined): Promise<Probe> {
  if (!(await evalSupported())) return { ok: true, available: false, reason: "agent" };
  const shown = await skillShow(name, cwd);
  const tasksFile = shown.ok && shown.path ? skillEvalTasksFile(shown.path, existsSync) : null;
  return tasksFile ? { ok: true, available: true, tasksFile } : { ok: true, available: false, reason: "tasks" };
}

export function wireSkillEvalIpc(deps: { cwd: () => string | undefined }): void {
  ipcMain.handle("cli:skillEvalProbe", async (_event, name: unknown) => {
    if (typeof name !== "string" || !SKILL_EVAL_NAME_RE.test(name)) return { ok: false, error: "skill name required" };
    try {
      return await probe(name, deps.cwd());
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("cli:skillEvalRun", async (_event, name: unknown) => {
    if (typeof name !== "string" || !SKILL_EVAL_NAME_RE.test(name)) return { ok: false, error: "skill name required" };
    if (running) return { ok: false, error: `A test of ${running.name} is already running.` };
    const controller = new AbortController();
    running = { name, controller };
    try {
      const cwd = deps.cwd();
      const found = await probe(name, cwd);
      if (!found.available) {
        return { ok: false, error: found.reason === "agent" ? "This agent cannot test skills yet. Update Atomic Agent." : "This skill has no tasks.yaml next to its SKILL.md." };
      }
      if (controller.signal.aborted) return { ok: false, cancelled: true, error: "Test stopped." };
      const res = await atagRun(skillEvalArgs(name, found.tasksFile), RUN_TIMEOUT_MS, cwd, controller.signal);
      if (controller.signal.aborted) return { ok: false, cancelled: true, error: "Test stopped." };
      // `skill eval` exits 1 when it stopped before the plan finished but still prints what ran; show it then.
      const parsed = parseSkillEvalOutput(res.stdout, name, res.stderr);
      if (parsed.ok || res.ok) return parsed;
      return { ok: false, error: plainCliError(res.stderr) || res.error || "The test did not finish." };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (running && running.controller === controller) running = null;
    }
  });

  // A test still running when the app quits is stopped, not left behind as a stray agent process.
  app.on("will-quit", () => running?.controller.abort());

  ipcMain.handle("cli:skillEvalCancel", () => {
    if (!running) return { ok: true, stopped: false };
    running.controller.abort();
    return { ok: true, stopped: true };
  });
}
