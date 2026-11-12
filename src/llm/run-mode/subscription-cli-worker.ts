import { SUBSCRIPTION_CLI_KIND } from "../../config/provider-auth-mode.js";
import { claudeCliAdapter } from "../provider/subscription-cli/claude-cli-adapter.js";
import { codexCliAdapter } from "../provider/subscription-cli/codex-cli-adapter.js";

/**
 * What Fusion does when the worker leg is a `subscription-cli` provider
 * (Codex, Claude Code) — ATO-1431.
 *
 * `"warn"` lets the switch go through and says what it costs; `"refuse"`
 * stops it with the same sentence. Warn until a repro shows the pairing
 * works or does not: this is the one line to flip.
 */
export const SUBSCRIPTION_CLI_WORKER_POLICY: "warn" | "refuse" = "warn";

/** The fields this check reads — a config entry or a providers-panel row. */
export type WorkerLegEntry = {
  kind: string;
  subscriptionCli?: { cli: string } | null;
};

export type SubscriptionCliWorkerNotice = {
  /** Whether the switch should still go ahead. */
  policy: "warn" | "refuse";
  /** The full sentence for the chat / notice line. */
  line: string;
  /** A compact form for the composer-switch detail column. */
  short: string;
};

/**
 * Whether the vendor CLI streams its output. A CLI that does not (Codex
 * today) hands back each worker's answer in one piece, so there is
 * nothing to watch or steer while it runs. Read from the shipped
 * descriptors rather than the runtime registry so this stays pure.
 */
function cliStreams(cli: string | undefined): boolean {
  if (cli === claudeCliAdapter.cli) return claudeCliAdapter.streamMode !== "none";
  if (cli === codexCliAdapter.cli) return codexCliAdapter.streamMode !== "none";
  // An unknown CLI: do not promise live progress we cannot vouch for.
  return false;
}

/**
 * The warning (or refusal) for a Fusion worker leg that runs on a
 * subscription CLI, or `null` for every other kind — local models and
 * API-key providers are unaffected.
 */
export function describeSubscriptionCliWorker(
  worker: WorkerLegEntry | undefined,
): SubscriptionCliWorkerNotice | null {
  if (worker?.kind !== SUBSCRIPTION_CLI_KIND) return null;
  const streams = cliStreams(worker.subscriptionCli?.cli ?? undefined);
  const line = streams
    ? "Workers on a subscription CLI: every task uses your subscription limit."
    : "Workers on a subscription CLI: every task uses your subscription limit, and there is no live progress.";
  const short = streams
    ? "workers use your subscription limit"
    : "workers use your subscription limit · no live progress";
  return { policy: SUBSCRIPTION_CLI_WORKER_POLICY, line, short };
}
