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
 */
export class SkillRegistry {
  private records: Map<string, SkillRecord> = new Map();
  private loadErrors: Array<{ path: string; error: string }> = [];
  private listeners: SkillChangeListener[] = [];

  constructor(private readonly options: LoadSkillsOptions) {}

  async refresh(): Promise<LoadSkillsResult> {
    const result = await loadSkills(this.options);
    this.records = new Map(result.skills.map((s) => [s.manifest.name, s]));
    this.loadErrors = result.errors;
    this.emit();
    return result;
  }

  list(): SkillRecord[] {
    return Array.from(this.records.values()).sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
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

  private emit(): void {
    for (const listener of this.listeners) listener(this);
  }
}
