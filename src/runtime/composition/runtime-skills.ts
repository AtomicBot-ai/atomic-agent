import { join } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { SkillCatalogEntry } from "../../prompt/stable-prefix.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { listEnabledPluginSkills } from "../../plugins/plugin-runtime.js";
import { buildSkillCatalogSection } from "../../skills/skill-catalog.js";
import { listStarterSkillNames, seedStarterSkillsIfMissing } from "../../skills/seed-starter-skills.js";
import { createProjectSkillTrustGate, projectTrustHint } from "../../skills/project-trust.js";
import { runSkillCurator, skillCuratorAutoRunEnabled, skillCuratorPaths } from "../../skills/curator/index.js";
import type { TaskStore } from "../../tasks/task-store.js";

/** Text of every recurring task that can still run; a skill named in one is never archived. */
export function recurringTaskTexts(taskStore: Pick<TaskStore, "list">): string[] {
  return taskStore
    .list({ status: ["pending", "running", "blocked"], limit: 10_000 })
    .filter((task) => task.recurring)
    .map((task) => task.userMessage);
}

/**
 * The automatic skill curator pass (ATO-580): off unless
 * `ATOMIC_AGENT_SKILL_CURATOR=1`, then at most once a week, in the
 * background so boot never waits on it. Archived skills disappear from
 * the catalog on the next refresh; `onArchived` triggers that refresh.
 */
export function startRuntimeSkillCurator(input: {
  config: AtomicAgentConfig;
  logger: StructuredLogger;
  cronTexts: () => readonly string[];
  onArchived?: () => Promise<void> | void;
  env?: NodeJS.ProcessEnv;
}): Promise<void> | null {
  if (!skillCuratorAutoRunEnabled(input.env)) return null;
  const { config, logger } = input;
  return (async () => {
    // Read the task list before the first await: the store may close on an early shutdown.
    const cronTexts = input.cronTexts();
    const result = await runSkillCurator({
      skillsDir: config.paths.globalSkillsDir,
      paths: skillCuratorPaths(config.paths.stateDir),
      starterNames: await listStarterSkillNames(),
      cronTexts,
    });
    if (!result.ran) return;
    if (result.archived.length > 0 || result.stale.length > 0) {
      logger.info("skill curator: unused agent-learned skills", {
        archived: result.archived,
        stale: result.stale,
      });
    }
    for (const e of result.errors) logger.warn("skill curator: could not archive a skill", e);
    if (result.archived.length > 0) await input.onArchived?.();
  })().catch((err: unknown) => {
    logger.warn("skill curator failed; skills were left as they were", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function prepareRuntimeSkills(
  config: AtomicAgentConfig,
  workingDir: string,
  logger: StructuredLogger,
) {


  await seedStarterSkillsIfMissing({
    globalSkillsDir: config.paths.globalSkillsDir,
    logger,
  });

  const skillRegistry = new SkillRegistry(
    {
      globalDir: config.paths.globalSkillsDir,
      projectDir: join(workingDir, config.paths.projectSkillsDirName),
      // Skills from installed, enabled plugins (ATO-562); re-read on every refresh.
      pluginSkills: () => listEnabledPluginSkills(config.paths.stateDir),
    },
    config.skills.disabled,
    // Project skills load only after the operator trusted this folder (ATO-298).
    // Nothing here can ask: a TUI or desktop asks and refreshes, a headless run stays closed.
    createProjectSkillTrustGate(config.paths.userConfigFile, config.skills.projectTrust, workingDir),
  );
  await skillRegistry.refresh();
  for (const e of skillRegistry.errors()) {
    logger.warn("skill registry: skipped skill directory", {
      path: e.path,
      error: e.error,
    });
  }
  let hinted = "";
  const hintUntrusted = () => {
    const pending = skillRegistry.listAll().filter(e => e.trust === "pending").map(e => e.record.manifest.name);
    const signature = pending.join("\n");
    if (signature === hinted) return;
    hinted = signature;
    if (pending.length) logger.warn("project skills in this folder are not trusted yet and were not loaded", {
      workingDir, skills: pending.length, hint: projectTrustHint(workingDir) });
  };
  hintUntrusted();
  const createCatalog = () => {
    let skillSection = buildSkillCatalogSection(skillRegistry.list(), {
      tokenBudget: config.skills.catalogTokenBudget,
    });
    let skillCatalog: readonly SkillCatalogEntry[] = skillSection.entries;
    const createRefreshSkills = (
      options: Pick<CreateAgentRuntimeOptions, "handlers">,
    ) => {


      const refreshSkills = async (): Promise<void> => {
        await skillRegistry.refresh();
        for (const e of skillRegistry.errors()) {
          logger.warn("skill registry: skipped skill directory", {
            path: e.path,
            error: e.error,
          });
        }
        hintUntrusted();
        skillSection = buildSkillCatalogSection(skillRegistry.list(), {
          tokenBudget: config.skills.catalogTokenBudget,
        });
        skillCatalog = skillSection.entries;
        options.handlers?.onSkillRegistryChange?.(
          [...skillCatalog],
          skillSection.dropped,
        );
      };
      return refreshSkills;
    };
    return {
      getSkillCatalog: () => skillCatalog,
      getSkillCatalogDropped: () => skillSection.dropped,
      createRefreshSkills,
    };
  };
  return { skillRegistry, createCatalog };
}
