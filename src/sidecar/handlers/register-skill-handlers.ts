import {
  disableSkill,
  enableSkill,
  installSkillFromPath,
  listSkills,
  uninstallSkillByName,
} from "../../runtime-api/index.js";
import type {
  SkillDisablePayload,
  SkillDisableResult,
  SkillEnablePayload,
  SkillEnableResult,
  SkillInstallPayload,
  SkillInstallResult,
  SkillListPayload,
  SkillListResult,
  SkillUninstallPayload,
  SkillUninstallResult,
} from "../protocol/index.js";
import type { SidecarHandlerContext } from "./handler-context.js";

/**
 * `skill.*` — skill catalog management. `AgentRuntime` is structurally a
 * `SkillServiceDeps` (same as the HTTP route), so it is passed to the facade
 * directly. Enable/disable/install/uninstall call `refreshSkills` internally,
 * which fires `skill.registry_updated` through the runtime handler wired in
 * `main.ts` — no manual event emission here.
 */
export function registerSkillHandlers(ctx: SidecarHandlerContext): void {
  const { router, runtime } = ctx;

  router.register<SkillListPayload, SkillListResult>("skill.list", () => ({
    skills: listSkills(runtime).skills,
  }));

  router.register<SkillEnablePayload, SkillEnableResult>(
    "skill.enable",
    async (request) => {
      await enableSkill(runtime, request.payload.name);
      return { ok: true };
    },
  );

  router.register<SkillDisablePayload, SkillDisableResult>(
    "skill.disable",
    async (request) => {
      await disableSkill(runtime, request.payload.name);
      return { ok: true };
    },
  );

  router.register<SkillInstallPayload, SkillInstallResult>(
    "skill.install",
    async (request) => {
      const { manifest, installedAt } = await installSkillFromPath(runtime, {
        sourcePath: request.payload.sourcePath,
        ...(request.payload.force ? { force: true } : {}),
      });
      return { name: manifest.name, installedAt };
    },
  );

  router.register<SkillUninstallPayload, SkillUninstallResult>(
    "skill.uninstall",
    async (request) => {
      const { removed } = await uninstallSkillByName(runtime, {
        name: request.payload.name,
      });
      return { removed };
    },
  );
}
