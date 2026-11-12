import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { SkillRecord } from "../../skills/skill-loader.js";
import { workspaceSkillBody } from "../../skills/workspace-skills.js";

export function buildSkillViewTool(
  registry: SkillRegistry,
  /** Called after a body was read, for the skill usage ledger (ATO-580). */
  onSkillUsed?: (record: SkillRecord) => void,
): ToolDefinition {
  return {
    name: "skill.view",
    description:
      "Load the full body of an installed skill (SKILL.md without frontmatter) into the session.",
    readonly: true,
    async run(rawArgs, ctx) {
      const name = rawArgs.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("skill.view: `name` must be a non-empty string");
      }
      const scoped = ctx.workspaceSkills?.assertAvailable(name);
      const record = scoped?.record ?? registry.get(name);
      const body = scoped ? workspaceSkillBody(scoped) : await registry.readBody(name);
      onSkillUsed?.(record);
      return compressToolResult(
        {
          tool: "skill.view",
          status: "ok",
          output: `# skill: ${record.manifest.name} (v${record.manifest.version})\n${body}`,
          details: {
            skillLoaded: {
              name: record.manifest.name,
              version: record.manifest.version,
              body,
              ...(scoped && ctx.modelMode === "cloud" ? { workspace: ctx.workspaceSkills!.workingDir, sourcePath: record.manifestPath, fingerprint: scoped.fingerprint } : {}),
            },
            source: record.source,
            rootDir: record.rootDir,
          },
        },
        { maxSummaryLength: 8000, maxTailLines: 800 },
      );
    },
  };
}
