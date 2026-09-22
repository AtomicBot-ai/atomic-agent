import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import { runSkillScript } from "../../skills/skill-script-runner.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";

/**
 * Ingestion budget for every skill script, not just the auto-approved
 * gog check. `compressToolResult`'s summary IS the `tool_result` turn we
 * store (`toolResultTurn`), so what it drops here is gone for good —
 * `details` never reaches the transcript. At the compressor's defaults
 * (400 chars / 12 tail lines) a script log arrives as its last 12 lines
 * cut to 385 characters. Same numbers the gog check already used, so
 * this is one line to change if the caps should be tuned.
 */
const SCRIPT_COMPRESS_OPTIONS = {
  maxSummaryLength: 16_000,
  maxTailLines: 2_000,
} as const;

/**
 * Room kept inside that budget for the header and for the compressor's
 * own `key: …` signature line, so trimming the body is what binds.
 */
const HEADER_RESERVE_CHARS = 1_024;
const HEADER_RESERVE_LINES = 8;

const MAX_BODY_CHARS =
  SCRIPT_COMPRESS_OPTIONS.maxSummaryLength - HEADER_RESERVE_CHARS;
const MAX_BODY_LINES =
  SCRIPT_COMPRESS_OPTIONS.maxTailLines - HEADER_RESERVE_LINES;

/**
 * The script body, trimmed to what the budget leaves under the header.
 * We keep the END of it: script output is a log, so the last lines — the
 * failure, the summary, the final state — carry the signal, while the
 * start is setup noise. The trim happens here and not in the compressor
 * because the compressor works on the whole text: its line pass keeps
 * the last N lines, which would eat the `# skill/script` + `exit:`
 * header, and its length pass keeps the head, which would eat a
 * trailing footer instead. Trimming the body first leaves the header
 * intact under either pass, so the exit code always survives.
 */
function tailScriptBody(body: string): string {
  const lines = body.split("\n");
  const droppedLines = Math.max(0, lines.length - MAX_BODY_LINES);
  let kept = droppedLines > 0 ? lines.slice(-MAX_BODY_LINES).join("\n") : body;
  const droppedChars = Math.max(0, kept.length - MAX_BODY_CHARS);
  if (droppedChars > 0) kept = kept.slice(droppedChars);
  if (droppedLines === 0 && droppedChars === 0) return body;
  return `… [omitted ${droppedLines} earlier lines, ${droppedChars} characters]\n${kept}`;
}

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
        throw new Error(
          "skill.run_script: `script` must be a non-empty string",
        );
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
      const body = tailScriptBody(
        [outcome.stdout, outcome.stderr]
          .filter((s) => s.trim().length > 0)
          .join("\n---\n"),
      );
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
        SCRIPT_COMPRESS_OPTIONS,
      );
    },
  };
}
