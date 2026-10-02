/**
 * Launch, health and quit: `app_opened`, `app_ready`, `agent_start_failed`,
 * `agent_restarted`, `window_crashed`, `app_closed`.
 *
 * `prev_session_crashed` comes from desktop-analytics.json's `sessionOpen`
 * marker: set at launch, cleared on a clean quit — still set at the next
 * launch means the last session never reached its quit (crash, Force Quit,
 * power loss). The agent client's orphan reap is the same fact seen from
 * the agent's side and also counts when it lands before `app_opened`.
 */

import { flagsStore, refreshRunMode, shutdownAnalytics, track } from "./core.js";

/** Process start, as near as Node can tell. */
const PROCESS_START = Date.now() - Math.round(process.uptime() * 1000);

const L = {
  prevCrashed: false,
  orphanReaped: false,
  openedSent: false,
  windowAt: null as number | null,
  agentAt: null as number | null,
  agentFailed: false,
  backendUp: null as boolean | null,
  readySent: false,
  turns: 0,
  lastAgentStart: null as number | null,
  restartTrigger: null as "manual" | "switch" | "other" | null,
  connectedOnce: false,
  closedSent: false,
};

/** Before the first window: read last session's marker, set this one's. */
export function beginSession(): void {
  try {
    const store = flagsStore();
    if (!store) return;
    L.prevCrashed = store.get().sessionOpen === true;
    store.set({ sessionOpen: true });
  } catch {
    /* never */
  }
}

export function noteOrphanReaped(): void {
  L.orphanReaped = true;
}

export function appOpened(kind: "cold" | "reopen", freshState: boolean): void {
  if (kind === "cold") {
    if (L.openedSent) return;
    L.openedSent = true;
  }
  refreshRunMode();
  track("app_opened", {
    launch_kind: kind,
    fresh_state: freshState,
    prev_session_crashed: kind === "cold" && (L.prevCrashed || L.orphanReaped),
  });
}

export function windowShown(): void {
  if (L.windowAt === null) L.windowAt = Date.now();
  maybeReady();
}

/** How the launch-time local backend check ended: true = a model server is up (or none was needed). */
export function launchBackendSettled(up: boolean): void {
  if (L.backendUp === null) L.backendUp = up;
  maybeReady();
}

function maybeReady(): void {
  if (L.readySent || L.windowAt === null || L.backendUp === null) return;
  if (L.agentAt === null && !L.agentFailed) return;
  L.readySent = true;
  track("app_ready", {
    ms_to_window: L.windowAt - PROCESS_START,
    ms_to_agent: L.agentAt === null ? null : L.agentAt - PROCESS_START,
    backend_up_at_launch: L.backendUp,
  });
}

/** `agent:restart` (manual) or a switch's restart, said just before the stop+start. */
export function agentRestarting(trigger: "manual" | "switch" | "other"): void {
  L.restartTrigger = trigger;
}

/** Every AgentClient status: the restart's trigger, the first connect, a missing binary. */
export function agentStatus(status: { state?: string }): void {
  try {
    const now = Date.now();
    if (status.state === "starting") {
      L.lastAgentStart = now;
      if (L.restartTrigger) {
        track("agent_restarted", { trigger: L.restartTrigger });
        L.restartTrigger = null;
      }
    } else if (status.state === "connected" && !L.connectedOnce) {
      L.connectedOnce = true;
      L.agentAt = now;
      maybeReady();
    } else if (status.state === "missing-binary") {
      agentStartFailed({ reason: "missing_binary" });
    }
  } catch {
    /* never */
  }
}

/** AgentClient's `start-failed`: the child exited while starting, or never answered /health. */
export function agentStartFailed(detail: { reason?: string; exitCode?: number | null; signal?: string | null }): void {
  try {
    track("agent_start_failed", {
      reason: detail.reason ?? "other",
      exit_code: detail.exitCode ?? null,
      signal: detail.signal ?? null,
      ms: L.lastAgentStart === null ? 0 : Date.now() - L.lastAgentStart,
    });
    if (!L.connectedOnce) {
      L.agentFailed = true;
      maybeReady();
    }
  } catch {
    /* never */
  }
}

export function turnEnded(): void {
  L.turns += 1;
}

export function windowCrashed(kind: "gone" | "unresponsive", reason: string | null, exitCode: number | null): void {
  track("window_crashed", { kind, reason, exit_code: exitCode });
}

/** The quit: `app_closed`, the clean-quit marker, and a bounded last flush. */
export async function appClosing(timeoutMs = 2_000): Promise<void> {
  try {
    if (!L.closedSent) {
      L.closedSent = true;
      track("app_closed", {
        session_minutes: (Date.now() - PROCESS_START) / 60_000,
        turns_in_session: L.turns,
      });
      flagsStore()?.set({ sessionOpen: false });
    }
    await shutdownAnalytics(timeoutMs);
  } catch {
    /* quitting wins */
  }
}
