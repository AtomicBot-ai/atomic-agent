import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseScenario, type Scenario } from "./scenario-format.js";

/** Folder under the agent's state dir that holds the scenario files. */
export const BROWSER_SCENARIO_DIR = "browser-scenarios";

export function browserScenarioDir(stateDir: string): string {
  return join(stateDir, BROWSER_SCENARIO_DIR);
}

export interface ScenarioListEntry {
  name: string;
  /** Set when the file could not be read; the scenario cannot run. */
  error?: string;
  scenario?: Scenario;
}

/**
 * Saved scenarios (ATO-960): one `<name>.json` per scenario under
 * `<stateDir>/browser-scenarios/`, written through a temp file so a
 * crash never leaves half a file. Without a folder (tests, a registry
 * built without a state dir) they live in memory for the process.
 */
export class ScenarioStore {
  private readonly memory = new Map<string, Scenario>();

  constructor(private readonly dir?: string) {}

  async save(scenario: Scenario): Promise<{ replaced: boolean }> {
    const replaced = (await this.load(scenario.name).catch(() => null)) !== null;
    if (this.dir === undefined) {
      this.memory.set(scenario.name, scenario);
      return { replaced };
    }
    await mkdir(this.dir, { recursive: true });
    const file = this.file(scenario.name);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(scenario, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
    return { replaced };
  }

  /** The scenario, or `null` when there is none by that name; throws when the file is broken. */
  async load(name: string): Promise<Scenario | null> {
    if (this.dir === undefined) return this.memory.get(name) ?? null;
    let text: string;
    try {
      text = await readFile(this.file(name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    // The file name is the scenario's name, whatever the file says.
    return { ...parseScenario(JSON.parse(text)), name };
  }

  async list(): Promise<ScenarioListEntry[]> {
    if (this.dir === undefined) {
      return [...this.memory.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((scenario) => ({ name: scenario.name, scenario }));
    }
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const names = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
    const out: ScenarioListEntry[] = [];
    for (const name of names) {
      try {
        const scenario = await this.load(name);
        if (scenario !== null) out.push({ name, scenario });
      } catch (error) {
        out.push({ name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return out;
  }

  /** `true` when something was removed. */
  async delete(name: string): Promise<boolean> {
    if (this.dir === undefined) return this.memory.delete(name);
    try {
      await rm(this.file(name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Names are checked by `normalizeScenarioName` first, so they never hold a path separator. */
  private file(name: string): string {
    return join(this.dir!, `${name}.json`);
  }
}
