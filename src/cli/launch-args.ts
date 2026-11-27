/**
 * The command line of `atag launch` (ATO-2172): its help and its parser.
 */

import { findLaunchIntegration, LAUNCH_INTEGRATIONS, type LaunchIntegration } from "./launch-integrations.js";

/**
 * What the launched CLI talks to (ATO-2447).
 *
 * - `local`: the bare local model through serve's `/local/v1` routes; the
 *   CLI sends its own tools and runs them itself. The default, as in
 *   `ollama launch`.
 * - `agent`: an Atomic Agent turn through `/v1/messages`, `/v1/responses`
 *   and `/v1/chat/completions`; the agent answers with its own tools and
 *   memory, the CLI is a chat window onto it (the first slice, `--agent`).
 */
export type LaunchMode = "local" | "agent";

export const LAUNCH_HELP = [
  "Usage: atomic-agent launch [<agent>] [--agent] [--model <id>] [--print-env] [-- <agent args>]",
  "",
  "Start another coding CLI on this machine's local model, through `atag serve`",
  "(a running one is reused, else one is started for this run and stopped after).",
  "",
  "Agents:",
  ...LAUNCH_INTEGRATIONS.map((i) => `  ${i.id.padEnd(9)} ${i.displayName} (${i.installHint})`),
  "",
  "Options:",
  "  --agent        Talk to Atomic Agent instead of the bare model: the agent answers with its",
  "                 own tools and memory, and the CLI's own tool calls are not offered to the model.",
  "  --model <id>   Model name the CLI sends (default: the loaded local model; atomic-agent with --agent)",
  "  --print-env    Print the environment and command instead of running it (keys masked)",
  "  -- <args>      Passed to the agent unchanged, e.g. atag launch codex -- exec \"fix the tests\"",
  "",
  "By default the CLI gets the local model itself (/local/v1 on serve), sends its own tools and",
  "runs them in this folder, as with `ollama launch`. Start the model first: atag models start.",
  "",
  "With --agent, approvals: a serve started here refuses every approval prompt at once (the CLI",
  "cannot show one), so the turn answers in text; a reused serve asks in its /panel page.",
  "",
  "Without an agent name, lists the CLIs above (installed or not) and, in a terminal, asks which to start.",
].join("\n");

export interface LaunchArgs {
  /** `null`: no agent named, so `atag launch` lists them and asks (ATO-2737). */
  readonly integration: LaunchIntegration | null;
  readonly mode: LaunchMode;
  readonly model: string | null;
  readonly printEnv: boolean;
  readonly extraArgs: readonly string[];
}

export function parseLaunchArgs(args: readonly string[]): LaunchArgs | { error: string } | "help" {
  const dash = args.indexOf("--");
  const own = dash === -1 ? args : args.slice(0, dash);
  const extraArgs = dash === -1 ? [] : args.slice(dash + 1);
  let name: string | undefined;
  let model: string | null = null;
  let printEnv = false;
  let mode: LaunchMode = "local";
  for (let i = 0; i < own.length; i++) {
    const arg = own[i] as string;
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--print-env") printEnv = true;
    else if (arg === "--agent") mode = "agent";
    else if (arg === "--model") {
      const value = own[i + 1];
      if (!value || value.startsWith("-")) return { error: "--model expects a model id" };
      model = value;
      i++;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      if (!model) return { error: "--model expects a model id" };
    } else if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
    else if (name === undefined) name = arg;
    else return { error: `unexpected argument ${arg} (put the agent's own arguments after --)` };
  }
  if (!name) return { integration: null, mode, model, printEnv, extraArgs };
  const integration = findLaunchIntegration(name);
  if (!integration) {
    return { error: `unknown agent ${name} (one of: ${LAUNCH_INTEGRATIONS.map((i) => i.id).join(", ")})` };
  }
  return { integration, mode, model, printEnv, extraArgs };
}
