import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import { runSkillScript } from "../../skills/skill-script-runner.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";

const GOG_CHECK_COMPRESS_OPTIONS = {
  maxSummaryLength: 16_000,
  maxTailLines: 2_000,
} as const;

export function buildSkillRunScriptTool(
  registry: SkillRegistry,
  options: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "skill.run_script",
    description:
      "Run a script declared in an installed skill's requires_scripts. Dangerous — always requires approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const skillName = rawArgs.skill;
      const scriptName = rawArgs.script;
      if (typeof skillName !== "string" || skillName.length === 0) {
        throw new Error("skill.run_script: `skill` must be a non-empty string");
      }
      if (typeof scriptName !== "string" || scriptName.length === 0) {
        throw new Error("skill.run_script: `script` must be a non-empty string");
      }
      const scriptArgs = Array.isArray(rawArgs.args)
        ? rawArgs.args.map((v) => String(v))
        : [];
      const timeoutMs =
        typeof rawArgs.timeoutMs === "number" &&
        Number.isFinite(rawArgs.timeoutMs)
          ? rawArgs.timeoutMs
          : 30_000;

      const record = registry.get(skillName);
      const preview = [
        `skill: ${record.manifest.name} (v${record.manifest.version})`,
        `script: ${scriptName}`,
        `cwd: ${record.rootDir}`,
        `args: ${scriptArgs.join(" ")}`,
      ].join("\n");

      const autoApprovedGogCheck =
        record.manifest.name === "gog-workspace" &&
        scriptName === "check-gog.sh" &&
        scriptArgs.length === 0;
      if (!autoApprovedGogCheck) {
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "skill.run_script",
            category: "script",
            reason: `run ${record.manifest.name}/${scriptName}`,
            preview,
            affectedResources: [record.rootDir],
          },
          ctx.signal,
        );
      }

      const outcome = await runSkillScript(record, {
        script: scriptName,
        args: scriptArgs,
        timeoutMs,
        signal: ctx.signal,
      });

      const status = outcome.exitCode === 0 ? "ok" : "error";
      const header = `# ${record.manifest.name}/${scriptName}\nexit: ${outcome.exitCode ?? "signal:" + outcome.signal}${outcome.timedOut ? " (timed out)" : ""}`;
      const body = [outcome.stdout, outcome.stderr]
        .filter((s) => s.trim().length > 0)
        .join("\n---\n");
      return compressToolResult(
        {
          tool: "skill.run_script",
          status,
          output: `${header}\n${body}`,
          details: {
            skill: outcome.skill,
            script: outcome.script,
            scriptPath: outcome.scriptPath,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            durationMs: outcome.durationMs,
            timedOut: outcome.timedOut,
            truncated: outcome.truncated,
          },
        },
        autoApprovedGogCheck ? GOG_CHECK_COMPRESS_OPTIONS : {},
      );
    },
  };
}
