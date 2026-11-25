import type {
  PingResult,
  StartSessionPayload,
  StartSessionResult,
} from "./protocol.js";
import { SidecarConnection } from "./transport.js";
import { Thread } from "./thread.js";
import type { ApprovalHandler } from "./thread.js";

export interface AtomicAgentOptions {
  /**
   * The sidecar entry to run. Defaults to `atomic-agent-sidecar`, the bin
   * the npm package installs. A path ending in `.js` / `.mjs` (a source
   * checkout's `dist/sidecar/main.js`) is run with the current Node.
   */
  binary?: string;
  /** Extra arguments for the sidecar process. */
  args?: string[];
  /** Working directory of the process, and the default for `startThread`. */
  cwd?: string;
  /** Added on top of `process.env` (for example `ATOMIC_AGENT_STATE_DIR`). */
  env?: Record<string, string | undefined>;
  /**
   * Answers the agent's approval prompts (shell commands, file writes,
   * `ask_user` questions). Without it every prompt is denied, so a run
   * never hangs waiting for an answer nobody can give.
   */
  onApprovalRequest?: ApprovalHandler;
}

export interface StartThreadOptions {
  /** Directory the agent works in. Defaults to `cwd`, then `process.cwd()`. */
  workingDir?: string;
  /** Free-form metadata stored with the session. */
  metadata?: Record<string, unknown>;
}

export const DEFAULT_SIDECAR_BINARY = "atomic-agent-sidecar";

/**
 * A typed client for the atomic-agent NDJSON sidecar.
 *
 * ```ts
 * const agent = new AtomicAgent();
 * const thread = await agent.startThread({ workingDir: "/path/to/repo" });
 * const { finalResponse } = await thread.run("Summarize the README");
 * await agent.close();
 * ```
 *
 * The process starts on the first call. It hosts one session at a time,
 * so `startThread()` replaces the previous thread.
 */
export class AtomicAgent {
  private readonly connection: SidecarConnection;
  private current: Thread | null = null;
  private closed = false;

  constructor(private readonly options: AtomicAgentOptions = {}) {
    this.connection = new SidecarConnection({
      binary: options.binary ?? DEFAULT_SIDECAR_BINARY,
      args: options.args ?? [],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
  }

  /** Liveness check: version, state directory and llama-server URL. */
  async ping(): Promise<PingResult> {
    this.ensureOpen();
    return this.connection.request<PingResult>("ping", {});
  }

  /** Start a new session. Any earlier thread of this agent stops being usable. */
  async startThread(options: StartThreadOptions = {}): Promise<Thread> {
    this.ensureOpen();
    const workingDir = options.workingDir ?? this.options.cwd ?? process.cwd();
    const payload: StartSessionPayload = {
      workingDir,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    const { sessionId } = await this.connection.request<StartSessionResult>(
      "start_session",
      payload,
    );
    const thread = new Thread(sessionId, workingDir, {
      connection: this.connection,
      onApprovalRequest: this.options.onApprovalRequest,
      isCurrent: (t) => this.current === t,
      ensureOpen: () => this.ensureOpen(),
    });
    this.current = thread;
    return thread;
  }

  /**
   * Shut the session down (`shutdown`) and stop the process. Safe to call
   * more than once; the agent cannot be used afterwards.
   */
  async close(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.current = null;
    if (!this.connection.isRunning) return;
    try {
      await withTimeout(this.connection.request("shutdown", {}), timeoutMs);
    } catch {
      // Already gone, or too slow: closing stdin below still stops it.
    }
    await this.connection.close(timeoutMs);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("AtomicAgent is closed");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
