import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import { runSkillScript } from "../../skills/skill-script-runner.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../../sandbox/command-runner.js";
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

interface TrimmedBody {
  text: string;
  /** Something was dropped, so the result must report itself truncated. */
  trimmed: boolean;
}

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
function tailScriptBody(body: string, maxChars: number): TrimmedBody {
  const budget = Math.max(1, maxChars);
  // Count and cut over the non-blank lines only. `extractTail` deletes
  // blank lines from whatever we hand it, right after this banner is
  // written, so counting them here would state a number the model
  // cannot reconcile with what it received — and it also disposes of
  // the empty element that output ending in a newline splits into.
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const whole = lines.join("\n");
  const keptLines =
    lines.length > MAX_BODY_LINES ? lines.slice(-MAX_BODY_LINES) : lines;
  const kept = keptLines.join("\n");
  if (kept.length <= budget) {
    if (keptLines.length === lines.length) {
      return { text: body, trimmed: false };
    }
    const dropped = lines.length - keptLines.length;
    return {
      text: banner(dropped, whole.length - kept.length, kept),
      trimmed: true,
    };
  }
  // Cut on a line boundary: a body that starts mid-line reads as
  // corrupt output, and a half line would also have to be counted.
  const cut = kept.slice(kept.length - budget);
  const firstBreak = cut.indexOf("\n");
  if (firstBreak === -1) {
    // A single line longer than the whole budget — there is no boundary
    // to cut on, so the line-boundary promise above cannot be kept.
    // Say that, rather than report a cut through the middle of a token
    // as "0 earlier lines" of loss.
    const earlier = lines.length - 1;
    const lastLine = lines[lines.length - 1] ?? "";
    const also = earlier > 0 ? `, along with ${earlier} earlier lines` : "";
    return {
      text:
        `… [one line is longer than this result's budget: its first ` +
        `${lastLine.length - cut.length} characters are omitted${also}]\n${cut}`,
      trimmed: true,
    };
  }
  const tail = cut.slice(firstBreak + 1);
  // Count the lines actually gone, both passes together: the character
  // pass drops whole lines of its own, so a banner counting only the
  // line pass states a number that is not true.
  return {
    text: banner(
      lines.length - tail.split("\n").length,
      whole.length - tail.length,
      tail,
    ),
    trimmed: true,
  };
}

function banner(lines: number, chars: number, kept: string): string {
  return `… [omitted ${lines} earlier lines, ${chars} characters]\n${kept}`;
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
      const note = outcome.truncated ? `\n${CAPTURE_LIMIT_NOTE}` : "";
      const trimmed = tailScriptBody(
        [outcome.stdout, outcome.stderr]
          .filter((s) => s.trim().length > 0)
          .join("\n---\n"),
        SCRIPT_COMPRESS_OPTIONS.maxSummaryLength -
          header.length -
          note.length -
          SIGNATURE_RESERVE_CHARS,
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
      return lost ? { ...compressed, truncated: true } : compressed;
    },
  };
}
