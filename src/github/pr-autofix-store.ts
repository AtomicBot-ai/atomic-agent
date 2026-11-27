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

const fileLocks = new Map<string, Promise<unknown>>();

/** One read-modify-write at a time per state file, in arrival order. */
function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.catch(() => undefined);
  fileLocks.set(file, tail);
  void tail.then(() => {
    if (fileLocks.get(file) === tail) fileLocks.delete(file);
  });
  return result;
}

/** Parse `owner/name#number` back into its parts; null for anything else. */
export function parseAutofixKey(key: string): { slug: string; number: number } | null {
  const m = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(key);
  if (!m) return null;
  const number = Number(m[2]);
  return Number.isSafeInteger(number) && number > 0 ? { slug: m[1]!, number } : null;
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
    await this.update(key, () => state);
  }

  /**
   * Read, change and write one PR's state as one step (ATO-2516): the
   * tool (counter, opt-in) and the background watcher (its `watch`
   * bookkeeping) write the same file, and a write built on a stale read
   * must not undo the other's. Serialised per file in this process;
   * `mutate` returning undefined leaves the entry as it is.
   */
  async update(
    key: string,
    mutate: (current: AutofixState | undefined) => AutofixState | undefined,
  ): Promise<AutofixState | undefined> {
    return withFileLock(this.file, async () => {
      const all = await this.readAll();
      const next = mutate(all[key]);
      if (next === undefined) return all[key];
      all[key] = next;
      await mkdir(join(this.file, ".."), { recursive: true });
      const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
      await rename(tmp, this.file);
      return next;
    });
  }

  /** Every PR's state, keyed `owner/name#number`. */
  async all(): Promise<Record<string, AutofixState>> {
    return this.readAll();
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
