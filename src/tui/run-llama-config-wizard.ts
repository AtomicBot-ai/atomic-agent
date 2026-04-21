import { render } from "ink";
import React from "react";
import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import {
  LlamaConfigWizard,
  type LlamaWizardOutcome,
} from "./components/llama-config-wizard.js";

export type LlamaStartupGateResult = "ok" | "aborted";

/**
 * When llama-server is down at TUI startup, run a small Ink wizard so the
 * user can fix `llama.url` in config without leaving the terminal. Skipped
 * entirely when `ATOMIC_AGENT_TUI_SKIP_LLAMA_SETUP=1` or when health already
 * passes.
 */
export async function runLlamaStartupGateIfNeeded(options: {
  skipWizard: boolean;
}): Promise<LlamaStartupGateResult> {
  if (options.skipWizard) return "ok";
  const probe = await checkLlamaServer({ retries: 0, backoffMs: 0 });
  if (probe.reachable) return "ok";

  process.stderr.write(
    `[atomic-agent] llama-server unreachable at ${getConfig().llama.url} — starting setup…\n`,
  );

  const outcome = { value: "skipped" as LlamaWizardOutcome };
  const ink = render(
    React.createElement(LlamaConfigWizard, {
      initialUrl: getConfig().llama.url,
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
  return "ok";
}
