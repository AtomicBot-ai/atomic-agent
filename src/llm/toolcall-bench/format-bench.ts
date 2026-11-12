import type { ModelAnswer } from "./ask-many-models.js";
import type { ModelBenchResult } from "./run-toolcall-bench.js";

function percent(part: number, whole: number): string {
  if (whole === 0) return "-";
  return `${Math.round((part / whole) * 100)}%`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * The bench as a plain table, one row per model: share of tries with
 * valid JSON arguments, the right tool, and every required argument, then
 * the raw failure counts and the mean time of a try.
 */
export function formatBenchTable(results: readonly ModelBenchResult[]): string {
  const header = ["model", "tries", "json", "tool", "args", "parse", "no call", "errors", "avg ms"];
  const rows = results.map((r) => [
    r.model,
    String(r.tries),
    percent(r.validJson, r.tries),
    percent(r.rightTool, r.tries),
    percent(r.argsOk, r.tries),
    String(r.parseFailures),
    String(r.noCall),
    String(r.errors),
    String(r.avgMs),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, i) => pad(cell, widths[i]!)).join("  ").trimEnd();
  const notes = results
    .filter((r) => r.firstError)
    .map((r) => `${r.model}: ${r.firstError}`);
  const weak = results.flatMap((r) => {
    const perCase = r.tries / Math.max(1, Object.keys(r.okByCase).length);
    const missed = Object.entries(r.okByCase)
      .filter(([, ok]) => ok < perCase)
      .map(([id, ok]) => `${id} ${ok}/${perCase}`);
    return missed.length > 0 ? [`${r.model} missed: ${missed.join(", ")}`] : [];
  });
  return [
    line(header),
    ...rows.map(line),
    ...(weak.length > 0 ? ["", ...weak] : []),
    ...(notes.length > 0 ? ["", "first error per model:", ...notes] : []),
  ].join("\n") + "\n";
}

/** Answers one after another, each under its model's name. */
export function formatAnswers(answers: readonly ModelAnswer[]): string {
  return answers
    .map((a) => {
      const title = `== ${a.model} (${a.ms} ms) ==`;
      const body = a.error !== undefined ? `error: ${a.error}` : (a.text ?? "").trim() || "(empty answer)";
      return `${title}\n${body}`;
    })
    .join("\n\n") + "\n";
}
