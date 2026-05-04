import { readFile } from "node:fs/promises";
import { parseSkillFile } from "./skill-manifest.js";
import type { LoadSkillsResult, SkillRecord } from "./skill-loader.js";
import { loadSkills, type LoadSkillsOptions } from "./skill-loader.js";

export type SkillChangeListener = (registry: SkillRegistry) => void;

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`skill not installed: ${name}`);
    this.name = "SkillNotFoundError";
  }
}

/**
 * In-memory store of installed skills. The registry is rebuilt on demand
 * (sidecar startup, CLI install/uninstall) and emits a `change` event so
 * long-running sessions can refresh their stable prefix exactly once
 * instead of re-scanning the filesystem on every step.
 *
 * The registry maintains two views over the same on-disk scan:
 *
 * - `list()` / `get()` / `has()` / `readBody()` — **filtered** view that
 *   excludes any skill whose name is in the `disabledNames` set. This is
 *   what the prompt builder, `skill.view`, and the LLM see. Disabled
 *   skills are invisible to the model.
 * - `listAll()` — **unfiltered** view including disabled skills, used
 *   exclusively by CLI / TUI rendering so operators can see what is
 *   installed-but-off.
 *
 * Editing `disabledNames` (via `setDisabledNames`) invalidates KV-cache
 * once because the rendered `### skills` block changes; the SkillRegistry
 * does not own KV management itself, it only emits `change` so callers
 * know to rebuild their stable prefix.
 */
export class SkillRegistry {
  /** All skills that loaded successfully, keyed by name. Includes disabled. */
  private allRecords: Map<string, SkillRecord> = new Map();
  /** Filtered view (excludes `disabledNames`). Rebuilt by `applyFilter`. */
  private records: Map<string, SkillRecord> = new Map();
  private loadErrors: Array<{ path: string; error: string }> = [];
  private listeners: SkillChangeListener[] = [];
  private disabledNames: ReadonlySet<string>;

  constructor(
    private readonly options: LoadSkillsOptions,
    disabledNames: Iterable<string> = [],
  ) {
    this.disabledNames = new Set(disabledNames);
  }

  async refresh(): Promise<LoadSkillsResult> {
    const result = await loadSkills(this.options);
    this.allRecords = new Map(result.skills.map((s) => [s.manifest.name, s]));
    this.loadErrors = result.errors;
    this.applyFilter();
    this.emit();
    return { skills: this.list(), errors: this.loadErrors };
  }

  /**
   * Replace the disabled-names set and rebuild the filtered view in
   * place. Does not re-scan disk. Emits `change` so listeners can
   * rebuild their stable prefix exactly once.
   */
  setDisabledNames(names: Iterable<string>): void {
    const next = new Set(names);
    if (sameSet(this.disabledNames, next)) return;
    this.disabledNames = next;
    this.applyFilter();
    this.emit();
  }

  /** Filtered list — what the prompt and `skill.view` see. */
  list(): SkillRecord[] {
    return Array.from(this.records.values()).sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    );
  }

  /**
   * Unfiltered list — every successfully-parsed skill on disk including
   * those flagged `disabled`. Consumed by CLI / TUI rendering only.
   */
  listAll(): Array<{ record: SkillRecord; disabled: boolean }> {
    return Array.from(this.allRecords.values())
      .map((record) => ({
        record,
        disabled: this.disabledNames.has(record.manifest.name),
      }))
      .sort((a, b) =>
        a.record.manifest.name.localeCompare(b.record.manifest.name),
      );
  }

  errors(): ReadonlyArray<{ path: string; error: string }> {
    return this.loadErrors;
  }

  get(name: string): SkillRecord {
    const record = this.records.get(name);
    if (!record) throw new SkillNotFoundError(name);
    return record;
  }

  has(name: string): boolean {
    return this.records.has(name);
  }

  /** Whether the name is currently in the disabled set (regardless of install state). */
  isDisabled(name: string): boolean {
    return this.disabledNames.has(name);
  }

  /** Snapshot of the current disabled-names set. */
  getDisabledNames(): string[] {
    return Array.from(this.disabledNames).sort();
  }

  async readBody(name: string): Promise<string> {
    const record = this.get(name);
    const content = await readFile(record.manifestPath, "utf8");
    const parsed = parseSkillFile(content);
    return parsed.body;
  }

  onChange(listener: SkillChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private applyFilter(): void {
    this.records = new Map();
    for (const [name, record] of this.allRecords) {
      if (this.disabledNames.has(name)) continue;
      this.records.set(name, record);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this);
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
