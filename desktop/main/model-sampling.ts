/**
 * ATO-2482: the pure half of Settings › Models › Sampling. main runs
 * `atag models sampling <id> --json` (read), `--set <json>` (write the
 * person's set) or `--reset` (back to the model's default); this file
 * builds those arguments and reads the answer. model-sampling-ipc.ts
 * wires it; renderer/model-sampling.js draws it.
 */

import { plainCliError, type CliResult } from "./agent-cli.js";

/** A catalog or added model id (`qwen-3.5-4b`, `custom-unsloth-…`). */
const MODEL_ID_RE = /^[A-Za-z0-9][\w.-]{0,199}$/;

export interface SamplingAnswer {
  ok: boolean;
  /** What the agent printed with `--json` (src/cli/models-sampling-format.ts SamplingReport). */
  report?: Record<string, unknown>;
  /** The agent is older than the subcommand. */
  older?: boolean;
  error?: string;
}

export function samplingArgs(id: string, set?: Record<string, unknown> | null): string[] | null {
  if (!MODEL_ID_RE.test(id)) return null;
  const base = ["models", "sampling", id];
  if (set === undefined) return [...base, "--json"];
  if (set === null) return [...base, "--reset", "--json"];
  return [...base, "--set", JSON.stringify(set), "--json"];
}

/** The last JSON object line of stdout, or null. */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // not this line
    }
  }
  return null;
}

export function samplingAnswerFrom(res: CliResult): SamplingAnswer {
  if (res.ok) {
    const report = lastJsonObject(res.stdout);
    return report && typeof report.id === "string"
      ? { ok: true, report }
      : { ok: false, error: "The agent's answer could not be read." };
  }
  const said = plainCliError(res.stderr || "") || res.error || "";
  if (/unknown subcommand: sampling/.test(said)) return { ok: false, older: true };
  // The agent's own line is "models sampling: <why>"; the usage text under it is noise here.
  const first = said.split("\n").find((l) => l.trim() !== "") ?? "";
  return { ok: false, error: first.replace(/^models sampling:\s*/, "") || "The agent did not answer." };
}
