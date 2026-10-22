/**
 * ATO-767 — wires the automatic agent restart (agent-auto-restart.ts) to the
 * app: AgentClient's unexpected exits, deliberate stops and connects; the
 * window (`agent:autoRestart`); analytics (`agent_restarted` with trigger
 * `auto`); and error reports (the `auto_restart_attempt` tag on the next
 * unexpected exit).
 */

import { AgentAutoRestart, AUTO_RESTART_DELAYS_MS, hostAutoRestart } from "./agent-auto-restart.js";
import type { AgentClient } from "./agent-client.js";
import * as A from "./analytics/index.js";
import { setSourceTags } from "./sentry/index.js";

export interface AutoRestartHost {
  /** To the window. */
  send: (channel: string, payload: unknown) => void;
  /** A line for the Diagnostics pane and agent.log. */
  say: (line: string) => void;
  /** Off in a smoke run, whose checks end agents on purpose. */
  armed: boolean;
}

export function wireAgentAutoRestart(client: AgentClient, host: AutoRestartHost): AgentAutoRestart {
  const tagAttempt = (n: number) => setSourceTags("agent-exit", { auto_restart_attempt: n });
  tagAttempt(0);
  const restarter = new AgentAutoRestart({
    start: (attempt) => {
      // The agent this attempt brings up reports its exit as started by it.
      tagAttempt(attempt);
      A.agentRestarting("auto");
      return client.start();
    },
    notify: (notice) => {
      if (notice.kind === "reset") tagAttempt(0);
      else if (notice.kind === "scheduled") {
        host.say(`[desktop] the agent exited unexpectedly; restarting it in ${notice.delayMs / 1000} s (attempt ${notice.attempt} of ${AUTO_RESTART_DELAYS_MS.length})`);
      } else if (notice.kind === "restarted") {
        host.say(`[desktop] the agent is running again after an automatic restart (attempt ${notice.attempt})`);
      } else if (notice.kind === "gave_up") {
        host.say(`[desktop] the agent exited unexpectedly again after ${notice.attempts} automatic restarts; not restarting it until asked`);
      }
      host.send("agent:autoRestart", notice);
    },
  });
  restarter.arm(host.armed);
  client.on("unexpected-exit", (detail: { phase?: string } | undefined) => {
    restarter.exited(detail?.phase);
  });
  // Quit, a folder change, a model switch, Restart Agent Runtime: whoever stopped it starts it.
  client.on("stop-requested", () => restarter.cancel());
  client.on("status", (status: { state?: string } | undefined) => {
    if (status?.state === "connected") restarter.connected();
  });
  hostAutoRestart(restarter);
  return restarter;
}
