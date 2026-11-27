import { compressToolResult, retainToolOutput } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { SkillRecord } from "../../skills/skill-loader.js";
import { runSkillScript, skillEnvKeys } from "../../skills/skill-script-runner.js";
import { realpathSync } from "node:fs";
import { isWithinWorkspace } from "../../skills/workspace-files.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../../sandbox/command-runner.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import { readPluginState } from "../../plugins/plugin-store.js";
import type { ToolSecretSource } from "../../config/tool-secrets.js";
import { describeToolSecretUse } from "../tool-secret-use.js";
import { checkScriptSecrets, fillScriptSecrets, parseScriptEnv } from "./skill-script-secrets.js";
import { tailScriptBody } from "./skill-script-tail.js";

/**
 * Ingestion budget for every skill script, not just the auto-approved
 * gog check. `compressToolResult`'s summary IS the `tool_result` turn we
 * store (`toolResultTurn`), so what it drops here is gone for good —
 * `details` never reaches the transcript. At the compressor's defaults
 * (400 chars / 12 tail lines) a script log arrives as its last 12 lines
 * cut to 385 characters.
 *
 * `maxSummaryLength` matches `TOOL_RESULT_RENDER_CAP_CHARS`
 * (src/session/conversation-turn.ts) on purpose. That cap keeps the HEAD
 * of the summary, and this tool is in none of its exemptions, so a
 * summary kept longer than 8 000 would have its tail — the part the trim
 * below works to preserve — thrown away again at render time. Going
 * higher means adding `skill.run_script` to `TOOLS_FULL_BODY_WHEN_FRESH`
 * or giving it its own render cap, which is a prompt-budget policy call.
 */
const SCRIPT_COMPRESS_OPTIONS = {
  maxSummaryLength: 8_000,
  maxTailLines: 2_000,
} as const;

/**
 * Room kept inside that budget for what is not body: the compressor's
 * own `key: …` signature line (185 chars at most) and the omission
 * banner. The header is measured, not estimated, so a long skill or
 * script name costs body rather than overflowing the budget.
 *
 * The banner is the binding half of this reserve, not the signature
 * line: the longest one below runs ~121 chars, which leaves ~14 of
 * slack against `maxSummaryLength`. Re-measure before making any
 * banner wordier.
 */
const SIGNATURE_RESERVE_CHARS = 320;
const HEADER_RESERVE_LINES = 8;

const MAX_BODY_LINES =
  SCRIPT_COMPRESS_OPTIONS.maxTailLines - HEADER_RESERVE_LINES;

/**
 * Said when the script wrote more than the runner captured.
 * `runSkillScript` names no `maxOutputBytes`, so the runner's default
 * applies, and it keeps the HEAD of each stream — without this note the
 * omission banner below would claim that only *earlier* output is
 * missing, while the true end of the log — the part this tool promises
 * to keep — was never captured at all. The limit is read from the
 * runner rather than restated, so the note cannot drift out of date.
 */
const CAPTURE_LIMIT_NOTE =
  `… [the runner stopped capturing at its ` +
  `${Math.round(DEFAULT_MAX_OUTPUT_BYTES / 1024)} KiB per-stream limit ` +
  `while the script was still writing: the end of the log is missing]`;

export interface SkillRunScriptToolOptions extends DangerousToolOptions {
  /**
   * `tools.shell.envPassthrough`, so a skill script and a shell command
   * inherit the same secret-looking names. Omitted means none: the
   * script still gets the filtered environment.
   */
  envPassthrough?: readonly string[];
  /**
   * Data folder holding `plugins/plugins.json`. When set, a script from a
   * plugin skill runs only if the user allowed code for that plugin
   * (`runsCodeAccepted`), the same consent its local MCP servers need.
   */
  pluginsStateDir?: string;
  /** Called once the script is about to run, for the skill usage ledger (ATO-580). */
  onSkillUsed?: (record: SkillRecord) => void;
  /** Tool secrets `args` and `env` may name as `{{secret:NAME}}` (ATO-2530). Omitted: none. */
  secrets?: ToolSecretSource;
}

export function buildSkillRunScriptTool(
  registry: SkillRegistry,
  options: SkillRunScriptToolOptions,
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

      const record = ctx.workspaceSkills?.assertAvailable(skillName).record ?? registry.get(skillName);
      if (record.plugin !== undefined && options.pluginsStateDir !== undefined) {
        const plugin = readPluginState(options.pluginsStateDir).plugins[record.plugin];
        if (plugin?.runsCodeAccepted !== true) {
          throw new Error(
            `skill.run_script: scripts from plugin ${record.plugin} are off until code is allowed for it (atomic-agent plugin allow-code ${record.plugin})`,
          );
        }
      }
      // Names only: the user sees which keys the script will get, never
      // their values.
      const envKeys = skillEnvKeys(record);
      // `{{secret:NAME}}` (ATO-2530): known names only, before any question.
      const scriptEnv = parseScriptEnv(rawArgs.env, envKeys);
      const secretUse = checkScriptSecrets(scriptArgs, scriptEnv, options.secrets);
      if (!secretUse.ok) throw new Error(`skill.run_script: ${secretUse.message}`);
      const secretNames = secretUse.names;
      const preview = [
        `skill: ${record.manifest.name} (v${record.manifest.version})`,
        // A project skill is repository content, possibly from a cloned stranger's repo (ATO-312).
        ...(record.source === "project" ? [`source: project skill from ${ctx.workspaceSkills?.workingDir ?? ctx.workingDir}`] : []),
        `script: ${scriptName}`,
        `cwd: ${record.rootDir}`,
        `args: ${scriptArgs.join(" ")}`,
        ...(envKeys.length > 0 ? [`env keys: ${envKeys.join(", ")}`] : []),
        ...Object.entries(scriptEnv).map(([key, value]) => `env: ${key}=${value}`),
      ].join("\n");

      // Only the copy installed in the global skills directory is trusted
      // for this exemption. A same-named skill from a project folder, or
      // from the shared ~/.agents/skills folder other tools write into, goes
      // through approval like any other script.
      const autoApprovedGogCheck =
        !ctx.workspaceSkills &&
        record.source === "global" &&
        record.plugin === undefined &&
        record.shared !== true &&
        record.manifest.name === "gog-workspace" &&
        scriptName === "check-gog.sh" &&
        scriptArgs.length === 0 &&
        Object.keys(scriptEnv).length === 0;
      if (!autoApprovedGogCheck) {
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "skill.run_script",
            // A secret asks as `shell_secret`: never granted (ATO-2530).
            category: secretNames.length > 0 ? "shell_secret" : "script",
            reason: `run ${record.manifest.name}/${scriptName}${describeToolSecretUse(secretNames)}`,
            preview,
            affectedResources: [record.rootDir],
          },
          ctx.signal,
        );
      }

      // After approval, and only into what is spawned.
      let runArgs = scriptArgs;
      let runEnv = scriptEnv;
      if (secretNames.length > 0 && options.secrets !== undefined) {
        const filled = await fillScriptSecrets(scriptName, scriptArgs, scriptEnv, secretNames, options.secrets);
        if (!filled.ok) throw new Error(`skill.run_script: ${filled.message}`);
        ({ args: runArgs, env: runEnv } = filled);
      }
      ctx.workspaceSkills?.assertAvailable(skillName);
      options.onSkillUsed?.(record);
      const outcome = await runSkillScript(record, {
        script: scriptName,
        args: runArgs,
        ...(Object.keys(runEnv).length > 0 ? { env: runEnv } : {}),
        timeoutMs,
        signal: ctx.signal,
        ...(options.envPassthrough !== undefined
          ? { envPassthrough: options.envPassthrough }
          : {}),
        ...(ctx.workspaceSkills ? { beforeRun: (scriptPath: string) => {
          ctx.workspaceSkills!.assertAvailable(skillName);
          if (!isWithinWorkspace(record.rootDir, realpathSync(scriptPath))) throw new Error("Skill script resolves outside its selected source");
        } } : {}),
      });

      const status = outcome.exitCode === 0 ? "ok" : "error";
      const header = `# ${record.manifest.name}/${scriptName}\nexit: ${outcome.exitCode ?? "signal:" + outcome.signal}${outcome.timedOut ? " (timed out)" : ""}`;
      const note = outcome.truncated ? `\n${CAPTURE_LIMIT_NOTE}` : "";
      const fullBody = [outcome.stdout, outcome.stderr]
          .filter((s) => s.trim().length > 0)
          .join("\n---\n");
      const trimmed = ctx.modelMode === "cloud" ? { text: fullBody, trimmed: false } : tailScriptBody(
        fullBody,
        SCRIPT_COMPRESS_OPTIONS.maxSummaryLength -
          header.length -
          note.length -
          SIGNATURE_RESERVE_CHARS,
        MAX_BODY_LINES,
      );
      const body = `${trimmed.text}${note}`;
      const compressed = compressToolResult(
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
      // The compressor can no longer see what we trimmed before it, and
      // it never sees what the runner dropped at capture: without this
      // a result missing most of its log would render as complete.
      const lost = trimmed.trimmed || outcome.truncated;
      return lost ? retainToolOutput(compressed, { ...compressed, truncated: true }, { truncated: true }) : compressed;
    },
  };
}
