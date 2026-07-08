import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SidecarSpawnSpec } from "./sidecar-locator.js";
import type {
  RequestType,
  SidecarEvent,
  SidecarMessage,
  SidecarResponse,
} from "@agent/sidecar/index.js";

function isSidecarResponse(msg: SidecarMessage): msg is SidecarResponse {
  return msg.kind === "response";
}

function isSidecarEvent(msg: SidecarMessage): msg is SidecarEvent {
  return msg.kind === "event";
}

interface PendingRequest {
  resolve: (response: SidecarResponse) => void;
  reject: (error: Error) => void;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const READY_PING_INTERVAL_MS = 500;
const READY_PING_TIMEOUT_MS = 120_000;

/**
 * Spawns the atomic-agent sidecar and speaks NDJSON over stdin/stdout.
 * Responses are correlated by HostRequest.id === SidecarResponse.correlationId.
 */
export class SidecarClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private started = false;

  constructor(private readonly spawnSpec: SidecarSpawnSpec) {
    super();
  }

  isRunning(): boolean {
    return this.started && this.child !== null;
  }

  async start(): Promise<void> {
    if (this.started) return;

    const { command, args, cwd, env } = this.spawnSpec;
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.ingest(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[sidecar] ${chunk}`);
    });
    this.child.on("exit", (code, signal) => {
      this.started = false;
      this.child = null;
      const reason =
        signal !== null
          ? `sidecar exited via signal ${signal}`
          : `sidecar exited with code ${String(code)}`;
      this.rejectAllPending(new Error(reason));
      this.emit("exit", code, signal);
    });

    this.started = true;
    await this.waitUntilReady();
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + READY_PING_TIMEOUT_MS;
    let lastError = "sidecar not ready";

    while (Date.now() < deadline) {
      try {
        const response = await this.request("ping", {});
        if (response.ok) return;
        lastError = response.error?.message ?? "ping returned ok:false";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, READY_PING_INTERVAL_MS);
      });
    }

    throw new Error(`sidecar failed to become ready: ${lastError}`);
  }

  async request<TPayload>(
    type: RequestType,
    payload: TPayload,
  ): Promise<SidecarResponse> {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new Error("sidecar is not running");
    }

    const id = randomUUID();
    const frame = JSON.stringify({
      kind: "request",
      id,
      type,
      payload,
    });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${frame}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;

    try {
      await Promise.race([
        this.request("shutdown", {}),
        new Promise<void>((resolve) => {
          setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // sidecar may already be exiting
    }

    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.started = false;
    this.child = null;
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: SidecarMessage;
    try {
      message = JSON.parse(line) as SidecarMessage;
    } catch (err) {
      this.emit(
        "parse-error",
        err instanceof Error ? err : new Error(String(err)),
        line,
      );
      return;
    }

    if (isSidecarResponse(message)) {
      const pending = this.pending.get(message.correlationId);
      if (pending) {
        this.pending.delete(message.correlationId);
        pending.resolve(message);
      }
      return;
    }

    if (isSidecarEvent(message)) {
      this.emit("event", message as SidecarEvent);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
