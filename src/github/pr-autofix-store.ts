/**
 * Durable autofix state per pull request (ATO-2331):
 * `<stateDir>/pr-autofix/state.json`, keyed `owner/name#number`.
 *
 * A separate state file rather than a config field: the opt-in is a
 * per-PR runtime fact, not a setting, and a scheduled run (its own
 * session) must see the same attempt counter as the chat that enabled
 * it. Written whole through a temp file and a rename, so a crash
 * mid-write leaves the previous state, never half a file.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AutofixState } from "./pr-autofix-guard.js";

export const AUTOFIX_DIR = "pr-autofix";

export function autofixKey(slug: string, number: number): string {
  return `${slug.toLowerCase()}#${number}`;
}

/** The state file; on the trust list in config-file.ts (`trust_config` write, `state_secret` read). */
export function autofixStatePath(stateDir: string): string {
  return join(stateDir, AUTOFIX_DIR, "state.json");
}

/** Where autofix worktrees are made: one folder per PR, beside the state file. */
export function autofixWorktreeDir(stateDir: string, slug: string, number: number): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return join(stateDir, AUTOFIX_DIR, "worktrees", `${safe}-${number}`);
}

export class AutofixStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = autofixStatePath(stateDir);
  }

  async get(key: string): Promise<AutofixState | undefined> {
    return (await this.readAll())[key];
  }

  async set(key: string, state: AutofixState): Promise<void> {
    const all = await this.readAll();
    all[key] = state;
    await mkdir(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await rename(tmp, this.file);
  }

  private async readAll(): Promise<Record<string, AutofixState>> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, AutofixState>)
        : {};
    } catch {
      // A corrupt file reads as "autofix off everywhere": the safe side.
      return {};
    }
  }
}
