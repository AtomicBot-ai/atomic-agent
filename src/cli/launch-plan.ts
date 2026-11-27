/**
 * The env and args `atag launch` gives a CLI (launch-command.ts), and the
 * masked shell lines `--print-env` shows for them.
 */

import { DEFAULT_LAUNCH_MODEL, type LaunchIntegration, type LaunchPlan } from "./launch-integrations.js";
import type { LaunchArgs } from "./launch-args.js";
import { formatCommandLine, formatEnvLine, type PrintEnvShell } from "./print-env-format.js";

export const MASKED = "<hidden: atag launch --print-key>";

/** Model label for the bare local model when the server names none. */
export const LOCAL_MODEL_FALLBACK_NAME = "local-model";

/**
 * Lines for `--print-env` in `shell`'s syntax (print-env-format.ts,
 * ATO-2758), secrets masked by name in env and by value in args, before
 * any quoting.
 */
export function formatPrintEnv(binary: string, plan: LaunchPlan, shell: PrintEnvShell = "posix"): string {
  const secrets = new Set([
    ...(plan.secretArgs ?? []),
    ...plan.secretEnv.map((name) => plan.env[name]).filter((v): v is string => typeof v === "string" && v !== ""),
  ]);
  const masked = (args: readonly string[]): string[] => args.map((v) => (secrets.has(v) ? MASKED : v));
  const lines = Object.entries(plan.env).map(([name, value]) =>
    formatEnvLine(shell, name, plan.secretEnv.includes(name) ? MASKED : value),
  );
  for (const step of plan.setup ?? []) lines.push(formatCommandLine(shell, binary, masked(step)));
  lines.push(formatCommandLine(shell, binary, masked(plan.args)));
  return `${lines.join("\n")}\n`;
}

/**
 * The CLI's env and args. Local mode points it at `<serve>/local` and
 * names the loaded model (the person's `--model` wins); agent mode at
 * the serve root with the `atomic-agent` label.
 */
export function buildPlan(
  integration: LaunchIntegration,
  parsed: Pick<LaunchArgs, "mode" | "model" | "extraArgs">,
  serveUrl: string,
  token: string,
  localModelId: string | null,
): LaunchPlan {
  if (parsed.mode === "agent") {
    return integration.build({
      baseUrl: serveUrl,
      token,
      model: parsed.model ?? DEFAULT_LAUNCH_MODEL,
      modelGiven: parsed.model !== null,
      extraArgs: parsed.extraArgs,
    });
  }
  return integration.build({
    baseUrl: `${serveUrl}/local`,
    token,
    model: parsed.model ?? localModelId ?? LOCAL_MODEL_FALLBACK_NAME,
    // Name the real model even without --model, so the CLI shows it and
    // does not ask the local server for a cloud model id.
    modelGiven: true,
    extraArgs: parsed.extraArgs,
  });
}
