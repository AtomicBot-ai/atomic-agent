import { render } from "ink";
import React from "react";
import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import {
  LocalModelsConfigWizard,
  type LocalModelsWizardOutcome,
} from "./components/local-models-config-wizard.js";

export type LocalModelsStartupGateResult =
  | "ok"
  | "aborted"
  | "saved_managed";

/**
 * When llama-server is down at TUI startup, run a small Ink wizard so the
 * user can fix `llama.url` in config without leaving the terminal. Skipped
 * entirely when `ATOMIC_AGENT_TUI_SKIP_LLAMA_SETUP=1` or when health already
 * passes.
 *
 * The wizard only reports what the user chose — it never imposes a UI mode
 * on the main TUI. The main TUI always lands in chat mode with the splash
 * banner; managed-mode users see daemon health in the footer indicator and
 * can open the Models tab explicitly with `/models` when they need it.
 */
export async function runLocalModelsStartupGateIfNeeded(options: {
  skipWizard: boolean;
}): Promise<LocalModelsStartupGateResult> {
  if (options.skipWizard) return "ok";
  const probe = await checkLlamaServer({ retries: 0, backoffMs: 0 });
  if (probe.reachable) return "ok";

  process.stderr.write(
    `[atomic-agent] local-llm unreachable at ${getConfig().localModels.url} — starting setup…\n`,
  );

  const outcome = { value: "skipped" as LocalModelsWizardOutcome };
  const ink = render(
    React.createElement(LocalModelsConfigWizard, {
      initialUrl: getConfig().localModels.url,
      probeError: probe.error,
      onFinished: (o) => {
        outcome.value = o;
      },
    }),
    { stdout: process.stdout, stderr: process.stderr, exitOnCtrlC: false },
  );
  await ink.waitUntilExit();
  ink.clear();

  if (outcome.value === "aborted") return "aborted";
  if (outcome.value === "saved_managed") return "saved_managed";
  return "ok";
}
