import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  AgentEvent,
  HostRequest,
  HostRequestType,
  SidecarMessage,
  SidecarResponse,
} from "./protocol.js";

/** A request the sidecar answered with `ok: false`. */
export class AtomicAgentError extends Error {
  readonly code: string | undefined;
  readonly requestType: HostRequestType;

  constructor(message: string, requestType: HostRequestType, code?: string) {
    super(message);
    this.name = "AtomicAgentError";
    this.code = code;
    this.requestType = requestType;
  }
}

/** The sidecar process could not start, or exited while work was pending. */
export class SidecarExitedError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last few KB the process wrote to stderr. */
  readonly stderr: string;

  constructor(
    message: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ) {
    super(stderr.trim() ? `${message}\n${stderr.trim()}` : message);
    this.name = "SidecarExitedError";
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

export interface SidecarConnectionOptions {
  /** Command to run. A `.js` / `.mjs` / `.cjs` path is run with the current Node. */
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

type EventListener = (event: AgentEvent) => void;

interface Pending {
  type: HostRequestType;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * One `atomic-agent-sidecar` child process and the NDJSON framing over its
 * stdin/stdout. Requests are matched to responses by `correlationId`;
 * every event is handed to the listeners. Mirrors the agent's own
 * `StdioProtocol` (src/sidecar/stdio-protocol.ts) from the host side.
 */
export class SidecarConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private stderrTail = "";
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<EventListener>();
  private exited: SidecarExitedError | null = null;
  private exitPromise: Promise<void> | null = null;

  constructor(private readonly options: SidecarConnectionOptions) {}

  get isRunning(): boolean {
    return this.child !== null && this.exited === null;
  }

  /** Spawn the process if it is not running yet. Idempotent. */
  start(): void {
    if (this.child) {
      if (this.exited) throw this.exited;
      return;
    }
    const { binary, args, cwd, env } = this.options;
    const runWithNode = /\.(c|m)?js$/i.test(binary);
    const command = runWithNode ? process.execPath : binary;
    const argv = runWithNode ? [binary, ...args] : args;
    const child = spawn(command, argv, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.ingest(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // The child can die between our write and its read; a stdin with no
    // `error` listener would turn that EPIPE into an uncaught exception.
    child.stdin.on("error", () => {});

    this.exitPromise = new Promise<void>((resolve) => {
      child.once("error", (err) => {
        const hint =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? ` (is "${binary}" installed and on PATH? pass { binary } to point at it)`
            : "";
        this.fail(
          new SidecarExitedError(
            `failed to start atomic-agent sidecar: ${err.message}${hint}`,
            null,
            null,
            this.stderrTail,
          ),
        );
        resolve();
      });
      child.once("exit", (code, signal) => {
        this.fail(
          new SidecarExitedError(
            `atomic-agent sidecar exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`,
            code,
            signal,
            this.stderrTail,
          ),
        );
        resolve();
      });
    });
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Send one request and resolve with the response payload. */
  request<TResult = unknown, TPayload = unknown>(
    type: HostRequestType,
    payload: TPayload,
  ): Promise<TResult> {
    this.start();
    if (this.exited) return Promise.reject(this.exited);
    const id = randomUUID();
    const message: HostRequest<HostRequestType, TPayload> = {
      kind: "request",
      id,
      type,
      payload,
    };
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        type,
        resolve: resolve as (payload: unknown) => void,
        reject,
      });
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  /**
   * Stop the process: close stdin (the sidecar exits on EOF once its work
   * is done), then SIGTERM and finally SIGKILL if it is still around.
   */
  async close(timeoutMs = 5000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin.end();
    if (await this.waitForExit(timeoutMs)) return;
    child.kill("SIGTERM");
    if (await this.waitForExit(timeoutMs)) return;
    child.kill("SIGKILL");
    await this.waitForExit(timeoutMs);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.exitPromise) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = await Promise.race([
      this.exitPromise.then(() => true as const),
      timeout,
    ]);
    clearTimeout(timer);
    return done;
  }

  private fail(error: SidecarExitedError): void {
    if (this.exited) return;
    this.exited = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: SidecarMessage;
    try {
      message = JSON.parse(line) as SidecarMessage;
    } catch {
      // Not a protocol frame (a stray console.log in the child). Skip it.
      return;
    }
    if (message.kind === "response") {
      this.handleResponse(message);
    } else if (message.kind === "event") {
      for (const listener of [...this.listeners]) listener(message as AgentEvent);
    }
  }

  private handleResponse(response: SidecarResponse): void {
    const pending = this.pending.get(response.correlationId);
    if (!pending) return;
    this.pending.delete(response.correlationId);
    if (response.ok) {
      pending.resolve(response.payload);
    } else {
      pending.reject(
        new AtomicAgentError(
          response.error?.message ?? `${pending.type} failed`,
          pending.type,
          response.error?.code,
        ),
      );
    }
  }
}
