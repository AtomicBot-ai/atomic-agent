import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ENV_DEFAULTS } from "./config-schema.js";
import { envOverrideFor, ENV_SETTINGS, INTERNAL_ENV_NAMES } from "./env-settings.js";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** Every non-test `.ts` file under `src/`, except the table itself. */
function productionSources(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !path.endsWith("env-settings.ts")) out.push(path);
  }
  return out;
}

function namesReadByTheCode(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSources()) {
    for (const match of readFileSync(file, "utf8").matchAll(/"(ATOMIC_AGENT_[A-Z0-9_]+)"/g)) names.add(match[1]!);
  }
  return names;
}

describe("ENV_SETTINGS", () => {
  const documented = new Set(ENV_SETTINGS.map((setting) => setting.name));

  it("lists each variable once", () => {
    expect(documented.size).toBe(ENV_SETTINGS.length);
  });

  it("documents every ATOMIC_AGENT_* variable the code reads, or names it internal", () => {
    const missing = [...namesReadByTheCode()].filter((name) => !documented.has(name) && !INTERNAL_ENV_NAMES.has(name));
    expect(missing, "add them to ENV_SETTINGS (or INTERNAL_ENV_NAMES) in src/config/env-settings.ts").toEqual([]);
  });

  it("has no entry the code no longer reads", () => {
    const read = namesReadByTheCode();
    const stale = [...documented, ...INTERNAL_ENV_NAMES.keys()].filter(
      (name) => name.startsWith("ATOMIC_AGENT_") && !read.has(name),
    );
    expect(stale).toEqual([]);
  });

  it("takes defaults from ENV_DEFAULTS rather than restating them", () => {
    const byName = new Map(ENV_SETTINGS.map((setting) => [setting.name, setting.default]));
    expect(byName.get("ATOMIC_AGENT_STATE_DIR")).toBe(ENV_DEFAULTS.STATE_DIR);
    expect(byName.get("ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS")).toBe(ENV_DEFAULTS.MAX_PARALLEL_TOOL_CALLS);
    expect(byName.get("ATOMIC_AGENT_TASKS_SCHEDULER_TICK_MS")).toBe(ENV_DEFAULTS.TASKS_SCHEDULER_TICK_MS);
  });

  it("names the config key each override wins over", () => {
    expect(envOverrideFor("localModels.completionMaxTokens")).toBe("ATOMIC_AGENT_LLAMA_MAX_TOKENS");
    expect(envOverrideFor("localModels.requestTimeoutMs")).toBe("ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS");
    expect(envOverrideFor("skills.catalogTokenBudget")).toBe("ATOMIC_AGENT_SKILLS_CATALOG_BUDGET");
    expect(envOverrideFor("browser.cdpUrl")).toBe("ATOMIC_AGENT_BROWSER_CDP_URL");
    expect(envOverrideFor("agent.maxSteps")).toBeNull();
  });
});
