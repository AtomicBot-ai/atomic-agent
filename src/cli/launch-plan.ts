/**
 * The env and args `atag launch` gives a CLI (launch-command.ts), and the
 * masked shell lines `--print-env` shows for them.
 */

import { DEFAULT_LAUNCH_MODEL, type LaunchIntegration, type LaunchPlan } from "./launch-integrations.js";
import type { LaunchArgs } from "./launch-args.js";

export const MASKED = "<hidden: atag launch --print-key>";

/** Model label for the bare local model when the server names none. */
export const LOCAL_MODEL_FALLBACK_NAME = "local-model";

/** Shell-style lines for `--print-env`, secrets masked (by name in env, by value in args). */
export function formatPrintEnv(binary: string, plan: LaunchPlan): string {
  const quote = (v: string): string => (/^[\w@%+=:,./-]*$/.test(v) && v !== "" ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  const secrets = new Set(plan.secretArgs ?? []);
  const arg = (v: string): string => quote(secrets.has(v) ? MASKED : v);
  const lines = Object.entries(plan.env).map(([name, value]) =>
    plan.secretEnv.includes(name) ? `export ${name}=${quote(MASKED)}` : `export ${name}=${quote(value)}`,
  );
  for (const step of plan.setup ?? []) lines.push([binary, ...step].map(arg).join(" "));
  lines.push([binary, ...plan.args].map(arg).join(" "));
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
