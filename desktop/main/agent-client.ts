import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Supervises one `atag serve` child process and speaks to it over the
 * loopback HTTP API.
 *
 * Why HTTP and not the NDJSON sidecar: the sidecar entry point
 * (`dist/sidecar/main.js`) only exists in a source checkout, while the
 * shipped single-file binary exposes `serve`. A desktop app has to work
 * against the thing users actually installed, so the desktop client
 * drives the same surface the CLI documents:
 *
 *   GET  /health                    liveness + llama-server reachability
 *   GET  /api/capabilities          paths, tool inventory, agent config
 *   GET  /api/config                the user config file, verbatim
 *   GET  /api/skills                installed skills
 *   GET  /api/tasks                 durable tasks
 *   GET  /api/sessions              persisted sessions
 *   GET  /v1/models                 OpenAI-compatible model list
 *   POST /v1/chat/completions       the agent loop, streamed as SSE
 *   GET  /api/events                SSE stream of approval requests
 *   POST /api/approval/resolve      allow-once | deny
 *
 * The server is bound to 127.0.0.1 on an ephemeral port and gated by a
 * bearer token generated per launch, so nothing outside this app can
 * reach the agent.
 */

export type AgentState =
  | "stopped"
  | "starting"
  | "connected"
  | "missing-binary"
  | "error";

export interface AgentStatus {
  state: AgentState;
  binary: string | null;
  port: number | null;
  workingDir: string;
  llama: { url: string; reachable: boolean } | null;
  error: string | null;
}

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 300;

/** Where a released install puts the binary, in order of preference. */
function candidateBinaries(): string[] {
  const fromEnv = process.env.ATOMIC_AGENT_BIN;
  const home = homedir();
  return [
    ...(fromEnv ? [fromEnv] : []),
    join(home, ".local", "bin", "atag"),
    join(home, ".local", "bin", "atomic-agent"),
    "/usr/local/bin/atag",
    "/opt/homebrew/bin/atag",
  ];
}

export function resolveBinary(): string | null {
  for (const candidate of candidateBinaries()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AgentClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private token = "";
  private events: AbortController | null = null;
  private turns = new Map<string, AbortController>();
  private stopping = false;

  status: AgentStatus = {
    state: "stopped",
    binary: null,
    port: null,
    workingDir: process.env.HOME ?? "/",
    llama: null,
    error: null,
  };

  constructor(workingDir: string) {
    super();
    this.status.workingDir = workingDir;
  }

  private setStatus(patch: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  private base(): string {
    if (!this.port) throw new Error("agent is not running");
    return `http://127.0.0.1:${this.port}`;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
  }

  async start(): Promise<AgentStatus> {
    if (this.child) return this.status;

    const binary = resolveBinary();
    if (!binary) {
      this.setStatus({
        state: "missing-binary",
        binary: null,
        error:
          "No atomic-agent binary found. Install it with `curl -fsSL https://atomicagent.io/install | sh`, or set ATOMIC_AGENT_BIN.",
      });
      return this.status;
    }

    this.stopping = false;
    this.token = randomBytes(24).toString("hex");
    this.port = await freePort();
    this.setStatus({ state: "starting", binary, port: this.port, error: null });

    this.child = spawn(
      binary,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(this.port),
        "--api-key",
        this.token,
      ],
      {
        cwd: this.status.workingDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const relay = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) this.emit("log", { stream, line });
      }
    };
    this.child.stdout?.on("data", relay("stdout"));
    this.child.stderr?.on("data", relay("stderr"));

    this.child.on("exit", (code, signal) => {
      this.child = null;
      this.events?.abort();
      this.events = null;
      if (this.stopping) {
        this.setStatus({ state: "stopped", port: null, llama: null });
        return;
      }
      this.setStatus({
        state: "error",
        port: null,
        llama: null,
        error: `The agent exited (code ${code ?? "null"}, signal ${signal ?? "none"}).`,
      });
    });

    const ok = await this.waitForHealth();
    if (!ok) {
      this.setStatus({
        state: "error",
        error: `The agent did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`,
      });
      return this.status;
    }

    this.openApprovalStream();
    return this.status;
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) return false;
      try {
        const res = await fetch(`${this.base()}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const body = (await res.json()) as {
            workingDir?: string;
            llama?: { url: string; reachable: boolean };
          };
          this.setStatus({
            state: "connected",
            error: null,
            llama: body.llama ?? null,
            workingDir: body.workingDir ?? this.status.workingDir,
          });
          return true;
        }
      } catch {
        /* not up yet */
      }
      await sleep(HEALTH_POLL_MS);
    }
    return false;
  }

  /** SSE stream of approval requests, reconnected while the child lives. */
  private openApprovalStream(): void {
    this.events?.abort();
    const controller = new AbortController();
    this.events = controller;

    void (async () => {
      while (!controller.signal.aborted && this.child) {
        try {
          const res = await fetch(`${this.base()}/api/events`, {
            headers: { authorization: `Bearer ${this.token}` },
            signal: controller.signal,
          });
          if (!res.body) throw new Error("no body");
          for await (const frame of sseFrames(res.body, controller.signal)) {
            if (frame.data === "[DONE]") continue;
            try {
              this.emit("approval", JSON.parse(frame.data));
            } catch {
              /* ignore malformed frame */
            }
          }
        } catch {
          if (controller.signal.aborted) return;
          await sleep(1000);
        }
      }
    })();
  }

  private async json<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  capabilities = () => this.json<unknown>("/api/capabilities");
  config = () => this.json<unknown>("/api/config");
  skills = () => this.json<unknown>("/api/skills");
  tasks = () => this.json<unknown>("/api/tasks");
  sessions = () => this.json<unknown>("/api/sessions");
  models = () => this.json<unknown>("/v1/models");
  session = (id: string) => this.json<unknown>(`/api/sessions/${encodeURIComponent(id)}`);

  /**
   * Plan mode. The runtime keeps it as session state and reads it through
   * a getter on every tool call, so this takes effect at the next step.
   * Older agents have no such route — a 404 is reported as unsupported
   * rather than as an error, so the UI can say why the control is off.
   */
  async planMode(enabled?: boolean): Promise<{ ok: boolean; planMode?: boolean; supported: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.base()}/api/plan-mode`, {
        method: enabled === undefined ? "GET" : "POST",
        headers: this.headers(),
        ...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) return { ok: false, supported: false, error: "this agent has no plan-mode route" };
      if (!res.ok) return { ok: false, supported: true, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { planMode?: boolean };
      return { ok: true, supported: true, planMode: !!body.planMode };
    } catch (err) {
      return { ok: false, supported: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Run one turn. Deltas are emitted as `chat` events rather than
   * returned, so the renderer can paint tokens as they arrive.
   */
  async chat(
    turnId: string,
    messages: Array<{ role: string; content: string }>,
    sessionId?: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.turns.set(turnId, controller);
    try {
      const res = await fetch(`${this.base()}/v1/chat/completions`, {
        method: "POST",
        // Opt into atomic's named SSE frames (session_id, reasoning_progress,
        // tool_progress). Without this header the stream is plain OpenAI
        // chunks and the UI has no tool cards to draw.
        headers: { ...this.headers(), "x-atomic-extensions": "1" },
        // `session_id` continues the session the agent already holds
        // (resolveSession loads it by id), so the turn inherits its
        // history, its compaction state and its memory instead of the
        // client replaying the transcript on every request.
        body: JSON.stringify({
          model: "atomic-agent",
          stream: true,
          messages,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = res.ok ? "no response body" : `HTTP ${res.status}`;
        this.emit("chat", { turnId, kind: "error", error: detail });
        return;
      }
      for await (const frame of sseFrames(res.body, controller.signal)) {
        if (frame.data === "[DONE]") break;
        let chunk: {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          [key: string]: unknown;
        };
        try {
          chunk = JSON.parse(frame.data);
        } catch {
          continue;
        }
        if (frame.event && frame.event !== "message") {
          this.emit("chat", { turnId, kind: frame.event, payload: chunk });
          continue;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          this.emit("chat", { turnId, kind: "delta", text: choice.delta.content });
        }
        if (choice?.finish_reason) {
          this.emit("chat", { turnId, kind: "finish", reason: choice.finish_reason });
        }
      }
      this.emit("chat", { turnId, kind: "done" });
    } catch (err) {
      const aborted = controller.signal.aborted;
      this.emit("chat", {
        turnId,
        kind: aborted ? "aborted" : "error",
        error: aborted ? null : err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.turns.delete(turnId);
    }
  }

  cancel(turnId: string): boolean {
    const controller = this.turns.get(turnId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async resolveApproval(
    approvalId: string,
    decision: "allow-once" | "deny",
    reason?: string,
  ): Promise<unknown> {
    const res = await fetch(`${this.base()}/api/approval/resolve`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ approvalId, decision, ...(reason ? { reason } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.json();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.turns.values()) controller.abort();
    this.turns.clear();
    this.events?.abort();
    this.events = null;
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    // Do not leave an orphan holding the port if SIGTERM is ignored.
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(4000),
    ]);
    if (this.child) this.child.kill("SIGKILL");
    this.child = null;
    this.port = null;
  }
}

/** Minimal SSE frame reader: yields `{event, data}` per blank-line-delimited block. */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
