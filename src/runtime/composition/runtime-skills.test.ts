import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import * as seeding from "../../skills/seed-starter-skills.js";
import { prepareRuntimeSkills, recurringTaskTexts, startRuntimeSkillCurator } from "./runtime-skills.js";
import { existsSync } from "node:fs";
import { DAY_MS, SkillUsageLedger, skillCuratorPaths } from "../../skills/curator/index.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

describe("runtime skill phases and live catalog ownership", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "atomic-runtime-skills-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", directory);
    resetConfigCache();
    vi.spyOn(seeding, "seedStarterSkillsIfMissing").mockResolvedValue({ sourceDir: null, installed: [], removed: [] });
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); resetConfigCache();
    await rm(directory, { recursive: true, force: true });
  });
  async function skill(name: string, description: string) {
    const path = join(getConfig().paths.globalSkillsDir, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# Body\n`);
  }

  it("awaits seeding then discovery, and reads the catalog budget only at its later phase", async () => {
    const phases: string[] = [];
    const originalRefresh = SkillRegistry.prototype.refresh;
    vi.spyOn(seeding, "seedStarterSkillsIfMissing").mockImplementation(async () => {
      phases.push("seed"); await Promise.resolve(); phases.push("seeded");
      return { sourceDir: null, installed: [], removed: [] };
    });
    vi.spyOn(SkillRegistry.prototype, "refresh").mockImplementation(async function(this: SkillRegistry) {
      phases.push("refresh"); return await originalRefresh.call(this);
    });
    const config = getConfig();
    Object.defineProperty(config.skills, "catalogTokenBudget", { get: () => { phases.push("catalog"); return 512; } });
    const prepared = await prepareRuntimeSkills(config, directory, logger);
    expect(phases).toEqual(["seed", "seeded", "refresh"]);
    phases.push("static-tools");
    prepared.createCatalog();
    expect(phases).toEqual(["seed", "seeded", "refresh", "static-tools", "catalog"]);
  });

  it("refreshes the single live catalog, preserves disabled files, and reads the latest host handler", async () => {
    await skill("alpha", "A short skill"); await skill("beta", "B short skill");
    const config = getConfig(); config.skills.disabled = ["beta"];
    const prepared = await prepareRuntimeSkills(config, directory, logger);
    const catalog = prepared.createCatalog();
    const original = catalog.getSkillCatalog();
    expect(original.map(entry => entry.name)).toEqual(["alpha"]);
    const oldHandler = vi.fn(), nextHandler = vi.fn();
    const options: Pick<CreateAgentRuntimeOptions, "handlers"> = { handlers: { onSkillRegistryChange: oldHandler } };
    const refresh = catalog.createRefreshSkills(options);
    prepared.skillRegistry.setDisabledNames([]);
    options.handlers = { onSkillRegistryChange: nextHandler };
    await refresh();
    expect(oldHandler).not.toHaveBeenCalled();
    expect(catalog.getSkillCatalog()).not.toBe(original);
    expect(catalog.getSkillCatalog().map(entry => entry.name)).toEqual(["alpha", "beta"]);
    expect(nextHandler).toHaveBeenCalledWith([...catalog.getSkillCatalog()], catalog.getSkillCatalogDropped());
    expect(nextHandler.mock.calls[0]?.[0]).not.toBe(catalog.getSkillCatalog());
    config.skills.catalogTokenBudget = 1;
    await refresh();
    expect(catalog.getSkillCatalogDropped()).toBeGreaterThan(0);
  });

  it("propagates refresh rejection without replacing the prior catalog or notifying the host", async () => {
    await skill("alpha", "A short skill");
    const prepared = await prepareRuntimeSkills(getConfig(), directory, logger);
    const catalog = prepared.createCatalog(); const original = catalog.getSkillCatalog();
    const handler = vi.fn(); const failure = new Error("discovery rejected");
    vi.spyOn(prepared.skillRegistry, "refresh").mockRejectedValue(failure);
    await expect(catalog.createRefreshSkills({ handlers: { onSkillRegistryChange: handler } })()).rejects.toBe(failure);
    expect(catalog.getSkillCatalog()).toBe(original); expect(handler).not.toHaveBeenCalled();
  });

  it("does not run discovery if the earlier seeding phase rejects", async () => {
    const failure = new Error("seed rejected");
    vi.spyOn(seeding, "seedStarterSkillsIfMissing").mockRejectedValue(failure);
    const refresh = vi.spyOn(SkillRegistry.prototype, "refresh");
    await expect(prepareRuntimeSkills(getConfig(), directory, logger)).rejects.toBe(failure);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("automatic skill curator (ATO-580)", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "atomic-runtime-curator-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", directory);
    resetConfigCache();
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); resetConfigCache();
    await rm(directory, { recursive: true, force: true });
  });

  it("lists only recurring tasks that can still run", () => {
    const list = vi.fn(() => [
      { recurring: true, userMessage: "daily: use weekly-report" },
      { recurring: false, userMessage: "one-off" },
    ]);
    expect(recurringTaskTexts({ list } as never)).toEqual(["daily: use weekly-report"]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: ["pending", "running", "blocked"] }));
  });

  it("stays off unless ATOMIC_AGENT_SKILL_CURATOR is set", () => {
    const cronTexts = vi.fn(() => []);
    expect(startRuntimeSkillCurator({ config: getConfig(), logger, cronTexts, env: {} })).toBeNull();
    expect(cronTexts).not.toHaveBeenCalled();
  });

  it("archives an unused agent-learned skill and refreshes the catalog when on", async () => {
    const config = getConfig();
    const name = "learned-old";
    await mkdir(join(config.paths.globalSkillsDir, name), { recursive: true });
    await writeFile(join(config.paths.globalSkillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: x\nversion: 1.0.0\n---\n`);
    await new SkillUsageLedger(skillCuratorPaths(config.paths.stateDir).usageFile)
      .markAgentCreated(name, Date.now() - 40 * DAY_MS);
    const onArchived = vi.fn();
    await startRuntimeSkillCurator({ config, logger, cronTexts: () => [], onArchived, env: { ATOMIC_AGENT_SKILL_CURATOR: "1" } });
    expect(onArchived).toHaveBeenCalledTimes(1);
    expect(existsSync(join(skillCuratorPaths(config.paths.stateDir).archiveDir, name, "SKILL.md"))).toBe(true);
  });
});
