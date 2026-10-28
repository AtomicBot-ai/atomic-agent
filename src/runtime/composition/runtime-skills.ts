import { join } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { SkillCatalogEntry } from "../../prompt/stable-prefix.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { buildSkillCatalogSection } from "../../skills/skill-catalog.js";
import { seedStarterSkillsIfMissing } from "../../skills/seed-starter-skills.js";
import { createProjectSkillTrustGate, projectTrustHint } from "../../skills/project-trust.js";

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
