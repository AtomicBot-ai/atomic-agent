import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readPluginBundle } from "./plugin-bundle.js";
import {
  installedPluginDir,
  pluginsRoot,
  readPluginState,
  updatePluginRecord,
  writePluginState,
  type InstalledPluginRecord,
  type PluginSourceRecord,
} from "./plugin-store.js";
import type { PluginBundle } from "./plugin-types.js";

export class PluginInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInstallError";
  }
}

/** Never copied: VCS data, dependency trees and OS junk. */
export const SKIP_NAMES: ReadonlySet<string> = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".venv"]);
export const MAX_FILES = 5000;

/** A copied, parsed plugin waiting for the caller to scan it and confirm. */
export interface StagedPlugin {
  dir: string;
  bundle: PluginBundle;
}

/**
 * Copy `srcDir` into a private staging folder and parse it there, so what
 * gets checked is exactly what gets installed. Symlinks are dropped: a link
 * could point at `~/.ssh` and be read later as plugin content.
 */
export function stagePluginCopy(stateDir: string, srcDir: string): StagedPlugin {
  const src = resolve(srcDir);
  if (!existsSync(src) || !lstatSync(src).isDirectory()) throw new PluginInstallError(`not a folder: ${src}`);
  const stagingRoot = join(pluginsRoot(stateDir), "staging");
  mkdirSync(stagingRoot, { recursive: true });
  // The last segment keeps the source folder name: a manifest-less plugin is named after it.
  const holder = join(stagingRoot, randomBytes(4).toString("hex"));
  const dir = join(holder, basename(src));
  let files = 0;
  try {
    cpSync(src, dir, {
      recursive: true,
      dereference: false,
      filter: (from) => {
        const name = basename(from);
        if (from !== src && SKIP_NAMES.has(name)) return false;
        const st = lstatSync(from);
        if (st.isSymbolicLink()) return false;
        if (st.isFile() && ++files > MAX_FILES) throw new PluginInstallError(`plugin has more than ${MAX_FILES} files`);
        return true;
      },
    });
    return { dir, bundle: readPluginBundle(dir) };
  } catch (err) {
    rmSync(holder, { recursive: true, force: true });
    throw err instanceof PluginInstallError ? err : new PluginInstallError(err instanceof Error ? err.message : String(err));
  }
}

export function discardStagedPlugin(staged: StagedPlugin): void {
  rmSync(dirname(staged.dir), { recursive: true, force: true });
}

export interface CommitPluginOptions {
  source: PluginSourceRecord;
  /** Replace an installed plugin of the same name (update / reinstall). */
  force?: boolean;
  /** Keep the plugin installed but switched off (e.g. waiting for consent). */
  enabled?: boolean;
  runsCodeAccepted?: boolean;
}

/** Move a staged plugin into place and record it. The old copy is kept until the new one is in. */
export function commitStagedPlugin(stateDir: string, staged: StagedPlugin, options: CommitPluginOptions): InstalledPluginRecord {
  const name = staged.bundle.name;
  const state = readPluginState(stateDir);
  const previous = state.plugins[name];
  const target = installedPluginDir(stateDir, name);
  if (previous && !options.force) {
    discardStagedPlugin(staged);
    throw new PluginInstallError(`plugin ${name} is already installed; use --force to replace it`);
  }
  mkdirSync(join(pluginsRoot(stateDir), "installed"), { recursive: true });
  const backup = existsSync(target) ? `${target}.old-${randomBytes(3).toString("hex")}` : null;
  if (backup) renameSync(target, backup);
  try {
    renameSync(staged.dir, target);
  } catch (err) {
    if (backup) renameSync(backup, target);
    throw new PluginInstallError(`could not move plugin into place: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (backup) rmSync(backup, { recursive: true, force: true });
  rmSync(dirname(staged.dir), { recursive: true, force: true });
  const now = new Date().toISOString();
  const record: InstalledPluginRecord = {
    name,
    version: staged.bundle.manifest.version,
    enabled: options.enabled ?? previous?.enabled ?? true,
    source: options.source,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    // Consent is per install: an update that runs code must be agreed to again
    // (the permission diff in ATO-955 decides when to ask).
    ...(options.runsCodeAccepted !== undefined ? { runsCodeAccepted: options.runsCodeAccepted } : {}),
    ...(previous?.disabledParts?.length ? { disabledParts: previous.disabledParts } : {}),
  };
  state.plugins[name] = record;
  writePluginState(stateDir, state);
  return record;
}

/** What the review step learns about the install it is looking at. */
export interface PluginReviewContext {
  mode: "install" | "update";
  source: PluginSourceRecord;
  /** The record being replaced (update or `--force`), if any. */
  previous?: InstalledPluginRecord;
  /** The installed copy being replaced, parsed before the swap; null when unreadable. */
  previousBundle?: PluginBundle | null;
}

/** What the review step decided; fields left out keep commit defaults. */
export interface PluginReviewDecision {
  enabled?: boolean;
  runsCodeAccepted?: boolean;
}

/**
 * Looks at a staged plugin before it is moved into place: the security
 * scan, the permission diff and the runs-code question plug in here.
 * Throwing cancels the install and the staged copy is deleted.
 */
export type PluginReview = (staged: StagedPlugin, context: PluginReviewContext) => Promise<PluginReviewDecision | void>;

export interface ReviewAndCommitOptions {
  mode: "install" | "update";
  source: PluginSourceRecord;
  force?: boolean;
  review?: PluginReview;
}

/** Run the review on a staged plugin, then commit it, or discard it when the review says no. */
export async function reviewAndCommit(stateDir: string, staged: StagedPlugin, options: ReviewAndCommitOptions): Promise<InstalledPluginRecord> {
  const name = staged.bundle.name;
  const previous = readPluginState(stateDir).plugins[name];
  if (previous && !options.force && options.mode === "install") {
    discardStagedPlugin(staged);
    throw new PluginInstallError(`plugin ${name} is already installed; use --force to replace it or \`plugin update ${name}\``);
  }
  let decision: PluginReviewDecision | void = undefined;
  if (options.review) {
    let previousBundle: PluginBundle | null | undefined;
    if (previous) {
      try { previousBundle = readPluginBundle(installedPluginDir(stateDir, name)); } catch { previousBundle = null; }
    }
    try {
      decision = await options.review(staged, { mode: options.mode, source: options.source, previous, previousBundle });
    } catch (err) {
      discardStagedPlugin(staged);
      throw err;
    }
  }
  return commitStagedPlugin(stateDir, staged, {
    source: options.source,
    force: options.force || options.mode === "update",
    ...(decision?.enabled !== undefined ? { enabled: decision.enabled } : {}),
    ...(decision?.runsCodeAccepted !== undefined ? { runsCodeAccepted: decision.runsCodeAccepted } : {}),
  });
}

/** Copy + record in one go, for a local folder. Callers that scan use stage/commit instead. */
export function installPluginFromDir(stateDir: string, srcDir: string, options: { force?: boolean; acceptCode?: boolean } = {}): InstalledPluginRecord {
  const staged = stagePluginCopy(stateDir, srcDir);
  return commitStagedPlugin(stateDir, staged, {
    source: { kind: "local", path: resolve(srcDir) },
    force: options.force,
    ...(options.acceptCode ? { runsCodeAccepted: true } : {}),
  });
}

/** Whether the code-running parts of an installed plugin (stdio MCP, hooks, scripts) may run. */
export function pluginCodeAllowed(rec: InstalledPluginRecord): boolean {
  return rec.runsCodeAccepted === true;
}

export function removePlugin(stateDir: string, name: string): boolean {
  const state = readPluginState(stateDir);
  if (!state.plugins[name]) return false;
  delete state.plugins[name];
  writePluginState(stateDir, state);
  rmSync(installedPluginDir(stateDir, name), { recursive: true, force: true });
  return true;
}

export function setPluginEnabled(stateDir: string, name: string, enabled: boolean): boolean {
  const state = readPluginState(stateDir);
  const rec = state.plugins[name];
  if (!rec) return false;
  state.plugins[name] = { ...rec, enabled, updatedAt: new Date().toISOString() };
  writePluginState(stateDir, state);
  return true;
}

/** Switch one part of a plugin on or off: `skill:<name>`, `mcp:<name>`, `hook:<event>`, `command:<name>`. */
export function setPluginPartEnabled(stateDir: string, name: string, part: string, enabled: boolean): boolean {
  const state = readPluginState(stateDir);
  const rec = state.plugins[name];
  if (!rec) return false;
  const parts = new Set(rec.disabledParts ?? []);
  if (enabled) parts.delete(part); else parts.add(part);
  state.plugins[name] = { ...rec, disabledParts: [...parts].sort(), updatedAt: new Date().toISOString() };
  writePluginState(stateDir, state);
  return true;
}

/**
 * Allow or stop a plugin's code-running parts (local MCP servers, hooks,
 * skill scripts). The one writer behind `plugin allow-code` / `deny-code`,
 * the terminal `/plugins` panel and the desktop Plugins screen.
 */
export function setPluginCodeAllowed(stateDir: string, name: string, allow: boolean): boolean {
  return updatePluginRecord(stateDir, name, r => ({ ...r, runsCodeAccepted: allow })) !== null;
}
