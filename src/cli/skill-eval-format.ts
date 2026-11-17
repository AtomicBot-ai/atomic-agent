import type { SkillEvalResult } from "../skills/eval/index.js";
import { SKILL_EVAL_VARIANTS } from "../skills/eval/index.js";

/** The plain-text table `skill eval` prints: one row per variant, then the difference. */
export function formatSkillEvalSummary(result: SkillEvalResult): string {
  const lines = [`skill eval: ${result.skill.name} (${result.tasks.count} tasks, model ${result.model.model ?? "?"})`];
  lines.push("variant   accuracy   mean time   tokens      cost");
  for (const variant of SKILL_EVAL_VARIANTS) {
    const s = result.summary[variant];
    if (!s) continue;
    lines.push(
      [
        variant.padEnd(9),
        `${s.passed}/${s.runs} ${pct(s.accuracy)}`.padEnd(10),
        `${(s.wallMsMean / 1000).toFixed(1)}s`.padEnd(11),
        (s.totalTokens === null ? "-" : String(s.totalTokens)).padEnd(11),
        s.costUsd === null ? "-" : `$${s.costUsd.toFixed(4)}`,
        ...(s.judgeScoreMean === null ? [] : [` judge ${s.judgeScoreMean.toFixed(1)}/5`]),
      ].join(" "),
    );
  }
  const d = result.summary.delta;
  if (d) {
    lines.push(
      `difference: accuracy ${signed(Math.round(d.accuracy * 100))} pts, time ${signed(Number((d.wallMsMean / 1000).toFixed(1)))}s, ` +
        `tokens ${d.totalTokens === null ? "-" : signed(d.totalTokens)}, cost ${d.costUsd === null ? "-" : `${d.costUsd < 0 ? "-" : "+"}$${Math.abs(d.costUsd).toFixed(4)}`}` +
        (d.judgeScoreMean === null ? "" : `, judge ${signed(Number(d.judgeScoreMean.toFixed(1)))}`),
    );
  }
  const ju = result.judgeUsage;
  if (result.judge && ju) {
    // Eval overhead, kept off the variant rows: the judge grades both sides.
    lines.push(
      `judge: ${ju.totalTokens === null ? "-" : ju.totalTokens} tokens, ${ju.costUsd === null ? "-" : `$${ju.costUsd.toFixed(4)}`}` +
        ` (${ju.calls} call${ju.calls === 1 ? "" : "s"}, ${result.judge.provider ?? result.judge.url ?? "?"}${result.judge.model ? ` ${result.judge.model}` : ""})`,
    );
  }
  if (!result.complete) lines.push("stopped early: not every planned run finished");
  return `${lines.join("\n")}\n`;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** `--all`: one line per skill, accuracy with and without and the difference in points. */
export function formatSkillEvalOverview(results: readonly SkillEvalResult[], missing: readonly string[]): string {
  const lines = ["", "skill lab overview (accuracy with / without, difference)"];
  for (const r of results) {
    const w = r.summary.with;
    const wo = r.summary.without;
    const d = r.summary.delta;
    lines.push(
      `${r.skill.name.padEnd(16)} ${w ? `${w.passed}/${w.runs}` : "-"} / ${wo ? `${wo.passed}/${wo.runs}` : "-"}` +
        `${d ? `  ${signed(Math.round(d.accuracy * 100))} pts` : ""}${r.complete ? "" : "  (stopped early)"}`,
    );
  }
  for (const name of missing) lines.push(`${name.padEnd(16)} not installed, skipped`);
  return `${lines.join("\n")}\n`;
}
