import { readJsonFile, writeJsonFile } from "./json-file.js";

/**
 * Who brought a skill into the skills folder, as far as this agent saw.
 * `agent`: the agent wrote the folder itself (self-learning). Only these
 * skills are ever archived by the curator. Starter, hub, plugin and
 * hand-written skills have no recorded origin and are never touched.
 */
export type SkillOrigin = "agent";

export interface SkillUsageEntry {
  useCount: number;
  /** Epoch ms of the last `skill.view` / `skill.run_script`; absent if never used. */
  lastUsedAt?: number;
  origin?: SkillOrigin;
  /** Epoch ms the agent created the folder (set together with `origin`). */
  createdAt?: number;
  /** Epoch ms of the last restore; restarts the curator's idle clock. */
  restoredAt?: number;
}

export interface SkillUsageFile {
  version: 1;
  skills: Record<string, SkillUsageEntry>;
}

function emptyFile(): SkillUsageFile {
  return { version: 1, skills: {} };
}

function normalizeEntry(raw: unknown): SkillUsageEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const useCount =
    typeof obj.useCount === "number" && Number.isFinite(obj.useCount) && obj.useCount >= 0
      ? Math.floor(obj.useCount)
      : 0;
  const entry: SkillUsageEntry = { useCount };
  if (typeof obj.lastUsedAt === "number" && Number.isFinite(obj.lastUsedAt)) entry.lastUsedAt = obj.lastUsedAt;
  if (obj.origin === "agent") entry.origin = "agent";
  if (typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt)) entry.createdAt = obj.createdAt;
  if (typeof obj.restoredAt === "number" && Number.isFinite(obj.restoredAt)) entry.restoredAt = obj.restoredAt;
  return entry;
}

/** Parse the ledger leniently: a broken entry is dropped, not fatal. */
export function normalizeUsageFile(raw: unknown): SkillUsageFile {
  const out = emptyFile();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const skills = (raw as Record<string, unknown>).skills;
  if (skills === null || typeof skills !== "object" || Array.isArray(skills)) return out;
  for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
    const entry = normalizeEntry(value);
    if (entry !== null) out.skills[name] = entry;
  }
  return out;
}

/**
 * Per-skill use count and last use, kept in `<stateDir>/skills-usage.json`.
 * Updates within one process are serialized; two processes on the same
 * state folder can still lose an increment to each other, which only
 * makes a skill look a little less used, never archives a used one
 * (the last-used time is the newest of the two).
 */
export class SkillUsageLedger {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<SkillUsageFile> {
    return normalizeUsageFile(await readJsonFile(this.file));
  }

  async get(name: string): Promise<SkillUsageEntry | undefined> {
    return (await this.read()).skills[name];
  }

  /** Count one use of `name` at `now`. */
  recordUse(name: string, now: number = Date.now()): Promise<void> {
    return this.update((file) => {
      const prev = file.skills[name] ?? { useCount: 0 };
      file.skills[name] = {
        ...prev,
        useCount: prev.useCount + 1,
        lastUsedAt: Math.max(prev.lastUsedAt ?? 0, now),
      };
    });
  }

  /** Remember that the agent created `name`. Kept if already recorded. */
  markAgentCreated(name: string, now: number = Date.now()): Promise<void> {
    return this.update((file) => {
      const prev = file.skills[name] ?? { useCount: 0 };
      if (prev.origin === "agent") return false;
      file.skills[name] = { ...prev, origin: "agent", createdAt: now };
    });
  }

  /** A restored skill starts a fresh idle period, so the curator does not archive it again at once. */
  markRestored(name: string, now: number = Date.now()): Promise<void> {
    return this.update((file) => {
      const prev = file.skills[name];
      if (prev === undefined) return false;
      file.skills[name] = { ...prev, restoredAt: now };
    });
  }

  private update(mutate: (file: SkillUsageFile) => void | false): Promise<void> {
    const run = this.queue.then(async () => {
      const file = await this.read();
      if (mutate(file) === false) return;
      await writeJsonFile(this.file, file);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
