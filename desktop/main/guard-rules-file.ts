/**
 * ATO-2529: the security rules file the desktop creates and reads
 * (guard-rules-ipc.ts). No electron here, so the Node checks load it
 * (test/guard-rules-file.test.mjs).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DESKTOP_STATE_DIR } from "./state-dir.js";

export const GUARD_FILE = "guard.md";

/** The starter: frontmatter only. `#` lines are not `key: value`, so the agent skips them. */
export const GUARD_STARTER = [
  "---",
  "# Your security rules. Write one rule per line BELOW the closing dashes, in plain words.",
  "# Nothing is checked until a rule is written there. For example:",
  "#   Block shell commands that print or send SSH keys, cloud credentials or any .env file.",
  "#   Block sending data anywhere except github.com and registry.npmjs.org.",
  "#   Block deleting a git branch or rewriting git history.",
  "# onFailure: what happens when the reviewer gives no answer. ask (you are asked) or block.",
  "onFailure: ask",
  "---",
  "",
].join("\n");

/** Lines of rule text after the frontmatter (guard-rules.ts parseGuardFile). */
export function guardRuleLines(text: string): number {
  const normalised = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalised);
  const rules = front === null ? normalised : normalised.slice(front[0].length);
  return rules.split("\n").filter((line) => line.trim().length > 0).length;
}

export interface GuardRulesState {
  ok: true;
  exists: boolean;
  ruleLines: number;
  path: string;
}

export async function guardRulesState(stateDir: string = DESKTOP_STATE_DIR): Promise<GuardRulesState> {
  const path = join(stateDir, GUARD_FILE);
  try {
    return { ok: true, exists: true, ruleLines: guardRuleLines(await readFile(path, "utf8")), path };
  } catch {
    return { ok: true, exists: false, ruleLines: 0, path };
  }
}

/** Creates the starter when there is no file; a file that is there is left as it is. */
export async function ensureGuardFile(stateDir: string = DESKTOP_STATE_DIR): Promise<{ path: string; created: boolean }> {
  const path = join(stateDir, GUARD_FILE);
  try {
    await writeFile(path, GUARD_STARTER, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { path, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { path, created: false };
    throw err;
  }
}

