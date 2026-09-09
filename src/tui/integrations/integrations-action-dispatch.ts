import {
  GITHUB_INTEGRATION_ID,
  GITHUB_TEST_ACTION,
  GITHUB_TOKEN_ENV,
  testGithubToken,
  type FetchLike,
  type IntegrationProbeResult,
} from "../../integrations/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";

/** The slice of `TuiTelegramOrchestrator` the hub drives. */
export interface TelegramActions {
  startPairing(timeoutMs?: number): Promise<void>;
  restart(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  /** Push a token the hub has just written into the live channel. */
  adoptToken(): Promise<void>;
  /** Bring the channel up, or throw the channel's own reason. */
  ensureUpForPairing(): Promise<void>;
}

export interface ActionDispatchDeps {
  runtime: Pick<AgentRuntime, "discordChannel">;
  telegram?: TelegramActions;
  /**
   * Probe outcomes the hub keeps for the life of the process, keyed by
   * integration id. A `test` action writes here; `status()` reads it.
   */
  probes: Map<string, IntegrationProbeResult>;
  /** Environment the credential is read from. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; the real `fetch` otherwise. */
  fetchImpl?: FetchLike;
}

/**
 * Run one descriptor verb (pair, restart, test) and return the line the
 * hub shows when it settles. Throws with the operator-facing reason on
 * failure; the orchestrator turns that into a sticky error line.
 *
 * Extracted from the orchestrator so each integration's verbs sit next
 * to each other rather than growing that class — the orchestrator only
 * owns credential writes and live-runtime plumbing.
 */
export async function dispatchIntegrationAction(
  deps: ActionDispatchDeps,
  integrationId: string,
  actionId: string,
): Promise<string> {
  if (integrationId === "telegram") {
    if (!deps.telegram) throw new Error("Telegram controls unavailable");
    if (actionId === "pair") {
      // A pairing window only claims a DM while the poller is
      // running, so start the channel first and let a failure
      // surface as this action's error. Announcing "DM your bot now"
      // in front of a channel that never came up is how an operator
      // ends up messaging a bot nothing is listening to.
      await deps.telegram.ensureUpForPairing();
      // Fire-and-forget from here: the window runs for its full
      // timeout and the outcome lands through the channel's own
      // status stream, so awaiting it would freeze the pane for a
      // minute.
      void deps.telegram.startPairing();
      return "Pairing — DM your bot now; the next sender becomes the owner.";
    }
    if (actionId === "restart") {
      await deps.telegram.restart();
      return "Telegram channel restarted";
    }
  }
  if (integrationId === "discord" && actionId === "restart") {
    const channel = deps.runtime.discordChannel;
    if (!channel) throw new Error("Discord channel unavailable");
    await channel.stop();
    await channel.start();
    return "Discord channel restarted";
  }
  if (integrationId === GITHUB_INTEGRATION_ID && actionId === GITHUB_TEST_ACTION) {
    return runGithubProbe(deps);
  }
  throw new Error(`unknown action ${actionId} for ${integrationId}`);
}

async function runGithubProbe(deps: ActionDispatchDeps): Promise<string> {
  const token = (deps.env ?? process.env)[GITHUB_TOKEN_ENV]?.trim();
  if (!token) {
    deps.probes.delete(GITHUB_INTEGRATION_ID);
    throw new Error("no GitHub token saved");
  }
  const outcome = await testGithubToken(token, deps.fetchImpl);
  if (outcome.ok) {
    deps.probes.set(GITHUB_INTEGRATION_ID, { ok: true, detail: outcome.login });
    return `GitHub: token works — connected as ${outcome.login}`;
  }
  deps.probes.set(GITHUB_INTEGRATION_ID, { ok: false, detail: outcome.detail });
  throw new Error(`GitHub: ${outcome.detail}`);
}
