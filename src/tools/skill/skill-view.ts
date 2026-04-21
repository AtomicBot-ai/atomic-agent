import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";

export function buildSkillViewTool(registry: SkillRegistry): ToolDefinition {
  return {
    name: "skill.view",
    description:
      "Load the full body of an installed skill (SKILL.md without frontmatter) into the session.",
    readonly: true,
    async run(rawArgs) {
      const name = rawArgs.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("skill.view: `name` must be a non-empty string");
      }
      const record = registry.get(name);
      const body = await registry.readBody(name);
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
