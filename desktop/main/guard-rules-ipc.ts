/**
 * ATO-2529: Settings › Privacy › Security rules (renderer/security-settings.js).
 *
 *   app:guardRules       {ok, exists, ruleLines, path} of <stateDir>/guard.md
 *   app:guardRulesOpen   create the file when it is missing, then open it
 *
 * The window names nothing: the path is always the agent's own state
 * folder (DESKTOP_STATE_DIR) plus `guard.md`, the file the agent reads
 * (src/approval/guard-rules.ts getGuardPath). The file is created with
 * `wx`, so one that is there is never written over, and with no rule
 * text: the agent turns the rules on only when text follows the
 * frontmatter, so creating the file changes nothing until the person
 * writes a rule. It opens through the same opener as every other file
 * (openWithoutRunning), so a guard.md that is a link to a script is shown
 * in the file manager, not run.
 */

import { ipcMain } from "electron";

import { ensureGuardFile, guardRulesState } from "./guard-rules-file.js";

type Opener = (path: string) => Promise<{ ok: boolean; revealed?: boolean; error?: string }>;

export function wireGuardRulesIpc(open: Opener): void {
  ipcMain.handle("app:guardRules", async () => guardRulesState());
  ipcMain.handle("app:guardRulesOpen", async () => {
    try {
      const { path, created } = await ensureGuardFile();
      const opened = await open(path);
      return { ...opened, path, created };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
