/**
 * Where a monitor's notice goes (ATO-2436). A monitored job printed a
 * matching line after the turn that set the monitor; the session has to
 * hear it even when nothing is running on it.
 *
 * Delivery order:
 *  1. A frontend that shows this session now (the TUI's open chat):
 *     it steers its running turn or starts the next one through its own
 *     `runtime.runTurn` path, so the person watches it happen.
 *  2. The runtime's fallback (`runtime-shell-monitor-wake.ts`): steer
 *     the turn running on the session, else file a task for it, the
 *     path heartbeats and file triggers take. Both end in the session's
 *     `TurnController` FIFO, never in a second concurrent turn.
 *
 * Nothing here starts a turn itself. `false` means nobody took it; the
 * monitor keeps the lines and offers them again later.
 */

/** One delivery: the text the agent reads, and what a frontend may show. */
export interface MonitorWake {
  readonly sessionId: string;
  readonly jobId: number;
  /** Head of the job's command line. */
  readonly command: string;
  /** How many lines matched since the last delivery. */
  readonly lineCount: number;
  /** The job exited on its own; this is the monitor's last notice. */
  readonly exited: boolean;
  /** The whole notice, as the agent gets it. */
  readonly text: string;
}

/** `true` when it took the notice (steered, queued or started a turn). */
export type MonitorWakeHandler = (wake: MonitorWake) => boolean;

export class ShellMonitorWakeRouter {
  private readonly frontends = new Set<MonitorWakeHandler>();
  private fallback: MonitorWakeHandler | null = null;

  /** A frontend's handler, asked first. Returns its removal. */
  addFrontend(handler: MonitorWakeHandler): () => void {
    this.frontends.add(handler);
    return () => {
      this.frontends.delete(handler);
    };
  }

  /** The runtime's own path (steer or a queued task). One at a time. */
  setFallback(handler: MonitorWakeHandler | null): void {
    this.fallback = handler;
  }

  /** Whether anything could wake an idle session at all. */
  canWake(): boolean {
    return this.fallback !== null || this.frontends.size > 0;
  }

  deliver(wake: MonitorWake): boolean {
    for (const handler of [...this.frontends]) {
      if (safely(handler, wake)) return true;
    }
    return this.fallback !== null && safely(this.fallback, wake);
  }
}

/** A handler that throws took nothing; the monitor must keep going. */
function safely(handler: MonitorWakeHandler, wake: MonitorWake): boolean {
  try {
    return handler(wake);
  } catch {
    return false;
  }
}
