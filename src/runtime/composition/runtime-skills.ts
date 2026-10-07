import { join } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { SkillCatalogEntry } from "../../prompt/stable-prefix.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { buildSkillCatalogSection } from "../../skills/skill-catalog.js";
import { seedStarterSkillsIfMissing } from "../../skills/seed-starter-skills.js";

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
    },
    config.skills.disabled,
  );
  await skillRegistry.refresh();
  for (const e of skillRegistry.errors()) {
    logger.warn("skill registry: skipped skill directory", {
      path: e.path,
      error: e.error,
    });
  }
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
